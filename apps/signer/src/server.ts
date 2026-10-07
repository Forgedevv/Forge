import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pino, type Logger } from 'pino';
import type { z } from 'zod';
import {
  SIGNER_MAX_CLOCK_SKEW_SECONDS,
  SIGNER_ROUTES,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
  SignerConfigsRequest,
  SignerConfigsResponse,
  SignerHealthResponse,
  SignerLaunchPrepareRequest,
  SignerLaunchPrepareResponse,
} from '@forge/shared';
import { DEFAULT_MAX_BODY_BYTES, readRawBody } from './http/body.js';
import { assertHmacSecret, checkTimestamp, verifySignature } from './http/hmac.js';
import { createIpFilter, parseAllowedIps } from './http/ip.js';
import { ReplayCache } from './http/replay.js';

export { signRequest, MIN_HMAC_SECRET_BYTES } from './http/hmac.js';
export { parseAllowedIps } from './http/ip.js';

/*
 * Private builder -> signer API (docs/INTERFACES.md §7, docs/SECURITY.md §6).
 *
 * Every request goes through these checks, in this order; the first failure ends the request
 * with a generic answer (no detail on which check failed):
 *   1. client IP in the allowlist (TCP peer address, proxy headers ignored)       -> 403
 *   2. raw body read as bytes, at most `maxBodyBytes`                             -> 413
 *   3. X-Forge-Timestamp: integer seconds, |now - ts| <= 60 s                      -> 401
 *   4. X-Forge-Signature: hex HMAC-SHA256(secret, "<ts>.<raw body>"), constant time -> 401
 *   5. signature never seen within the window (replay cache)                      -> 401
 *   6. known route (exact method + path)                                          -> 404
 *   7. body: UTF-8, JSON, strict zod schema (GET: empty body)                      -> 400
 * Only then is the injected handler called. Handler responses are re-validated with the shared
 * response schema (unknown keys stripped) before being sent.
 *
 * Logs never contain the secret, the signature header or any request body.
 */

/** A handler result: either the success body, or an error status with a short error code. */
export type SignerRouteResult<T> =
  { ok: true; body: T } | { ok: false; status: number; error: string };

export interface SignerRouteHandlers {
  configs(input: SignerConfigsRequest): Promise<SignerRouteResult<SignerConfigsResponse>>;
  launchCoinPrepare(
    input: SignerLaunchPrepareRequest,
  ): Promise<SignerRouteResult<SignerLaunchPrepareResponse>>;
  health(): Promise<SignerRouteResult<SignerHealthResponse>>;
}

/** Wave 1 handlers: the two signing routes are not implemented yet. */
export const stubSignerRoutes: SignerRouteHandlers = {
  configs: async () => ({ ok: false, status: 501, error: 'not_implemented' }),
  launchCoinPrepare: async () => ({ ok: false, status: 501, error: 'not_implemented' }),
  health: async () => ({ ok: true, body: { ok: true } }),
};

export interface SignerServerOptions {
  /** SIGNER_HMAC_SECRET, at least 32 bytes. */
  hmacSecret: string | Buffer;
  routes: SignerRouteHandlers;
  /** Clock in milliseconds (default `Date.now`). */
  now?: () => number;
  /** Exact client IPs allowed (SIGNER_ALLOWED_IPS). Empty: deny all in production, loopback only otherwise. */
  allowedIps?: readonly string[];
  /** Default: true unless NODE_ENV is `development` or `test` (fail closed). */
  production?: boolean;
  /** Default 16 KB. */
  maxBodyBytes?: number;
  /** Maximum number of live signatures remembered (default 10 000). Full cache: requests refused. */
  maxReplayEntries?: number;
  logger?: Logger;
}

export const DEFAULT_MAX_REPLAY_ENTRIES = 10_000;
export const DEFAULT_SIGNER_PORT = 8787;

/** Paths redacted from every log line, as a second line of defence. */
const REDACT_PATHS = [
  'secret',
  'hmacSecret',
  'signature',
  'body',
  'rawBody',
  'headers',
  'req.headers',
  'req.body',
  `req.headers["${SIGNER_SIGNATURE_HEADER.toLowerCase()}"]`,
];

