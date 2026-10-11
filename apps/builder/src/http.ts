/// <reference types="node" />

/**
 * Small fetch wrapper shared by the GitHub and Vercel clients: JSON in/out, per-request timeout,
 * retries with exponential backoff on network errors, 5xx and 429 (honoring Retry-After and
 * rate-limit reset headers), and typed errors. It never logs and never puts a header or a request
 * body into an error message, so credentials cannot leak through it.
 */

export type ServiceName = 'github' | 'vercel';

export type ServiceErrorKind =
  | 'invalid_input'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'unexpected'
  /** Vercel deployment ended in ERROR or CANCELED. */
  | 'deployment_failed';

export interface ServiceErrorInit {
  status?: number;
  apiCode?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ServiceError extends Error {
  readonly service: ServiceName;
  readonly kind: ServiceErrorKind;
  readonly status: number | undefined;
  /** Machine code returned by the API, when there is one (Vercel `error.code`). */
  readonly apiCode: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    service: ServiceName,
    kind: ServiceErrorKind,
    message: string,
    init: ServiceErrorInit = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = service === 'github' ? 'GithubError' : 'VercelError';
    this.service = service;
    this.kind = kind;
    this.status = init.status;
    this.apiCode = init.apiCode;
    this.retryAfterMs = init.retryAfterMs;
  }
}

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Removes anything that looks like a credential from a server-provided string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export interface RetryEvent {
  service: ServiceName;
  method: string;
  path: string;
  attempt: number;
  delayMs: number;
  /** HTTP status, or undefined for a network error / timeout. */
  status: number | undefined;
}

export interface HttpClientOptions {
  service: ServiceName;
  baseUrl: string;
  /** Headers sent on every request (never log them). */
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Returns a number in [0, 1); used for backoff jitter. Default Math.random. */
  random?: () => number;
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms, doubled on each retry. Default 500. */
  retryBaseMs?: number;
  /** Longest wait we accept between two attempts; a larger server-requested wait becomes an error. */
  maxRetryWaitMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  onRetry?: (event: RetryEvent) => void;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute path starting with `/`, already URL-encoded. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Called before each attempt; returns the full `Authorization` header value. */
  authorization?: () => Promise<string>;
  /** Extra headers for this call only. */
  headers?: Record<string, string>;
  /**
   * Whether the call may be replayed after a network error or a 5xx. GET and DELETE always may;
   * for POST/PUT/PATCH set it only when replaying is harmless (content-addressed or re-checked).
   * 429 is always retried: the request was not processed.
   */
  idempotent?: boolean;
  /** Non-2xx statuses returned to the caller instead of thrown (for example 404 or 409). */
  allowStatus?: readonly number[];
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined when the body is empty. */
  json: unknown;
}

export interface HttpClient {
  request(opts: RequestOptions): Promise<HttpResponse>;
}

function kindForStatus(status: number): ServiceErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status === 422 || status === 400) return 'validation';
  return 'unexpected';
}

/** Extracts a short human message and an optional machine code from an error body. */
export function readApiError(json: unknown): { message: string; code: string | undefined } {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const err = o['error'];
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      return {
        message: typeof e['message'] === 'string' ? e['message'] : '',
        code: typeof e['code'] === 'string' ? e['code'] : undefined,
      };
    }
    return {
      message: typeof o['message'] === 'string' ? o['message'] : '',
      code: typeof o['code'] === 'string' ? o['code'] : undefined,
    };
  }
  return { message: '', code: undefined };
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  // GitHub answers 403 for primary and secondary rate limits.
  if (status === 403) {
    return headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0';
  }
  return false;
}

function rateLimitWaitMs(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = parseRetryAfter(headers.get('retry-after'), nowMs);
  if (retryAfter !== undefined) return retryAfter;
  const reset = headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) {
    // GitHub and Vercel both send epoch seconds.
    return Math.max(0, Number(reset) * 1000 - nowMs) + 1000;
  }
  return undefined;
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const { service } = opts;

  function backoff(attempt: number): number {
    const base = retryBaseMs * 2 ** (attempt - 1);
    return Math.round(base + base * 0.25 * random());
  }

  async function request(req: RequestOptions): Promise<HttpResponse> {
    if (!req.path.startsWith('/')) {
      throw new ServiceError(service, 'invalid_input', 'request path must start with "/"');
    }
    const replayable = req.method === 'GET' || req.method === 'DELETE' || req.idempotent === true;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${baseUrl}${req.path}${qs ? `?${qs}` : ''}`;
    const rawBody = req.body === undefined ? undefined : JSON.stringify(req.body);

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      const headers: Record<string, string> = { ...opts.defaultHeaders, ...req.headers };
      if (rawBody !== undefined) headers['content-type'] = 'application/json';
      if (req.authorization) headers['authorization'] = await req.authorization();

      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers,
          ...(rawBody !== undefined ? { body: rawBody } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const kind: ServiceErrorKind = timedOut ? 'timeout' : 'network';
        const message = `${service} ${req.method} ${req.path}: ${timedOut ? 'request timed out' : 'network error'}`;
        if (!replayable || last) throw new ServiceError(service, kind, message, { cause: err });
        const delayMs = backoff(attempt);
        opts.onRetry?.({
          service,
          method: req.method,
          path: req.path,
          attempt,
          delayMs,
          status: undefined,
        });
        await sleep(delayMs);
        continue;
      }

      const text = await res.text().catch(() => '');
      let json: unknown;
      let jsonOk = true;
      if (text.trim() !== '') {
        try {
          json = JSON.parse(text);
        } catch {
          jsonOk = false;
        }
      }

      if (res.ok) {
        if (!jsonOk) {
          throw new ServiceError(
            service,
            'invalid_response',
            `${service} ${req.method} ${req.path}: response is not valid JSON`,
            { status: res.status },
          );
        }
        return { status: res.status, headers: res.headers, json };
      }

      const limited = isRateLimited(res.status, res.headers);
      const retryable = limited || (res.status >= 500 && replayable);
      if (retryable && !last) {
        const serverWait = limited ? rateLimitWaitMs(res.headers, now()) : undefined;
        if (serverWait !== undefined && serverWait > maxRetryWaitMs) {
          throw buildError(req, res.status, json, serverWait);
        }
        const delayMs = serverWait ?? backoff(attempt);
        opts.onRetry?.({
          service,
          method: req.method,
          path: req.path,
          attempt,
          delayMs,
          status: res.status,
        });
        await sleep(delayMs);
        continue;
      }

      if (req.allowStatus?.includes(res.status)) {
        return { status: res.status, headers: res.headers, json };
      }
      throw buildError(
        req,
        res.status,
        json,
        limited ? rateLimitWaitMs(res.headers, now()) : undefined,
        limited,
      );
    }
  }

  function buildError(
    req: RequestOptions,
    status: number,
    json: unknown,
    retryAfterMs?: number,
    limited = false,
  ): ServiceError {
    const api = readApiError(json);
    const detail = api.message ? `: ${redactSecrets(api.message).slice(0, 200)}` : '';
    const kind = limited ? 'rate_limited' : kindForStatus(status);
    return new ServiceError(
      service,
      kind,
      `${service} ${req.method} ${req.path} failed with ${status}${detail}`,
      {
        status,
        ...(api.code !== undefined ? { apiCode: api.code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  return { request };
}
