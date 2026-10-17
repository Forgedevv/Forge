import { CLIENT_ERROR_CODES, ClientError, type ClientErrorCode } from '@forge/shared';

const CODES: readonly string[] = CLIENT_ERROR_CODES;

function isCode(value: unknown): value is ClientErrorCode {
  return typeof value === 'string' && CODES.includes(value);
}

const DEFAULT_MESSAGES: Record<ClientErrorCode, string> = {
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  UNAUTHORIZED: 'Please connect your wallet and sign in.',
  GATING_REQUIRED: 'You need to hold more $FORGE to use this feature.',
  SIGNUPS_PAUSED: 'New signups are temporarily paused.',
  QUOTE_EXPIRED: 'This quote has expired. Please request a new one.',
  WRONG_WALLET: 'This action must be signed with the wallet that owns the launchpad.',
  BETA_NOT_INVITED: 'FORGE is in private beta. This wallet is not invited yet.',
  NETWORK: 'Network error. Please check your connection and try again.',
};

export function defaultMessage(code: ClientErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

export interface ApiErrorInfo {
  /** HTTP status of the response. */
  status: number;
  /** The `code` of the JSON body as sent by the server (may be outside CLIENT_ERROR_CODES). */
  serverCode: string | null;
  /** Other fields of the JSON body (e.g. `signature`, `status`). */
  details: Record<string, unknown>;
  /** `Retry-After` of the response, in milliseconds. */
  retryAfterMs: number | null;
}

/**
 * A failed HTTP response. Its `code` is a ClientErrorCode (what screens switch on); the raw server
 * code, the body and `Retry-After` are kept for the flows that retry or resume.
 */
export class ApiError extends ClientError implements ApiErrorInfo {
  readonly status: number;
  readonly serverCode: string | null;
  readonly details: Record<string, unknown>;
  readonly retryAfterMs: number | null;

  constructor(code: ClientErrorCode, message: string, info: ApiErrorInfo) {
    super(code, message);
    this.name = 'ApiError';
    this.status = info.status;
    this.serverCode = info.serverCode;
    this.details = info.details;
    this.retryAfterMs = info.retryAfterMs;
  }
}

/** The raw server code of an error (`ALREADY_SIGNED`, `CONFIRMATION_PENDING`, ...), if any. */
export function serverCodeOf(err: unknown): string | null {
  return err instanceof ApiError ? err.serverCode : null;
}

/** A network failure or a timeout: the request may not have reached the server. */
export class NetworkFailure extends ClientError {
  constructor(message: string) {
    super('NETWORK', message);
    this.name = 'NetworkFailure';
  }
}

/**
 * A request body refused by the shared schema before it is sent: a client-side bug or a stale
 * screen, never something the user can fix from the schema message. `detail` keeps that message
 * for support.
 */
export class RequestValidationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('Some details of this request are not valid. Reload the page and try again.');
    this.name = 'RequestValidationError';
    this.detail = detail;
  }
}

/** Worth retrying unchanged: network failure, timeout, 429 or 5xx. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof NetworkFailure) return true;
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return false;
}

/** Parses a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function pickMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['message', 'error']) {
      const v = b[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

/**
 * Maps a failed HTTP response to a ClientError. A `code` in the JSON body wins; otherwise the
 * status decides. Unknown failures are reported as NETWORK with the server message if any.
 */
export function mapHttpError(
  status: number,
  body: unknown,
  retryAfterMs: number | null = null,
): ApiError {
  const message = pickMessage(body);
  let code: ClientErrorCode;
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const bodyCode = record.code;
  if (isCode(bodyCode)) code = bodyCode;
  else if (status === 401) code = 'UNAUTHORIZED';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 410) code = 'QUOTE_EXPIRED';
  // A code the client does not know (BAD_REQUEST, FORBIDDEN_ORIGIN, SERVER_ERROR, ...) is
  // reported as NETWORK with the server message; 402/403 mean gating only without a code.
  else if (typeof bodyCode === 'string' && bodyCode.length > 0) code = 'NETWORK';
  else if (status === 402 || status === 403) code = 'GATING_REQUIRED';
  else code = 'NETWORK';
  const details = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'code' && key !== 'message'),
  );
  return new ApiError(code, message ?? defaultMessage(code), {
    status,
    serverCode: typeof bodyCode === 'string' && bodyCode.length > 0 ? bodyCode : null,
    details,
    retryAfterMs,
  });
}

export function networkError(cause?: unknown): ClientError {
  const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
  return new NetworkFailure(`${defaultMessage('NETWORK')}${detail}`);
}

/** Wallet adapters reject with several shapes when the user cancels. */
export function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown; code?: unknown; error?: unknown };
  if (e.code === 4001) return true;
  const name = typeof e.name === 'string' ? e.name : '';
  const msg = typeof e.message === 'string' ? e.message : '';
  if (/reject|declin|denied|cancel/i.test(`${name} ${msg}`)) return true;
  return e.error ? isUserRejection(e.error) : false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}
