import type { RelayCluster } from './config';
import { containsSecret } from './redact';

/*
 * HTTP client of the upstream RPC provider (RPC_URL, server only).
 *
 * - Bounded: a timeout per attempt, an overall deadline, and a cap on the response size.
 * - One retry with backoff on transport failures, upstream 429 and 5xx, only for retryable
 *   payloads (sendTransaction is never retried here: the client resends and polls).
 * - Cluster guard: before the first forwarded call, the upstream genesis hash must be the one of
 *   SOLANA_CLUSTER. A mismatch is permanent for the process (every call answers `wrong_cluster`).
 * - The upstream URL never leaves this module: results carry a kind and a status, never the
 *   upstream text of an error, and a body containing a secret fragment is replaced by
 *   `secret_echo`.
 */

/**
 * Genesis hashes (public network constants). Same values as CLUSTER_GENESIS_HASH of @forge/core
 * (checked by a test); kept here so the relay route does not load the whole transaction core.
 */
export const GENESIS_HASH: Record<RelayCluster, string> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export type UpstreamResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http_error'; status: number; retryAfterSeconds: number | null }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'too_large' }
  | { kind: 'invalid_json' }
  | { kind: 'secret_echo' }
  | { kind: 'wrong_cluster' };

export interface Upstream {
  /** Posts a JSON-RPC payload (already serialized) and returns the parsed JSON body. */
  send(payload: string, options: { retryable: boolean }): Promise<UpstreamResult>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface UpstreamOptions {
  url: string;
  cluster: RelayCluster;
  /** Fragments of `url` that must never be forwarded (redact.ts). */
  secretFragments: readonly string[];
  fetch?: FetchLike;
  /** Per attempt. */
  timeoutMs?: number;
  /** All attempts together. */
  deadlineMs?: number;
  maxResponseBytes?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Disables the genesis check (tests only). */
  skipClusterCheck?: boolean;
  onClusterMismatch?: () => void;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_DEADLINE_MS = 20_000;
/** Account reads are small (pools, configs, mints, token accounts); simulations carry logs. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class TooLargeError extends Error {
  constructor() {
    super('response too large');
    this.name = 'TooLargeError';
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLargeError();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function retryAfterOf(res: Response): number | null {
  const n = Number(res.headers.get('retry-after') ?? 'NaN');
  return Number.isFinite(n) && n >= 0 ? Math.min(60, Math.ceil(n)) : null;
}

function isRetryable(result: UpstreamResult): boolean {
  if (result.kind === 'network' || result.kind === 'timeout') return true;
  return result.kind === 'http_error' && (result.status === 429 || result.status >= 500);
}

export function createUpstream(options: UpstreamOptions): Upstream {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  async function attempt(payload: string, budgetMs: number): Promise<UpstreamResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, budgetMs)));
    try {
      let res: Response;
      try {
        res = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: payload,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
      } catch {
        return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: 'http_error', status: res.status, retryAfterSeconds: retryAfterOf(res) };
      }
      let text: string;
      try {
        text = await readCapped(res, maxBytes);
      } catch (error) {
        if (error instanceof TooLargeError) return { kind: 'too_large' };
        return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
      }
      if (containsSecret(text, options.secretFragments)) return { kind: 'secret_echo' };
      try {
        return { kind: 'ok', body: JSON.parse(text) as unknown };
      } catch {
        return { kind: 'invalid_json' };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function post(payload: string, retryable: boolean): Promise<UpstreamResult> {
    const start = now();
    let result = await attempt(payload, deadlineMs);
    if (retryable && isRetryable(result)) {
      const remaining = deadlineMs - (now() - start) - retryDelayMs;
      if (remaining > 500) {
        await sleep(retryDelayMs);
        result = await attempt(payload, remaining);
      }
    }
    return result;
  }

  // Cluster guard, single flight; only a confirmed match is cached.
  let clusterState: 'unknown' | 'ok' | 'mismatch' = options.skipClusterCheck ? 'ok' : 'unknown';
  let clusterCheck: Promise<UpstreamResult | null> | null = null;

  async function checkCluster(): Promise<UpstreamResult | null> {
    const result = await post(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'getGenesisHash' }),
      true,
    );
    if (result.kind !== 'ok') return result;
    const body = result.body as { result?: unknown } | null;
    if (body && typeof body === 'object' && body.result === GENESIS_HASH[options.cluster]) {
      clusterState = 'ok';
      return null;
    }
    if (body && typeof body === 'object' && typeof body.result === 'string') {
      clusterState = 'mismatch';
      options.onClusterMismatch?.();
      return { kind: 'wrong_cluster' };
    }
    return { kind: 'invalid_json' };
  }

  return {
    async send(payload, { retryable }) {
      if (clusterState === 'mismatch') return { kind: 'wrong_cluster' };
      if (clusterState === 'unknown') {
        clusterCheck ??= checkCluster().finally(() => {
          clusterCheck = null;
        });
        const failure = await clusterCheck;
        if (failure) return failure;
      }
      return post(payload, retryable);
    },
  };
}
