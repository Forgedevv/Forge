import { clientIp as defaultClientIp } from '../chat/client-ip';
import type { RelayConfig } from './config';
import {
  errorForAll,
  errorResponse,
  parseBody,
  restrictCalls,
  RPC_ERRORS,
  type CheckedCall,
  type JsonRpcError,
  type JsonRpcResponse,
  type ValidCall,
} from './jsonrpc';
import {
  classCeiling,
  MAX_REQUEST_COST,
  MAX_SENDS_PER_REQUEST,
  REQUEST_OVERHEAD,
  type BucketDraw,
  type CallerClass,
  type RelayRateLimitStore,
} from './limits';
import type { RelayLogger } from './log';
import { METHODS, SLEEPING_SITE_METHODS } from './methods';
import { decideOrigin, type LaunchpadDirectory, type OriginDecision } from './origins';
import { RELAY_TOKEN_HEADER, verifyRelayToken } from './server-token';
import type { Upstream, UpstreamResult } from './upstream';

/*
 * POST /api/rpc — JSON-RPC 2.0 relay to the FORGE RPC provider (docs/SECURITY.md §11).
 *
 * Pipeline: caller tier (Origin / server token / anonymous) -> request overhead charged ->
 * content type -> body size cap -> JSON-RPC parsing (single call or batch of at most 10) ->
 * per-call allowlist and params validation (narrowed to the creator fee claim's methods for the
 * origin of a sleeping site and for anonymous callers) -> weighted rate limits (per IP or per
 * launchpad, then the ceiling of the caller's class) -> upstream (ids rewritten) -> answers mapped
 * back to the caller's ids, in request order.
 *
 * Sleeping sites: their browser origin is served (the claim stays available, decision D29), their
 * server token is not (draft and live only), so nothing else runs while a launchpad sleeps.
 * Anonymous callers (no Origin, no token; off by default in production and on mainnet) get the
 * same narrowed method set as a sleeping site: dropping the Origin header never buys more methods
 * than the narrowest browser caller gets.
 *
 * Invalid calls of a batch get their own error and are not forwarded; the others are. Upstream
 * failures are mapped to fixed JSON-RPC errors: the provider URL, its key and its error texts never
 * reach the caller or the logs.
 */

export const MAX_BODY_BYTES = 32 * 1024;
/** Request headers a browser may send (web3.js adds `solana-client`). */
export const ALLOWED_REQUEST_HEADERS = ['content-type', 'solana-client'];
const PREFLIGHT_MAX_AGE_SECONDS = 600;
/** Upstream error messages are forwarded (simulation logs live in `data`), within bounds. */
const MAX_UPSTREAM_MESSAGE_CHARS = 2_000;

export type CallerTier =
  | { tier: 'browser'; origin: string; originKind: string; ip: string }
  | { tier: 'server'; slug: string }
  | { tier: 'anonymous'; ip: string };

export interface RelayDeps {
  config: Pick<
    RelayConfig,
    'appOrigin' | 'clientsDomain' | 'allowLocalhost' | 'tokenSecret' | 'allowAnonymous' | 'limits'
  >;
  /** Null when Supabase is not configured: client origins and server tokens are then refused. */
  directory: LaunchpadDirectory | null;
  limiter: RelayRateLimitStore;
  upstream: Upstream;
  logger: RelayLogger;
  clientIp?: (request: Request) => string;
  now?: () => number;
}

/** A dry alert-only bucket is logged at most this often. */
const ALERT_INTERVAL_MS = 60_000;
const MAX_ALERT_KEYS = 1_000;

export interface RelayHandler {
  post(request: Request): Promise<Response>;
  options(request: Request): Promise<Response>;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  vary: 'Origin',
};

function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? { 'access-control-allow-origin': origin } : {};
}

