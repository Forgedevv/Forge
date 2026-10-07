/// <reference types="node" />
import { createHmac } from 'node:crypto';
import {
  SIGNER_ROUTES,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
  SignerConfigsResponse,
  SignerHealthResponse,
  SignerLaunchPrepareResponse,
  signerSignedPayload,
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
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(
    route: { method: string; path: string },
    body: object | undefined,
    parse: (json: unknown) => T,
  ): Promise<T> {
    // Serialize once: the signed bytes are exactly the sent bytes.
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    let lastError: Error = new SignerClientError('signer request failed');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(retryBaseMs * 2 ** (attempt - 2));
      // Re-sign per attempt so the timestamp stays inside the signer clock-skew window.
      const timestamp = Math.floor(now() / 1000).toString();
      const signature = createHmac('sha256', opts.hmacSecret)
        .update(signerSignedPayload(timestamp, rawBody))
        .digest('hex');
      const headers: Record<string, string> = {
        [SIGNER_TIMESTAMP_HEADER]: timestamp,
        [SIGNER_SIGNATURE_HEADER]: signature,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';

      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${route.path}`, {
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
      call(SIGNER_ROUTES.launchCoinPrepare, { jobId }, (j) => SignerLaunchPrepareResponse.parse(j)),
    health: () => call(SIGNER_ROUTES.health, undefined, (j) => SignerHealthResponse.parse(j)),
  };
}
