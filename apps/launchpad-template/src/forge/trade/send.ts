import bs58 from 'bs58';
import { Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { BuiltTransaction } from './core-adapter';
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from './constants';
import { mapChainError, mapTradeError, TradeError } from './errors';

/**
 * LOCKED ZONE. Sends one signed swap without ever creating a second, different transaction while
 * the first one may still land.
 *
 * - The signature is derived from the signed bytes (`signatures[0]`, the fee payer) BEFORE sending,
 *   so it is known even when the send call fails.
 * - On an ambiguous send error (network, relay timeout, 5xx), the signature is polled with
 *   `getSignatureStatuses` until a deadline and the SAME bytes are re-sent while the blockhash is
 *   still valid. It never rebuilds or re-signs.
 * - A trade whose outcome is unknown stays pending (per wallet). A new trade is refused until the
 *   pending one has landed, failed, or its blockhash expired.
 */

/** A blockhash is valid for 150 blocks; the margin covers commitment differences between reads. */
export const MAX_BLOCKHASH_AGE = 150;
export const EXPIRY_MARGIN_BLOCKS = 10;

export type SendConnection = Pick<
  Connection,
  'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'
>;

export interface PendingTrade {
  signature: string;
  /** Block height after which the transaction can no longer land. */
  expiryHeight: number;
}

export interface SettleOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SendOutcome =
  /** The network has the transaction: confirm it next. */
  | { kind: 'sent' }
  /** It did not and cannot execute (preflight rejection, failed on-chain, blockhash expired). */
  | { kind: 'rejected'; error: TradeError }
  /** It may still land: the trade stays pending and no new trade may be built. */
  | { kind: 'unknown'; error: TradeError };

const SEND_OPTIONS = { skipPreflight: false, maxRetries: 3 } as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Base58 fee-payer signature of a signed transaction. Throws when the wallet did not sign. */
export function firstSignature(tx: BuiltTransaction): string {
  const raw = tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signatures[0]?.signature;
  if (!raw || raw.length !== 64 || raw.every((byte) => byte === 0)) {
    throw new TradeError('unknown', 'The wallet did not sign the transaction. Nothing was sent.');
  }
  return bs58.encode(raw);
}

/**
 * Last block height at which the transaction can land: the legacy `lastValidBlockHeight` when the
 * builder set it, else a safe upper bound (the blockhash was fetched before this read).
 */
export async function expiryHeightOf(
  tx: BuiltTransaction,
  connection: Pick<Connection, 'getBlockHeight'>,
): Promise<number> {
  if (tx instanceof Transaction && typeof tx.lastValidBlockHeight === 'number') {
    return tx.lastValidBlockHeight;
  }
  const height = await connection.getBlockHeight('confirmed');
  return height + MAX_BLOCKHASH_AGE + EXPIRY_MARGIN_BLOCKS;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function isAlreadyProcessed(error: unknown): boolean {
  return messageOf(error).includes('already been processed');
}

/** The node refused the transaction before forwarding it: it cannot land. */
function isDefinitiveRejection(error: unknown): boolean {
  const message = messageOf(error);
  return (
    message.includes('transaction simulation failed') ||
    message.includes('signature verification failure') ||
    message.includes('blockhash not found')
  );
}

/** Sends the signed bytes once, then settles an ambiguous failure (see the module comment). */
export async function sendSigned(
  connection: SendConnection,
  bytes: Uint8Array,
  pending: PendingTrade,
  options: SettleOptions = {},
): Promise<SendOutcome> {
  try {
    await connection.sendRawTransaction(bytes, SEND_OPTIONS);
    return { kind: 'sent' };
  } catch (error) {
    if (isAlreadyProcessed(error)) return { kind: 'sent' };
    if (isDefinitiveRejection(error)) return { kind: 'rejected', error: mapTradeError(error) };
    return settle(connection, bytes, pending, options, error);
  }
}

type Lookup = 'landed' | 'failed' | 'expired' | 'pending';

/**
 * Where a sent transaction stands. The height is read BEFORE the status, so "no status" after the
 * expiry height is final (a transaction that landed in time would show up).
 */
export async function lookupPending(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>,
  pending: PendingTrade,
): Promise<{ state: Lookup; error?: TradeError }> {
  const height = await connection.getBlockHeight('confirmed');
  const { value } = await connection.getSignatureStatuses([pending.signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (status) {
    if (status.err)
      return { state: 'failed', error: mapChainError(status.err, null, pending.signature) };
    return { state: 'landed' };
  }
  return { state: height > pending.expiryHeight ? 'expired' : 'pending' };
}

async function settle(
  connection: SendConnection,
  bytes: Uint8Array,
  pending: PendingTrade,
  options: SettleOptions,
  sendError: unknown,
): Promise<SendOutcome> {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? CONFIRM_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let failures = 0;

  for (;;) {
    await sleep(Math.min(intervalMs * 2 ** failures, 10_000));
    try {
      const { state, error } = await lookupPending(connection, pending);
      failures = 0;
      if (state === 'landed') return { kind: 'sent' };
      if (state === 'failed') return { kind: 'rejected', error: error as TradeError };
      if (state === 'expired') {
        return {
          kind: 'rejected',
          error: new TradeError('blockhash_expired', undefined, { cause: sendError }),
        };
      }
      // Still valid and not seen: re-send the same signed bytes (never a rebuilt transaction).
      try {
        await connection.sendRawTransaction(bytes, SEND_OPTIONS);
      } catch (resendError) {
        if (isAlreadyProcessed(resendError)) return { kind: 'sent' };
        // Any other error: keep polling; the outcome is decided by status and block height.
      }
    } catch {
      failures += 1;
    }
    if (now() >= deadline) {
      return {
        kind: 'unknown',
        error: new TradeError('confirm_timeout', undefined, {
          signature: pending.signature,
          cause: sendError,
        }),
      };
    }
  }
}

/** Trades whose outcome is not settled yet, per wallet (survives a remount of the trade form). */
const pendingByWallet = new Map<string, PendingTrade>();

export function getPendingTrade(wallet: string): PendingTrade | undefined {
  return pendingByWallet.get(wallet);
}

export function setPendingTrade(wallet: string, pending: PendingTrade): void {
  pendingByWallet.set(wallet, pending);
}

export function clearPendingTrade(wallet: string): void {
  pendingByWallet.delete(wallet);
}
