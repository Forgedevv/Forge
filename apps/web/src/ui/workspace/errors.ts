import { ClientError } from '@forge/shared';
import {
  ApiError,
  NetworkFailure,
  RequestValidationError,
  defaultMessage,
  isUserRejection,
} from '@/client/errors';
import { errorCopy as copy } from './content/errors';

/**
 * What the screens show for a failure: a stable, human `message`, and the technical `detail`
 * (status, server code, raw message) kept out of the text but offered to support in a collapsed
 * "details" block.
 */
export interface FriendlyError {
  message: string;
  detail: string | null;
}

const MAX_DETAIL = 600;

/** Browser and runtime failures: their message is never meant for a reader. */
const PROGRAM_ERRORS = new Set([
  'TypeError',
  'SyntaxError',
  'ReferenceError',
  'RangeError',
  'EvalError',
  'URIError',
  'AbortError',
]);

/** The fetch failure of each browser (Chrome, Firefox, Safari, Node). */
const OFFLINE = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i;

/** On-chain and wallet internals. */
const TRANSACTION =
  /simulation|instruction|program error|custom program|blockhash|0x[0-9a-f]{2,}|insufficient (funds|lamports)/i;

/** Signs of a technical message: code, schemas, stack frames, status lines. */
const TECHNICAL =
  /unexpected token|\bjson\b|is not a function|cannot read|\bundefined\b|\bnull\b|\bzod\b|invalid request|\bat \S+ \(|\.(?:m?js|tsx?):\d+|\bhttp\/?\s*[1-5]\d\d\b|\bstatus(?: code)?\s*[45]\d\d\b|econn|etimedout|internal server error|bad gateway/i;

function truncate(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** The technical description of a failure, for the support details. */
export function errorDetail(error: unknown): string | null {
  if (error instanceof RequestValidationError) return truncate(`invalid request: ${error.detail}`);
  if (error instanceof ApiError) {
    const code = error.serverCode ? ` ${error.serverCode}` : '';
    return truncate(`HTTP ${error.status}${code}: ${error.message}`);
  }
  if (error instanceof Error) {
    return error.message ? truncate(`${error.name}: ${error.message}`) : error.name || null;
  }
  if (typeof error === 'string' && error) return truncate(error);
  return null;
}

/** A message written for people, or the fallback when it looks technical. */
function readable(message: string | undefined, fallback: string): string {
  const text = message?.trim();
  if (!text || text.length > 240 || TECHNICAL.test(text) || OFFLINE.test(text)) return fallback;
  return TRANSACTION.test(text) ? copy.transaction : text;
}

/** Maps any failure to a stable message and its technical detail. */
export function describeError(error: unknown): FriendlyError {
  const detail = errorDetail(error);
  if (error instanceof RequestValidationError) return { message: copy.invalid, detail };
  if (error instanceof NetworkFailure) return { message: copy.offline, detail };
  if (error instanceof ApiError) {
    // FORGE writes its 5xx messages for people; a proxy page or a bare status gets the fallback.
    if (error.status >= 500) {
      const bare = error.message === defaultMessage(error.code);
      return { message: bare ? copy.server : readable(error.message, copy.server), detail };
    }
    const fallback = error.code === 'NETWORK' ? copy.generic : defaultMessage(error.code);
    return { message: readable(error.message, fallback), detail };
  }
  if (error instanceof ClientError) {
    const fallback = error.code === 'NETWORK' ? copy.unexpected : defaultMessage(error.code);
    return { message: readable(error.message, fallback), detail };
  }
  if (isUserRejection(error)) {
    const message = error instanceof Error ? error.message : undefined;
    return { message: readable(message, copy.rejected), detail };
  }
  if (error instanceof Error) {
    if (OFFLINE.test(error.message)) return { message: copy.offline, detail };
    if (TRANSACTION.test(error.message)) return { message: copy.transaction, detail };
    if (PROGRAM_ERRORS.has(error.name)) return { message: copy.generic, detail };
    const message = readable(error.message, copy.generic);
    // A message written for people needs no details.
    return { message, detail: message === error.message ? null : detail };
  }
  return { message: copy.generic, detail };
}

/** The human message of a failure. */
export function readableError(error: unknown): string {
  return describeError(error).message;
}

/** The raw error a job reports (written by the builder for the team): details only. */
export function jobErrorDetail(error: string | null | undefined): string | null {
  const text = error?.trim();
  return text ? truncate(text) : null;
}
