import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Connection, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { SWAP_MAX_PRIORITY_FEE_LAMPORTS } from '../priority-fee';
import { LAMPORTS_PER_SIGNATURE, TOKEN_ACCOUNT_SIZE } from './constants';

export interface WalletBalances {
  /** SOL balance in lamports. */
  sol: bigint;
  /** Token balance in raw units (0 when the token account does not exist). */
  token: bigint;
  /** Whether the wallet already owns a token account for the coin. */
  hasTokenAccount: boolean;
  /** Rent for a new token account, read from the cluster (never hardcoded). */
  tokenAccountRent: bigint;
}

export type BalancesState =
  | { status: 'idle' | 'loading'; balances: null }
  | { status: 'ready'; balances: WalletBalances }
  | { status: 'unavailable'; balances: null };

/** SPL token account layout: the amount is the u64 at offset 64. */
export function readTokenAmount(data: Uint8Array): bigint {
  if (data.length < 72) return BigInt(0);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * Reads the wallet balances through the relay. Failures are non-fatal: the panel then skips the
 * balance check (the pre-sign simulation still catches an under-funded trade).
 */
export function useWalletBalances(
  connection: Connection | null,
  owner: PublicKey | null,
  mint: PublicKey | null,
  refreshKey: number,
): { state: BalancesState; reload: () => void } {
  const [state, setState] = useState<BalancesState>({ status: 'idle', balances: null });
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (!connection || !owner || !mint) {
      setState({ status: 'idle', balances: null });
      return;
    }
    let cancelled = false;
    setState((previous) =>
      previous.status === 'ready' ? previous : { status: 'loading', balances: null },
    );

    (async () => {
      const ata = getAssociatedTokenAddressSync(mint, owner, true);
      const [sol, account, rent] = await Promise.all([
        connection.getBalance(owner, 'confirmed'),
        connection.getAccountInfo(ata, 'confirmed'),
        connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
      ]);
      return {
        sol: BigInt(sol),
        token: account ? readTokenAmount(account.data) : BigInt(0),
        hasTokenAccount: account !== null,
        tokenAccountRent: BigInt(rent),
      } satisfies WalletBalances;
    })().then(
      (balances) => {
        if (!cancelled) setState({ status: 'ready', balances });
      },
      () => {
        if (!cancelled) setState({ status: 'unavailable', balances: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, owner, mint, refreshKey, bump]);

  const reload = useCallback(() => setBump((n) => n + 1), []);
  return { state, reload };
}

export interface NetworkFeeEstimate {
  /** Fixed signature fee for the transaction. */
  base: bigint;
  /**
   * The most the trade's priority fee can be (`SWAP_MAX_PRIORITY_FEE_LAMPORTS`): its price is read
   * from the network when the transaction is built, and never goes above this.
   */
  maxPriorityFee: bigint;
  /** One-time, refundable rent for the coin's token account on a first buy; 0 otherwise. */
  accountRent: bigint;
  /** Everything above, i.e. the most the trade costs on top of the amounts and the FORGE fee. */
  total: bigint;
}

/**
 * Pre-sign estimate: one signature, the priority fee at its cap, plus the token account rent when
 * a buy must create it.
 */
export function estimateNetworkFee(
  side: 'buy' | 'sell',
  balances: WalletBalances | null,
): NetworkFeeEstimate {
  const base = LAMPORTS_PER_SIGNATURE;
  const maxPriorityFee = SWAP_MAX_PRIORITY_FEE_LAMPORTS;
  const accountRent =
    side === 'buy' && balances && !balances.hasTokenAccount ? balances.tokenAccountRent : BigInt(0);
  return { base, maxPriorityFee, accountRent, total: base + maxPriorityFee + accountRent };
}
