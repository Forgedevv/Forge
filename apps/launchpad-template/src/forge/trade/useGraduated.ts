import type { Connection, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { isGraduated } from './core-adapter';
import { mapTradeError, type TradeError } from './errors';

export type GraduationState =
  | { status: 'loading' }
  | { status: 'curve' }
  | { status: 'graduated' }
  | { status: 'error'; error: TradeError };

/**
 * Reads whether the pool graduated, through the core. An RPC failure is reported as an error:
 * the panel never guesses a route.
 */
export function useGraduated(
  connection: Connection | null,
  pool: PublicKey | null,
): { state: GraduationState; retry: () => void; markGraduated: () => void } {
  const [state, setState] = useState<GraduationState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!connection || !pool) return;
    let cancelled = false;
    setState({ status: 'loading' });
    isGraduated({ connection, pool }).then(
      (graduated) => {
        if (!cancelled) setState({ status: graduated ? 'graduated' : 'curve' });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error: mapTradeError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, pool, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const markGraduated = useCallback(() => setState({ status: 'graduated' }), []);
  return { state, retry, markGraduated };
}