export function createSignerLogger(): Logger {
  return pino({
    name: 'signer-http',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

interface RouteEntry {
  method: 'GET' | 'POST';
  path: string;
  run(raw: Buffer): Promise<{ status: number; body: unknown } | 'bad_request'>;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseJsonBody<S extends z.ZodType>(schema: S, raw: Buffer): z.infer<S> | undefined {
  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function toResponse<T>(
  result: SignerRouteResult<T>,
  responseSchema: z.ZodType<T>,
): { status: number; body: unknown } {
  if (result.ok) {
    const parsed = responseSchema.safeParse(result.body);
    if (!parsed.success) return { status: 500, body: { error: 'internal_error' } };
    return { status: 200, body: parsed.data };
  }
  const status =
    Number.isInteger(result.status) && result.status >= 400 && result.status <= 599
      ? result.status
      : 500;
  const error = /^[a-z0-9_]{1,64}$/.test(result.error) ? result.error : 'error';
  return { status, body: { error } };
}

function buildRoutes(handlers: SignerRouteHandlers): RouteEntry[] {
  return [
    {
      ...SIGNER_ROUTES.configs,
      run: async (raw) => {
        const input = parseJsonBody(SignerConfigsRequest, raw);
        if (input === undefined) return 'bad_request';
        return toResponse(await handlers.configs(input), SignerConfigsResponse);
      },
    },
    {
      ...SIGNER_ROUTES.launchCoinPrepare,
      run: async (raw) => {
        const input = parseJsonBody(SignerLaunchPrepareRequest, raw);
        if (input === undefined) return 'bad_request';
        return toResponse(await handlers.launchCoinPrepare(input), SignerLaunchPrepareResponse);
      },
    },
    {
      ...SIGNER_ROUTES.health,
      run: async (raw) => {
        if (raw.length !== 0) return 'bad_request';
        return toResponse(await handlers.health(), SignerHealthResponse);
      },
    },
  ];
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(payload);
}

/** Creates the signer HTTP server (not listening). Throws if the secret is too short. */
export function createSignerServer(options: SignerServerOptions): Server {
  const secret = assertHmacSecret(options.hmacSecret);
  const now = options.now ?? Date.now;
  const production = options.production ?? isProductionEnv(process.env.NODE_ENV);
  const ipAllowed = createIpFilter({ allowedIps: options.allowedIps ?? [], production });
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const replay = new ReplayCache(
    SIGNER_MAX_CLOCK_SKEW_SECONDS,
    options.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES,
  );
  const log = options.logger ?? createSignerLogger();
  const routes = buildRoutes(options.routes);

  const reject = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    reason: string,
    close = false,
  ) => {
    // Only the reason code, the method, a truncated path and the peer IP are logged.
    log.warn(
      {
        reason,
        status,
        method: req.method,
        path: (req.url ?? '').slice(0, 64),
        ip: req.socket.remoteAddress,
      },
      'signer request rejected',
    );
    const error =
      status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 413
              ? 'payload_too_large'
              : status === 400
                ? 'bad_request'
                : 'unavailable';
    send(res, status, { error }, close);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. IP allowlist, before reading anything.
    if (!ipAllowed(req.socket.remoteAddress)) {
      reject(req, res, 403, 'ip_not_allowed', true);
      return;
    }

    // 2. Raw body, bounded.
    const body = await readRawBody(req, maxBodyBytes);
    if (!body.ok) {
      if (body.reason === 'too_large') reject(req, res, 413, 'body_too_large', true);
      else req.socket.destroy();
      return;
    }

    // 3. Timestamp.
    const timestamp = singleHeader(req, SIGNER_TIMESTAMP_HEADER);
    const nowMs = now();
    const ts = checkTimestamp(timestamp, nowMs);
    if (!ts.ok || timestamp === undefined) {
      reject(req, res, 401, 'bad_timestamp');
      return;
    }

    // 4. Signature (constant time).
    const signature = singleHeader(req, SIGNER_SIGNATURE_HEADER);
    if (signature === undefined || !verifySignature(secret, timestamp, body.raw, signature)) {
      reject(req, res, 401, 'bad_signature');
      return;
    }

    // 5. Replay. Recorded before routing so that a valid signature is usable exactly once,
    //    whatever the route or the outcome.
    const seen = replay.checkAndRemember(signature, ts.seconds, Math.floor(nowMs / 1000));
    if (seen === 'replay') {
      reject(req, res, 401, 'replay');
      return;
    }
    if (seen === 'full') {
      reject(req, res, 503, 'replay_cache_full');
      return;
    }

    // 6. Route.
    const route = routes.find((r) => r.method === req.method && r.path === req.url);
    if (route === undefined) {
      reject(req, res, 404, 'unknown_route');
      return;
    }

    // 7. Body validation, then the handler.
    let result: { status: number; body: unknown } | 'bad_request';
    try {
      result = await route.run(body.raw);
    } catch (err) {
      log.error(
        {
          reason: 'handler_error',
          path: route.path,
          errName: err instanceof Error ? err.name : 'unknown',
        },
        'signer handler failed',
      );
      send(res, 500, { error: 'internal_error' });
      return;
    }
    if (result === 'bad_request') {
      reject(req, res, 400, 'invalid_body');
      return;
    }
    log.info({ path: route.path, status: result.status }, 'signer request handled');
    send(res, result.status, result.body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      log.error({ reason: 'unexpected_error' }, 'signer request failed');
      send(res, 500, { error: 'internal_error' });
    });
  });
  // Bound slow clients: headers within 5 s, the whole request within 10 s.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}

export interface SignerServerEnv {
  hmacSecret: string;
  allowedIps: string[];
  port: number;
  production: boolean;
}

/**
 * Reads the server settings from the environment: SIGNER_HMAC_SECRET (required, >= 32 bytes),
 * SIGNER_ALLOWED_IPS (comma separated), SIGNER_PORT (default 8787), NODE_ENV.
 */
export function loadSignerServerEnv(env: NodeJS.ProcessEnv = process.env): SignerServerEnv {
  const hmacSecret = env.SIGNER_HMAC_SECRET;
  assertHmacSecret(hmacSecret);
  const portText = env.SIGNER_PORT;
  let port = DEFAULT_SIGNER_PORT;
  if (portText !== undefined && portText !== '') {
    port = Number(portText);
    if (!/^[0-9]{1,5}$/.test(portText) || port < 1 || port > 65535) {
      throw new Error('SIGNER_PORT must be an integer between 1 and 65535');
    }
  }
  return {
    hmacSecret: hmacSecret as string,
    allowedIps: parseAllowedIps(env.SIGNER_ALLOWED_IPS),
    port,
    production: isProductionEnv(env.NODE_ENV),
  };
}
