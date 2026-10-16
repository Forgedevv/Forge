import type { Connection } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { mapTradeError, type TradeError } from './errors';
import { findLaunchpadPool, type LaunchpadPool } from './launchpad-pool';

export type LaunchpadPoolState =
  | { status: 'loading' }
  | { status: 'ready'; pool: LaunchpadPool }
  /** The coin has no pool on this launchpad's configs: nothing can be traded here. */
  | { status: 'none' }
  | { status: 'error'; error: TradeError };

/**
 * LOCKED ZONE. Looks up the pool of `mint` on this launchpad (`findLaunchpadPool`) through the
 * relay. An RPC failure is reported as an error (with a retry): the panel never guesses a pool.
 */
export function useLaunchpadPool(
  connection: Connection | null,
  mint: string,
): { state: LaunchpadPoolState; retry: () => void } {
  const [state, setState] = useState<LaunchpadPoolState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    setState({ status: 'loading' });
    findLaunchpadPool(connection, mint).then(
      (pool) => {
        if (!cancelled) setState(pool ? { status: 'ready', pool } : { status: 'none' });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error: mapTradeError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, mint, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