function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...corsHeaders(origin), ...extra },
  });
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly rpcError: JsonRpcError,
  ) {
    super('body error');
    this.name = 'BodyError';
  }
}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN');
  const tooLarge = new BodyError(413, {
    ...RPC_ERRORS.invalidRequest,
    data: { reason: `body over ${maxBytes} bytes` },
  });
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new BodyError(400, RPC_ERRORS.invalidRequest);
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge;
    }
    chunks.push(step.value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BodyError(400, RPC_ERRORS.parse);
  }
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const [type] = value.split(';');
  return type?.trim().toLowerCase() === 'application/json';
}

/** Maps one upstream answer (already parsed) to the caller's id. Bounded, typed fields only. */
function mapUpstreamItem(raw: unknown, id: ValidCall['id']): JsonRpcResponse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return errorResponse(id, RPC_ERRORS.upstreamUnavailable);
  }
  const item = raw as { result?: unknown; error?: unknown };
  if (item.error !== undefined && item.error !== null) {
    const e = item.error as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof e.code === 'number' && Number.isInteger(e.code) ? e.code : -32603;
    const message =
      typeof e.message === 'string' ? e.message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS) : 'RPC error';
    const error: JsonRpcError =
      e.data === undefined ? { code, message } : { code, message, data: e.data };
    return errorResponse(id, error);
  }
  if (!('result' in item)) return errorResponse(id, RPC_ERRORS.upstreamUnavailable);
  return { jsonrpc: '2.0', id, result: item.result };
}

function upstreamFailure(result: Exclude<UpstreamResult, { kind: 'ok' }>): {
  status: number;
  error: JsonRpcError;
  retryAfter: number | null;
  reason: string;
} {
  switch (result.kind) {
    case 'timeout':
      return {
        status: 504,
        error: RPC_ERRORS.upstreamTimeout,
        retryAfter: null,
        reason: 'timeout',
      };
    case 'too_large':
      return {
        status: 502,
        error: RPC_ERRORS.responseTooLarge,
        retryAfter: null,
        reason: 'too_large',
      };
    case 'http_error':
      if (result.status === 429) {
        return {
          status: 503,
          error: RPC_ERRORS.upstreamBusy,
          retryAfter: result.retryAfterSeconds ?? 1,
          reason: 'upstream_429',
        };
      }
      return {
        status: 502,
        error: RPC_ERRORS.upstreamUnavailable,
        retryAfter: null,
        reason: `upstream_${result.status}`,
      };
    case 'wrong_cluster':
      return {
        status: 503,
        error: RPC_ERRORS.upstreamUnavailable,
        retryAfter: null,
        reason: 'wrong_cluster',
      };
    case 'secret_echo':
      return {
        status: 502,
        error: RPC_ERRORS.upstreamUnavailable,
        retryAfter: null,
        reason: 'secret_echo',
      };
    case 'invalid_json':
      return {
        status: 502,
        error: RPC_ERRORS.upstreamUnavailable,
        retryAfter: null,
        reason: 'invalid_json',
      };
    case 'network':
      return {
        status: 502,
        error: RPC_ERRORS.upstreamUnavailable,
        retryAfter: null,
        reason: 'network',
      };
  }
}

