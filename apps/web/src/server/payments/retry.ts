/*
 * Retry with exponential backoff, for network calls only (RPC, price API). Business outcomes
 * (pending, failed, invalid) are values, not exceptions, so they are never retried here.
 */

export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Delay before the second attempt; doubled for each following one. */
  baseDelayMs: number;
  /** Decides whether an error is worth another attempt. Defaults to always. */
  retryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const attempts = Math.max(1, Math.floor(options.attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = options.retryable ? options.retryable(error) : true;
      if (!retryable || attempt === attempts) break;
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
