/**
 * LOCKED ZONE. Minimal chain access for the browser: send a signed transaction, read a balance
 * and poll signature statuses, all through the FORGE RPC relay (the browser never talks to the
 * RPC provider directly). No websocket subscription: confirmation is by polling
 * `getSignatureStatuses` with a deadline.
 */

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SignatureStatus {
  confirmationStatus: Commitment | null;
  /** Non-null when the transaction landed and failed. Never swallowed: shown to the user. */
  err: unknown;
}

export interface ChainClient {
  getBalanceLamports(address: string): Promise<bigint>;
  /** Sends a fully signed transaction (base64). Returns the signature. */
  sendRawTransaction(base64: string): Promise<string>;
  /** Null when the cluster does not know the signature (yet). */
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcClientOptions {
  url: string;
  fetch?: FetchLike;
  /** Extra attempts on network errors / 5xx / 429 (not on JSON-RPC errors). Default 2. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRpcChainClient(options: RpcClientOptions): ChainClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  let nextId = 1;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      let res;
      try {
        res = await doFetch(options.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`RPC relay answered ${res.status}`);
        continue;
      }
      const payload = (await res.json()) as {
        result?: T;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (payload.error) {
        throw new RpcError(
          payload.error.message ?? 'RPC error',
          payload.error.code,
          payload.error.data,
        );
      }
      if (!res.ok) throw new Error(`RPC relay answered ${res.status}`);
      return payload.result as T;
    }
    throw lastError instanceof Error ? lastError : new Error('RPC relay unreachable');
  }

  return {
    async getBalanceLamports(address) {
      const result = await call<{ value: number }>('getBalance', [
        address,
        { commitment: 'confirmed' },
      ]);
      return BigInt(result.value);
    },
    async sendRawTransaction(base64) {
      // Retrying a send is safe: the signed transaction (and its signature) is identical.
      return call<string>('sendTransaction', [
        base64,
        { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
      ]);
    },
    async getSignatureStatus(signature) {
      const result = await call<{
        value: ({ confirmationStatus?: Commitment | null; err: unknown } | null)[];
      }>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
      const status = result.value[0];
      if (!status) return null;
      return { confirmationStatus: status.confirmationStatus ?? null, err: status.err ?? null };
    },
  };
}

export type ConfirmOutcome =
  | { kind: 'confirmed'; commitment: Commitment }
  | { kind: 'failed'; err: unknown }
  | { kind: 'expired' }
  | { kind: 'timeout' };

export interface ConfirmOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Minimum commitment to wait for. Default 'confirmed'. */
  commitment?: Exclude<Commitment, 'processed'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: { aborted: boolean };
  /**
   * Blockhash expiry check (current block height beyond lastValidBlockHeight). When it returns true
   * and the status is still unknown, the transaction can never land: outcome `expired`.
   */
  isExpired?: () => Promise<boolean>;
}

const COMMITMENT_RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

/**
 * Polls `getSignatureStatuses` until the transaction reaches the requested commitment, fails
 * on-chain, or the deadline passes. A transient polling error does not abort the wait. A timeout is
 * not a failure: the transaction may still land, so callers must offer "check again" and never
 * rebuild or resend.
 */
export async function confirmSignature(
  chain: Pick<ChainClient, 'getSignatureStatus'>,
  signature: string,
  options: ConfirmOptions = {},
): Promise<ConfirmOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const required = COMMITMENT_RANK[options.commitment ?? 'confirmed'];
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      const status = await chain.getSignatureStatus(signature);
      if (status) {
        if (status.err) return { kind: 'failed', err: status.err };
        if (status.confirmationStatus && COMMITMENT_RANK[status.confirmationStatus] >= required) {
          return { kind: 'confirmed', commitment: status.confirmationStatus };
        }
      }
    } catch {
      // Transient relay error: keep polling until the deadline.
    }
    if (options.isExpired) {
      let expired = false;
      try {
        expired = await options.isExpired();
      } catch {
        // Cannot tell: keep polling until the deadline.
      }
      if (expired) {
        // One last look: it may have landed just before the blockhash expired.
        try {
          const last = await chain.getSignatureStatus(signature);
          if (last?.err) return { kind: 'failed', err: last.err };
          if (last?.confirmationStatus && COMMITMENT_RANK[last.confirmationStatus] >= required) {
            return { kind: 'confirmed', commitment: last.confirmationStatus };
          }
        } catch {
          // Fall through to expired.
        }
        return { kind: 'expired' };
      }
    }
    if (options.signal?.aborted || now() >= deadline) return { kind: 'timeout' };
    await sleep(intervalMs);
  }
}

/** Human-readable form of an on-chain error for the UI. */
export function describeChainError(err: unknown): string {
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return 'Unknown on-chain error';
  }
}
