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
  NETWORK: 'Network error. Please check your connection and try again.',
};

export function defaultMessage(code: ClientErrorCode): string {
  return DEFAULT_MESSAGES[code];
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
export function mapHttpError(status: number, body: unknown): ClientError {
  const message = pickMessage(body);
  let code: ClientErrorCode;
  const bodyCode =
    body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined;
  if (isCode(bodyCode)) code = bodyCode;
  else if (status === 401) code = 'UNAUTHORIZED';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 410) code = 'QUOTE_EXPIRED';
  // A code the client does not know (BAD_REQUEST, FORBIDDEN_ORIGIN, SERVER_ERROR, ...) is
  // reported as NETWORK with the server message; 402/403 mean gating only without a code.
  else if (typeof bodyCode === 'string' && bodyCode.length > 0) code = 'NETWORK';
  else if (status === 402 || status === 403) code = 'GATING_REQUIRED';
  else code = 'NETWORK';
  return new ClientError(code, message ?? defaultMessage(code));
}

export function networkError(cause?: unknown): ClientError {
  const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
  return new ClientError('NETWORK', `${defaultMessage('NETWORK')}${detail}`);
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
