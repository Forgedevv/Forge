/// <reference types="node" />
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  SIGNER_NONCE_HEADER,
  SIGNER_ROUTES,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
  SignerConfigsResponse,
  SignerHealthResponse,
  SignerLaunchPrepareResponse,
  signerSignedPayload,
  type SolanaCluster,
} from '@forge/shared';

export interface SignerClientOptions {
  baseUrl: string;
  hmacSecret: string;
  fetch?: typeof fetch;
  /** Returns the current time in milliseconds. */
  now?: () => number;
  timeoutMs: number;
  /** Total attempts for network errors and 5xx. Default 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms (doubles on each retry). Default 200. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a fresh request nonce (32 lowercase hex characters). Default: 16 random bytes. */
  nonce?: () => string;
}

export interface SignerClient {
  createConfigs(jobId: string): Promise<SignerConfigsResponse>;
  prepareLaunchCoin(jobId: string): Promise<SignerLaunchPrepareResponse>;
  health(): Promise<SignerHealthResponse>;
}

export class SignerClientError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SignerClientError';
    this.status = status;
  }
}

const MIN_SECRET_BYTES = 32;

export function createSignerClient(opts: SignerClientOptions): SignerClient {
  if (Buffer.byteLength(opts.hmacSecret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(`signer HMAC secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nonce = opts.nonce ?? (() => randomBytes(16).toString('hex'));
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(
    route: { method: string; path: string },
    body: object | undefined,
    parse: (json: unknown) => T,
  ): Promise<T> {
    // Serialize once: the signed bytes are exactly the sent bytes.
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const bodySha256 = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    // The signed target is the path and query of the URL actually requested (after URL
    // normalization), so it matches the request line the signer reads.
    const url = new URL(`${baseUrl}${route.path}`);
    const target = `${url.pathname}${url.search}`;
    let lastError: Error = new SignerClientError('signer request failed');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(retryBaseMs * 2 ** (attempt - 2));
      // Re-sign per attempt, with a fresh nonce, so the timestamp stays inside the signer
      // clock-skew window and a retry within the same second is not taken for a replay.
      const timestamp = Math.floor(now() / 1000).toString();
      const requestNonce = nonce();
      const signature = createHmac('sha256', opts.hmacSecret)
        .update(
          signerSignedPayload({
            method: route.method,
            path: target,
            timestamp,
            nonce: requestNonce,
            bodySha256,
          }),
          'utf8',
        )
        .digest('hex');
      const headers: Record<string, string> = {
        [SIGNER_TIMESTAMP_HEADER]: timestamp,
        [SIGNER_NONCE_HEADER]: requestNonce,
        [SIGNER_SIGNATURE_HEADER]: signature,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';

      let res: Response;
      try {
        res = await doFetch(url.href, {
          method: route.method,
          headers,
          ...(body !== undefined ? { body: rawBody } : {}),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        lastError = new SignerClientError(
          `signer network error: ${err instanceof Error ? err.name : 'unknown'}`,
        );
        continue;
      }
      if (res.status >= 500) {
        lastError = new SignerClientError(`signer error ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) {
        throw new SignerClientError(`signer rejected request (${res.status})`, res.status);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new SignerClientError('signer returned invalid JSON', res.status);
      }
      try {
        return parse(json);
      } catch {
        throw new SignerClientError('signer returned an invalid response', res.status);
      }
    }
    throw lastError;
  }

  return {
    createConfigs: (jobId) =>
      call(SIGNER_ROUTES.configs, { jobId }, (j) => SignerConfigsResponse.parse(j)),
    prepareLaunchCoin: (jobId) =>
      call(SIGNER_ROUTES.launchCoinPrepare, { jobId }, parseLaunchPrepareResponse),
    health: () => call(SIGNER_ROUTES.health, undefined, parseHealthResponse),
  };
}

/** Fields of the prepare answer the builder relies on: always validated strictly. */
const LaunchPrepareRequired = SignerLaunchPrepareResponse.pick({
  partiallySignedTx: true,
  mint: true,
});

/**
 * `/v1/launch-coin/prepare` answer. The transaction and the mint are required and validated; the
 * optional `summary` and `details` are kept when they match the shared schema and dropped one by
 * one when they do not. Unknown keys are dropped. The on-chain step then requires `details` (the
 * launch accounts stored in `jobs.owner_tx_details`, pipeline/onchain.ts): a launch whose details
 * are missing or reshaped is not stored.
 */