export function createRelayHandler(deps: RelayDeps): RelayHandler {
  const { config, directory, limiter, upstream, logger } = deps;
  const ipOf = deps.clientIp ?? defaultClientIp;
  const now = deps.now ?? Date.now;
  const limits = config.limits;
  const policy = {
    appOrigin: config.appOrigin,
    clientsDomain: config.clientsDomain,
    allowLocalhost: config.allowLocalhost,
  };

  type TierResult =
    { ok: true; caller: CallerTier; corsOrigin: string | null } | { ok: false; response: Response };

  /** Server tokens are served for draft and live launchpads only (never sleeping ones). */
  async function activeSlug(slug: string): Promise<boolean | null> {
    if (!directory) return null;
    try {
      return (await directory.snapshot()).activeSlugs.has(slug);
    } catch {
      return null;
    }
  }

  async function classify(request: Request): Promise<TierResult> {
    const origin = request.headers.get('origin');
    const token = request.headers.get(RELAY_TOKEN_HEADER);
    const forbidden = (reason: string, fields: Record<string, string> = {}): TierResult => {
      logger.log('warn', 'caller_refused', { reason, ...fields });
      return { ok: false, response: json(errorResponse(null, RPC_ERRORS.forbidden), 403, null) };
    };

    if (origin !== null) {
      if (token !== null) return forbidden('token_with_origin');
      let decision: OriginDecision;
      try {
        decision = await decideOrigin(origin, policy, directory);
      } catch {
        decision = { allowed: false, reason: 'directory_unavailable' };
      }
      if (!decision.allowed) {
        return forbidden(`origin_${decision.reason}`, { origin: origin.slice(0, 100) });
      }
      return {
        ok: true,
        caller: {
          tier: 'browser',
          origin: decision.origin,
          originKind: decision.kind,
          ip: ipOf(request),
        },
        corsOrigin: decision.origin,
      };
    }

    if (token !== null) {
      if (!config.tokenSecret) return forbidden('token_tier_disabled');
      const slug = verifyRelayToken(config.tokenSecret, token.trim());
      if (slug === null) {
        logger.log('warn', 'caller_refused', { reason: 'token_invalid' });
        return {
          ok: false,
          response: json(errorResponse(null, RPC_ERRORS.unauthorized), 401, null),
        };
      }
      const active = await activeSlug(slug);
      if (active !== true) {
        return forbidden(active === null ? 'token_directory_unavailable' : 'token_inactive', {
          slug,
        });
      }
      return { ok: true, caller: { tier: 'server', slug }, corsOrigin: null };
    }

    if (!config.allowAnonymous) return forbidden('anonymous_disabled');
    return { ok: true, caller: { tier: 'anonymous', ip: ipOf(request) }, corsOrigin: null };
  }

  /**
   * Enforced buckets drawn for `units` (all calls) and `sends` (sendTransaction calls). Browser and
   * anonymous callers share the per-IP buckets: an Origin header buys no extra budget. Every class
   * has its own ceiling: no class can spend the budget of another.
   */
  function draws(caller: CallerTier, units: number, sends: number): BucketDraw[] {
    const callerClass = classOf(caller);
    const out: BucketDraw[] = [
      { key: `global:${callerClass}`, cost: units, rule: classCeiling(limits, callerClass) },
    ];
    switch (caller.tier) {
      case 'browser':
      case 'anonymous':
        out.push({ key: `ip:${caller.ip}`, cost: units, rule: limits.ip });
        if (sends > 0) {
          out.push({ key: `send:${caller.ip}`, cost: sends, rule: limits.sendPerCaller });
        }
        break;
      case 'server':
        out.push({ key: `server:${caller.slug}`, cost: units, rule: limits.server });
        if (sends > 0) {
          out.push({ key: `send-server:${caller.slug}`, cost: sends, rule: limits.sendServer });
        }
        break;
    }
    return out;
  }

  /** Alert-only bucket of a caller (never refuses: anyone can claim an origin). */
  function alertDraw(caller: CallerTier, units: number): BucketDraw | null {
    switch (caller.tier) {
      case 'browser':
        return { key: `origin:${caller.origin}`, cost: units, rule: limits.origin };
      case 'anonymous':
        return { key: 'anon', cost: units, rule: limits.anonymousGlobal };
      case 'server':
        return null;
    }
  }

  const lastAlertAt = new Map<string, number>();

  /** Meters the alert-only bucket; logs (at most once a minute per bucket) when it runs dry. */
  async function meter(caller: CallerTier, units: number, fields: Record<string, string>) {
    const draw = alertDraw(caller, units);
    if (draw === null) return;
    const decision = await limiter.take([draw]);
    if (decision.allowed) return;
    const t = now();
    const last = lastAlertAt.get(draw.key);
    if (last !== undefined && t - last < ALERT_INTERVAL_MS) return;
    if (lastAlertAt.size >= MAX_ALERT_KEYS) lastAlertAt.clear();
    lastAlertAt.set(draw.key, t);
    logger.log('warn', 'budget_alert', { ...fields, bucket: bucketName(draw.key) });
  }

  function tierFields(caller: CallerTier): Record<string, string> {
    switch (caller.tier) {
      case 'browser':
        return { tier: caller.tier, origin: caller.origin, originKind: caller.originKind };
      case 'server':
        return { tier: caller.tier, slug: caller.slug };
      case 'anonymous':
        return { tier: caller.tier };
    }
  }

  async function forward(
    valid: ValidCall[],
    batch: boolean,
  ): Promise<
    | { ok: true; byIndex: Map<number, JsonRpcResponse> }
    | { ok: false; failure: ReturnType<typeof upstreamFailure> }
  > {
    // Upstream ids are our own (0..n-1): caller ids may repeat or be null.
    const upstreamCalls = valid.map((c, i) => ({
      jsonrpc: '2.0' as const,
      id: i,
      method: c.method,
      params: c.params,
    }));
    const payload = JSON.stringify(batch ? upstreamCalls : upstreamCalls[0]);
    const retryable = valid.every((c) => METHODS[c.method]?.retryable === true);
    const result = await upstream.send(payload, { retryable });
    if (result.kind !== 'ok') return { ok: false, failure: upstreamFailure(result) };

    const byIndex = new Map<number, JsonRpcResponse>();
    const body = result.body;
    if (!batch) {
      const call = valid[0] as ValidCall;
      byIndex.set(call.index, mapUpstreamItem(body, call.id));
      return { ok: true, byIndex };
    }
    if (!Array.isArray(body)) {
      // The provider answered the whole batch with one object (usually an error).
      for (const call of valid) byIndex.set(call.index, mapUpstreamItem(body, call.id));
      return { ok: true, byIndex };
    }
    const byUpstreamId = new Map<number, unknown>();
    for (const item of body as unknown[]) {
      const upstreamId = (item as { id?: unknown } | null)?.id;
      if (typeof upstreamId === 'number' && !byUpstreamId.has(upstreamId)) {
        byUpstreamId.set(upstreamId, item);
      }
    }
    valid.forEach((call, i) => {
      byIndex.set(call.index, mapUpstreamItem(byUpstreamId.get(i), call.id));
    });
    return { ok: true, byIndex };
  }

  return {
    async options(request) {
      const origin = request.headers.get('origin');
      if (origin === null) {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
      }
      let decision: OriginDecision;
      try {
        decision = await decideOrigin(origin, policy, directory);
      } catch {
        decision = { allowed: false, reason: 'directory_unavailable' };
      }
      const method = request.headers.get('access-control-request-method');
      if (!decision.allowed || (method !== null && method.toUpperCase() !== 'POST')) {
        return new Response(null, { status: 403, headers: { vary: 'Origin' } });
      }
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': decision.origin,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': ALLOWED_REQUEST_HEADERS.join(', '),
          'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
          vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        },
      });
    },

    async post(request) {
      const tier = await classify(request);
      if (!tier.ok) return tier.response;
      const { caller, corsOrigin } = tier;
      const fields = tierFields(caller);

      // Every request costs the overhead, valid or not (garbage floods are limited too).
      const overhead = await limiter.take(draws(caller, REQUEST_OVERHEAD, 0));
      if (!overhead.allowed) {
        logger.log('warn', 'rate_limited', { ...fields, bucket: bucketName(overhead.refusedBy) });
        return json(errorResponse(null, RPC_ERRORS.rateLimited), 429, corsOrigin, {
          'retry-after': String(overhead.retryAfterSeconds),
        });
      }

      if (!isJsonContentType(request.headers.get('content-type'))) {
        return json(
          errorResponse(null, {
            ...RPC_ERRORS.invalidRequest,
            data: { reason: 'content-type must be application/json' },
          }),
          415,
          corsOrigin,
        );
      }

      let text: string;
      try {
        text = await readBody(request, MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyError) {
          return json(errorResponse(null, error.rpcError), error.status, corsOrigin);
        }
        throw error;
      }

      const parsed = parseBody(text);
      if (!parsed.ok) return json(errorResponse(null, parsed.error), parsed.status, corsOrigin);
      const { batch } = parsed;
      // A sleeping site only claims creator fees (D29): it gets the claim's methods, nothing else.
      // Anonymous callers get the same set, so dropping the Origin header widens nothing.
      const calls = restrictedToClaim(caller)
        ? restrictCalls(parsed.calls, SLEEPING_SITE_METHODS)
        : parsed.calls;
      const valid = calls.filter((c): c is ValidCall => c.ok);

      let units = 0;
      let sends = 0;
      for (const call of valid) {
        const spec = METHODS[call.method];
        units += spec ? spec.weight(call.params) : 1;
        if (spec?.isSend) sends += 1;
      }
      units += calls.length - valid.length; // refused calls still cost one unit each
      if (units > MAX_REQUEST_COST || sends > MAX_SENDS_PER_REQUEST) {
        return json(
          errorForAll(calls, batch, {
            ...RPC_ERRORS.invalidRequest,
            data: { reason: 'request too expensive, split it' },
          }),
          400,
          corsOrigin,
        );
      }

      const decision = await limiter.take(draws(caller, units, sends));
      if (decision.allowed) await meter(caller, units, fields);
      if (!decision.allowed) {
        logger.log('warn', 'rate_limited', {
          ...fields,
          bucket: bucketName(decision.refusedBy),
          methods: methodList(calls),
        });
        return json(errorForAll(calls, batch, RPC_ERRORS.rateLimited), 429, corsOrigin, {
          'retry-after': String(decision.retryAfterSeconds),
        });
      }

      const refused = calls.filter((c) => !c.ok);
      if (refused.length > 0) {
        logger.log('info', 'calls_refused', {
          ...fields,
          methods: methodList(refused),
          codes: refused.map((c) => (c.ok ? '' : String(c.error.code))).join(','),
        });
      }

      const responses = new Map<number, JsonRpcResponse>();
      for (const call of calls) {
        if (!call.ok) responses.set(call.index, errorResponse(call.id, call.error));
      }

      if (valid.length > 0) {
        const forwarded = await forward(valid, batch);
        if (!forwarded.ok) {
          const { failure } = forwarded;
          logger.log(
            failure.reason === 'secret_echo' || failure.reason === 'wrong_cluster'
              ? 'error'
              : 'warn',
            'upstream_failed',
            {
              ...fields,
              reason: failure.reason,
              methods: methodList(valid),
            },
          );
          if (!batch || refused.length === 0) {
            return json(
              errorForAll(calls, batch, failure.error),
              failure.status,
              corsOrigin,
              failure.retryAfter !== null ? { 'retry-after': String(failure.retryAfter) } : {},
            );
          }
          for (const call of valid) {
            responses.set(call.index, errorResponse(call.id, failure.error));
          }
        } else {
          for (const [index, response] of forwarded.byIndex) responses.set(index, response);
        }
      }

      const ordered = calls.map(
        (c) => responses.get(c.index) ?? errorResponse(c.id, RPC_ERRORS.internal),
      );
      return json(batch ? ordered : ordered[0], 200, corsOrigin);
    },
  };
}

function methodList(calls: readonly CheckedCall[]): string {
  return [...new Set(calls.map((c) => (c.method ?? '?').slice(0, 40)))].join(',');
}

/** The class whose ceiling a caller draws from (limits.ts). */
export function classOf(caller: CallerTier): CallerClass {
  switch (caller.tier) {
    case 'browser':
      return caller.originKind === 'forge' || caller.originKind === 'local' ? 'forge' : 'sites';
    case 'server':
      return 'server';
    case 'anonymous':
      return 'anonymous';
  }
}

/** Callers limited to the creator fee claim's methods: sleeping sites and anonymous callers. */
export function restrictedToClaim(caller: CallerTier): boolean {
  return (
    caller.tier === 'anonymous' || (caller.tier === 'browser' && caller.originKind === 'sleeping')
  );
}

/**
 * Bucket family for logs (`ip`, `origin`, ...), never the IP itself. A class ceiling keeps its
 * class (`global:sites`), which names no caller.
 */
function bucketName(key: string | undefined): string {
  if (!key) return 'unknown';
  if (key.startsWith('global:')) return key;
  return key.split(':')[0] ?? 'unknown';
}
