import type { Connection } from '@solana/web3.js';
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from './constants';
import { mapChainError, mapTradeError, TradeError } from './errors';

export interface ConfirmOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive RPC failures tolerated before giving up (exponential backoff between them). */
  maxConsecutiveFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Confirms a transaction by polling `getSignatureStatuses` until a deadline. No websocket
 * subscription is used (docs/DECISIONS.md, devnet findings; the relay is HTTP only).
 *
 * Resolves on `confirmed` or `finalized`. Rejects with a `TradeError`:
 * - `tx_failed` / mapped code when the transaction landed with an error,
 * - `confirm_timeout` when the deadline passes (the transaction may still land: the signature is
 *   attached so the UI can link the explorer),
 * - a mapped network error after repeated RPC failures.
 */
export async function confirmByPolling(
  connection: Pick<Connection, 'getSignatureStatuses'>,
  signature: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? CONFIRM_POLL_MS;
  const maxFailures = options.maxConsecutiveFailures ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let failures = 0;

  for (;;) {
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      failures = 0;
      const status = value[0];
      if (status) {
        if (status.err) throw mapChainError(status.err, null, signature);
        if (
          status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized'
        ) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof TradeError) throw error;
      failures += 1;
      if (failures >= maxFailures) {
        const mapped = mapTradeError(error);
        throw new TradeError(mapped.code, undefined, { signature, cause: error });
      }
      await sleep(Math.min(intervalMs * 2 ** failures, 10_000));
    }

    if (now() >= deadline) {
      throw new TradeError('confirm_timeout', undefined, { signature });
    }
    await sleep(intervalMs);
  }
}