export function parseLaunchPrepareResponse(json: unknown): SignerLaunchPrepareResponse {
  const full = SignerLaunchPrepareResponse.safeParse(json);
  if (full.success) return full.data;
  const required = LaunchPrepareRequired.parse(json);
  const out: SignerLaunchPrepareResponse = { ...required };
  const raw = json as Record<string, unknown>;
  const summary = SignerLaunchPrepareResponse.shape.summary.safeParse(raw.summary);
  if (summary.success && summary.data !== undefined) out.summary = summary.data;
  const details = SignerLaunchPrepareResponse.shape.details.safeParse(raw.details);
  if (details.success && details.data !== undefined) out.details = details.data;
  return out;
}

/** `/v1/health` answer: `ok` is required; the optional fields are kept when well formed. */
export function parseHealthResponse(json: unknown): SignerHealthResponse {
  const full = SignerHealthResponse.safeParse(json);
  if (full.success) return full.data;
  const out: SignerHealthResponse = SignerHealthResponse.pick({ ok: true }).parse(json);
  const raw = json as Record<string, unknown>;
  for (const key of ['cluster', 'uptimeSeconds', 'jobs'] as const) {
    const field = SignerHealthResponse.shape[key].safeParse(raw[key]);
    if (field.success && field.data !== undefined) {
      (out as Record<string, unknown>)[key] = field.data;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Start-up check: the signer runs on the builder's cluster

/** Defaults of the start-up check (`assertSignerCluster`) and of its dedicated client. */
export const SIGNER_STARTUP_CHECK = {
  /** Health requests before an unreachable signer stops the start-up. */
  attempts: 5,
  /** Delay before the second request, doubled after each one (2, 4, 8 then 16 s). */
  baseDelayMs: 2_000,
  /** Per request: the health route answers at once (SIGNER_TIMEOUT_MS is for the configs route). */
  timeoutMs: 10_000,
} as const;

export class SignerClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerClusterError';
  }
}

export interface SignerClusterCheckOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn(obj: object, msg?: string): void };
}

function retryable(err: unknown): boolean {
  return err instanceof SignerClientError && (err.status === undefined || err.status >= 500);
}

/**
 * Start-up check of the builder: the signer's health route (HMAC-signed like every call) must
 * report the builder's cluster. Refused at once, without retry (a configuration error that
 * retrying cannot fix): a signer on another cluster, a signer that does not report its cluster,
 * a request the signer rejects (4xx: HMAC secret, IP allowlist, clock) or an invalid answer. An
 * unreachable signer (network error, timeout, 5xx) is retried with exponential backoff, then
 * refused too: the process exits and its supervisor restarts it, so the builder comes up once
 * the signer does. Error messages carry no secret and no URL.
 */
export async function assertSignerCluster(
  signer: Pick<SignerClient, 'health'>,
  cluster: SolanaCluster,
  opts: SignerClusterCheckOptions = {},
): Promise<SignerHealthResponse> {
  const attempts = opts.attempts ?? SIGNER_STARTUP_CHECK.attempts;
  const baseDelayMs = opts.baseDelayMs ?? SIGNER_STARTUP_CHECK.baseDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = 'no attempt';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(baseDelayMs * 2 ** (attempt - 2));
    let health: SignerHealthResponse;
    try {
      health = await signer.health();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (!retryable(err)) throw new SignerClusterError(`signer health check refused: ${message}`);
      lastError = message;
      opts.logger?.warn({ attempt, attempts, error: message }, 'signer unreachable at startup');
      continue;
    }
    if (health.cluster === undefined) {
      throw new SignerClusterError('the signer health answer does not report its cluster');
    }
    if (health.cluster !== cluster) {
      const reported =
        health.cluster === 'devnet' || health.cluster === 'mainnet-beta'
          ? health.cluster
          : 'an unknown cluster';
      throw new SignerClusterError(
        `the signer runs on ${reported} while the builder runs on ${cluster} (SOLANA_CLUSTER)`,
      );
    }
    return health;
  }
  throw new SignerClusterError(
    `signer unreachable at startup after ${attempts} attempts (${lastError})`,
  );
}
