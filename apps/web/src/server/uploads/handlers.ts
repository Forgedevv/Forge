import { clientIp as defaultClientIp } from '../chat/client-ip';
import { readServerTokenSecret, RELAY_TOKEN_HEADER, verifyRelayToken } from '../rpc/server-token';
import {
  MAX_COMPLETE_BODY_BYTES,
  MAX_TICKET_BODY_BYTES,
  UPLOAD_PRE_LIMITS,
  UploadHttpError,
  uploadErrorResponse,
} from './contract';
import { getDefaultUploadService } from './config';
import { SlidingWindowLimiter, type WindowRule } from './rate-limit';
import { toUploadHttpError, type UploadCaller, type UploadService } from './service';

/*
 * HTTP side of the upload routes (kept out of the route files so it is testable without Next).
 * Callers are client-site servers, not browsers: no cookie, no CORS. Bodies are small strict
 * JSON documents; the image itself goes straight to storage through the presigned URL.
 *
 * Before any database, storage or RPC work, in this order:
 *  1. a coarse per-client-IP limit (client sites share the Vercel egress IPs, hence coarse);
 *  2. the per-launchpad server token in `X-Forge-Relay-Token` (rpc/server-token.ts, secret
 *     RPC_RELAY_TOKEN_SECRET): missing or invalid is a 401, unset secret a 503 (fail closed);
 *  3. a slug in the route that is not the token's is a 403 (a uuid is checked by the service);
 *  4. per-token limits (tickets, completes), so nobody without a site's token can spend that
 *     site's quotas.
 */

export interface UploadHandlerDeps {
  /** Default: built from the environment on first use. */
  service?: () => UploadService;
  log?: (message: string) => void;
  /** Default: RPC_RELAY_TOKEN_SECRET read from the environment at each request. */
  tokenSecret?: () => Buffer | null | 'invalid';
  /** Default: a process-wide limiter. */
  limiter?: SlidingWindowLimiter;
  clientIp?: (request: Request) => string;
}

const SLUG_PARAM = /^[a-z0-9-]{3,32}$/;
const LIMITER_KEY = Symbol.for('forge.web.uploads.pre-limiter');

function processLimiter(): SlidingWindowLimiter {
  const g = globalThis as unknown as Record<symbol, SlidingWindowLimiter | undefined>;
  let limiter = g[LIMITER_KEY];
  if (!limiter) {
    limiter = new SlidingWindowLimiter();
    g[LIMITER_KEY] = limiter;
  }
  return limiter;
}

const defaultLog = (message: string) => console.error(message);

async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new UploadHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request must be JSON.');
  }
  const tooLarge = () =>
    new UploadHttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) throw new UploadHttpError(400, 'BAD_REQUEST', 'The request body is empty.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new UploadHttpError(400, 'BAD_REQUEST', 'The request is not valid JSON.');
  }
}

function ok(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

export function createUploadHandlers(deps: UploadHandlerDeps = {}) {
  const log = deps.log ?? defaultLog;
  const service = deps.service ?? getDefaultUploadService;
  const tokenSecret = deps.tokenSecret ?? (() => readServerTokenSecret(process.env));
  const limiter = deps.limiter ?? processLimiter();
  const ipOf = deps.clientIp ?? defaultClientIp;

  function take(key: string, rule: WindowRule): void {
    const decision = limiter.take(key, rule);
    if (!decision.allowed) {
      throw new UploadHttpError(
        429,
        'RATE_LIMITED',
        'Too many coin uploads. Try again later.',
        decision.retryAfterSeconds,
      );
    }
  }

  /** Steps 1 to 4 of the header comment; returns the authenticated calling site. */
  function admit(request: Request, launchpadParam: string, perToken: WindowRule, kind: string) {
    take(`ip:${ipOf(request)}`, UPLOAD_PRE_LIMITS.ip);
    const secret = tokenSecret();
    if (secret === null || secret === 'invalid') {
      log('uploads: RPC_RELAY_TOKEN_SECRET is missing or too short, uploads are refused');
      throw new UploadHttpError(503, 'NOT_CONFIGURED', 'Coin uploads are not configured yet.');
    }
    const token = request.headers.get(RELAY_TOKEN_HEADER)?.trim();
    const slug = token ? verifyRelayToken(secret, token) : null;
    if (slug === null) {
      throw new UploadHttpError(
        401,
        'SERVER_TOKEN_REQUIRED',
        'A valid launchpad server token is required.',
      );
    }
    if (SLUG_PARAM.test(launchpadParam) && launchpadParam !== slug) {
      throw new UploadHttpError(
        403,
        'SERVER_TOKEN_MISMATCH',
        'This server token belongs to another launchpad.',
      );
    }
    take(`server-${kind}:${slug}`, perToken);
    const caller: UploadCaller = { serverSlug: slug };
    return caller;
  }

  async function run(work: () => Promise<unknown>): Promise<Response> {
    try {
      return ok(await work());
    } catch (error) {
      return uploadErrorResponse(toUploadHttpError(error, log));
    }
  }

  return {
    /** POST /api/launchpads/{id}/uploads */
    createUpload(request: Request, launchpadParam: string): Promise<Response> {
      return run(async () => {
        const caller = admit(request, launchpadParam, UPLOAD_PRE_LIMITS.serverIssue, 'issue');
        const body = await readJson(request, MAX_TICKET_BODY_BYTES);
        return service().issue(launchpadParam, body, caller);
      });
    },

    /** POST /api/launchpads/{id}/uploads/{uploadId}/complete */
    completeUpload(request: Request, launchpadParam: string, uploadId: string): Promise<Response> {
      return run(async () => {
        const caller = admit(request, launchpadParam, UPLOAD_PRE_LIMITS.serverComplete, 'complete');
        const body = await readJson(request, MAX_COMPLETE_BODY_BYTES);
        return service().complete(launchpadParam, uploadId, body, caller);
      });
    },
  };
}

const defaults = createUploadHandlers();

export const handleCreateUpload = defaults.createUpload;
export const handleCompleteUpload = defaults.completeUpload;
