import { RouteIdParams, type ClientErrorCode, type Session } from '@forge/shared';
import { checkOrigin as defaultCheckOrigin } from '../auth/http';
import { requireSession as defaultRequireSession } from '../auth/session';
import { clientIp } from '../chat/client-ip';
import type { RateLimiter, RateLimitRule } from '../payments/rate-limit';

/*
 * HTTP helpers of the job and launchpad routes (docs/INTERFACES.md §6). Error bodies follow the
 * ClientError shape `{ code, message }` read by apps/web/src/client; `message` is safe to show to
 * the end user and never carries an address from the environment, a URL, an RPC error or a secret.
 * Kept free of Next imports so the handlers are testable with plain Request objects.
 */

export type RouteErrorCode =
  | ClientErrorCode
  | 'BAD_REQUEST'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'INVALID_STATUS'
  | 'LAUNCHPAD_DISABLED'
  | 'LAUNCHPAD_NOT_LIVE'
  | 'MODIFICATION_IN_PROGRESS'
  | 'CONVERSATION_MISMATCH'
  | 'DEPLOYS_PAUSED'
  | 'NOTHING_TO_CLAIM'
  | 'ALREADY_SIGNED'
  | 'OWNER_TX_UNAVAILABLE'
  | 'TRANSACTION_MISMATCH'
  | 'TRANSACTION_INVALID'
  | 'TRANSACTION_REJECTED'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_EXPIRED'
  | 'CONFIRMATION_PENDING'
  | 'RPC_UNAVAILABLE'
  | 'WRONG_CLUSTER'
  | 'SERVER_ERROR';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function apiError(
  status: number,
  code: RouteErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json({ code, message, ...extra }, status, headers);
}

/** An expected failure that maps to exactly one response. */
export class RouteError extends Error {
  readonly httpStatus: number;
  readonly code: RouteErrorCode;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    httpStatus: number,
    code: RouteErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'RouteError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }

  toResponse(): Response {
    return apiError(this.httpStatus, this.code, this.message, this.extra, this.headers);
  }
}

export const NOT_FOUND_MESSAGES = {
  job: 'Job not found.',
  launchpad: 'Launchpad not found.',
} as const;

/**
 * Reads a JSON body of at most `maxBytes` bytes, streaming so that an oversized chunked body is
 * never buffered whole. `undefined` when too large, unreadable or not JSON.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > maxBytes) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Route params `{ id }` (a UUID); a malformed id is answered like an unknown one. */
export async function parseIdParam(
  params: Promise<Record<string, string | string[] | undefined>> | undefined,
  notFoundMessage: string,
): Promise<string> {
  const raw = params ? await params : undefined;
  const parsed = RouteIdParams.safeParse(raw);
  if (!parsed.success) throw new RouteError(404, 'NOT_FOUND', notFoundMessage);
  return parsed.data.id;
}

export interface GuardRules {
  ip: RateLimitRule;
  wallet: RateLimitRule;
}

export interface GuardDeps {
  rateLimiter: RateLimiter;
  requireSession?: (request: Request) => Session | Response;
  checkOrigin?: (request: Request) => Response | null;
}

const RATE_LIMITED_MESSAGE = 'Too many requests. Please wait a moment and try again.';

function limited(rateLimiter: RateLimiter, key: string, rule: RateLimitRule): Response | null {
  const result = rateLimiter.hit(key, rule);
  if (result.ok) return null;
  return apiError(
    429,
    'RATE_LIMITED',
    RATE_LIMITED_MESSAGE,
    {},
    { 'Retry-After': String(result.retryAfterSeconds) },
  );
}

/**
 * Origin check (cross-site requests are refused), per-IP limit, session, per-wallet limit. Returns
 * the session wallet or the response to send as is.
 */
export function guard(
  request: Request,
  route: string,
  rules: GuardRules,
  deps: GuardDeps,
): { wallet: string } | Response {
  const checkOrigin = deps.checkOrigin ?? defaultCheckOrigin;
  const requireSession = deps.requireSession ?? defaultRequireSession;
  const forbidden = checkOrigin(request);
  if (forbidden) return forbidden;
  const ipLimited = limited(deps.rateLimiter, `${route}:ip:${clientIp(request)}`, rules.ip);
  if (ipLimited) return ipLimited;
  const session = requireSession(request);
  if (session instanceof Response) return session;
  const walletLimited = limited(
    deps.rateLimiter,
    `${route}:wallet:${session.wallet}`,
    rules.wallet,
  );
  if (walletLimited) return walletLimited;
  return { wallet: session.wallet };
}
