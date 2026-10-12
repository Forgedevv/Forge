import { useWallet } from '@jup-ag/wallet-adapter';
import {
  Transaction,
  VersionedTransaction,
  type Connection,
  type PublicKey,
} from '@solana/web3.js';
import { useCallback, useRef, useState } from 'react';
import {
  buildBuyTx,
  buildSellTx,
  type BuiltTransaction,
  type SwapQuote,
  type TradeSide,
} from './core-adapter';
import { confirmByPolling, type ConfirmOptions } from './confirm';
import { mapChainError, mapTradeError, TradeError } from './errors';
import {
  clearPendingTrade,
  expiryHeightOf,
  firstSignature,
  getPendingTrade,
  lookupPending,
  sendSigned,
  setPendingTrade,
} from './send';
import { fetchVerifiedQuote } from './useQuote';

export type ExecutionStatus =
  | 'idle'
  | 'quoting'
  | 'building'
  | 'simulating'
  | 'signing'
  | 'sending'
  | 'confirming'
  | 'success'
  | 'error';

export interface ExecutionState {
  status: ExecutionStatus;
  signature: string | null;
  error: TradeError | null;
}

export interface ExecuteParams {
  connection: Connection;
  pool: PublicKey;
  side: TradeSide;
  amountIn: bigint;
  slippageBps: number;
  /** The quote the user saw. Its `minAmountOut` is the floor enforced on-chain. */
  displayedQuote: SwapQuote;
}

export type ExecuteResult =
  { ok: true; signature: string } | { ok: false; error: TradeError; freshQuote?: SwapQuote };

export const BUSY_STATUSES: readonly ExecutionStatus[] = [
  'quoting',
  'building',
  'simulating',
  'signing',
  'sending',
  'confirming',
];

/**
 * Builds, simulates, signs (wallet adapter), sends and confirms (polling) one swap.
 *
 * Flow guarantees:
 * - A fresh quote is fetched and verified right before building; if the expected output fell below
 *   the minimum the user accepted, nothing is built (`price_moved`) and the fresh quote is returned
 *   so the UI shows it.
 * - The transaction enforces the minimum output the user saw, not a recomputed one.
 * - A second call while one is in flight is ignored (no double submit).
 * - The transaction is simulated before the wallet is asked to sign.
 * - The signature is taken from the signed bytes before sending. A send whose outcome is unknown is
 *   settled by polling and re-sending the same bytes (`./send`); until it has landed, failed or
 *   expired, no new transaction is built for this wallet.
 */
export function useTradeExecution(confirmOptions?: ConfirmOptions) {
  const { publicKey, signTransaction } = useWallet();
  const [state, setState] = useState<ExecutionState>({
    status: 'idle',
    signature: null,
    error: null,
  });
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    if (inFlight.current) return;
    setState({ status: 'idle', signature: null, error: null });
  }, []);

  const execute = useCallback(
    async (params: ExecuteParams): Promise<ExecuteResult> => {
      if (inFlight.current) {
        return { ok: false, error: new TradeError('unknown', 'A trade is already in progress.') };
      }
      inFlight.current = true;
      let signature: string | null = null;
      const step = (status: ExecutionStatus) => setState({ status, signature: null, error: null });

      try {
        if (!publicKey || !signTransaction) throw new TradeError('wallet_not_connected');
        const { connection, pool, side, amountIn, slippageBps, displayedQuote } = params;
        const wallet = publicKey.toBase58();

        // A previous trade of this wallet with an unknown outcome blocks any rebuild.
        const previous = getPendingTrade(wallet);
        if (previous) {
          const { state } = await lookupPending(connection, previous);
          if (state === 'pending' || state === 'landed') {
            if (state === 'landed') clearPendingTrade(wallet);
            const code = state === 'landed' ? 'previous_trade_landed' : 'previous_trade_pending';
            const error = new TradeError(code, undefined, { signature: previous.signature });
            setState({ status: 'error', signature: previous.signature, error });
            return { ok: false, error };
          }
          clearPendingTrade(wallet);
        }

        step('quoting');
        const fresh = await fetchVerifiedQuote({ connection, pool, side, amountIn, slippageBps });
        if (fresh.amountOut < displayedQuote.minAmountOut) {
          const error = new TradeError('price_moved');
          setState({ status: 'error', signature: null, error });
          return { ok: false, error, freshQuote: fresh };
        }

        step('building');
        const build = side === 'buy' ? buildBuyTx : buildSellTx;
        const tx = await build({
          connection,
          pool,
          user: publicKey,
          amountIn,
          minAmountOut: displayedQuote.minAmountOut,
        });
        await prepare(tx, connection, publicKey);

        step('simulating');
        await simulate(tx, connection);

        step('signing');
        const signed = await signTransaction(tx);
        const signedSignature = firstSignature(signed);
        const bytes = signed.serialize();
        const pending = {
          signature: signedSignature,
          expiryHeight: await expiryHeightOf(signed, connection),
        };

        setState({ status: 'sending', signature: null, error: null });
        setPendingTrade(wallet, pending);
        const outcome = await sendSigned(connection, bytes, pending, confirmOptions);
        if (outcome.kind === 'rejected') {
          // Settled: it did not and cannot execute (or failed on-chain), a new trade may be built.
          clearPendingTrade(wallet);
          throw outcome.error;
        }
        signature = signedSignature;
        // `unknown`: the trade stays pending, the next attempt checks it before building.
        if (outcome.kind === 'unknown') throw outcome.error;

        setState({ status: 'confirming', signature, error: null });
        await confirmByPolling(connection, signature, confirmOptions);
        clearPendingTrade(wallet);

        setState({ status: 'success', signature, error: null });
        return { ok: true, signature };
      } catch (raw) {
        const mapped = mapTradeError(raw);
        const error =
          signature && !mapped.signature
            ? new TradeError(mapped.code, mapped.message, { signature, cause: raw })
            : mapped;
        setState({ status: 'error', signature: error.signature ?? signature, error });
        return { ok: false, error };
      } finally {
        inFlight.current = false;
      }
    },
    [publicKey, signTransaction, confirmOptions],
  );

  return { ...state, execute, reset, connected: publicKey !== null, publicKey };
}

/** Sets the fee payer and a recent blockhash on a legacy transaction when the core left them out. */
async function prepare(tx: BuiltTransaction, connection: Connection, payer: PublicKey) {
  if (tx instanceof Transaction) {
    if (!tx.feePayer) tx.feePayer = payer;
    if (!tx.feePayer.equals(payer)) {
      // The user must be the payer of their own swap; refuse anything else.
      throw new TradeError('quote_invalid');
    }
    if (!tx.recentBlockhash) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
    }
  }
}

async function simulate(tx: BuiltTransaction, connection: Connection) {
  const result =
    tx instanceof VersionedTransaction
      ? await connection.simulateTransaction(tx, { sigVerify: false })
      : await connection.simulateTransaction(tx);
  if (result.value.err) throw mapChainError(result.value.err, result.value.logs);
}
