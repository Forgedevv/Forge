import {
  CALLER_CLASSES,
  classCeilingRule,
  DEFAULT_GLOBAL_UNITS_PER_MINUTE,
  DEFAULT_LIMITS,
  MAX_REQUEST_COST,
  MAX_SENDS_PER_REQUEST,
  type BucketRule,
  type CallerClass,
  type RelayLimits,
} from './limits';
import { MIN_SERVER_TOKEN_SECRET_BYTES, readServerTokenSecret } from './server-token';

/*
 * Environment of the RPC relay (`POST /api/rpc`). Read lazily at the first request so that a build
 * without secrets succeeds. Error messages name variables, never values: RPC_URL embeds the
 * provider API key and must never appear in a response, an error or a log line.
 *
 * "Strict" below means NODE_ENV=production or SOLANA_CLUSTER=mainnet-beta (either one).
 *
 * Variables:
 * - SOLANA_CLUSTER            devnet (default) or mainnet-beta.
 * - RPC_RELAY_UPSTREAM_URL    upstream provider URL of the relay only (server only, holds a key),
 *                             https, host matching the cluster. REQUIRED when strict: the relay
 *                             then never falls back to RPC_URL (the configuration error is
 *                             answered 503 and logged at the first request), so the public relay
 *                             can never spend the quota of the payment and launch routes, which
 *                             use RPC_URL.
 * - RPC_URL                   upstream provider URL (server only, holds the key), used by the
 *                             relay only outside strict mode, when RPC_RELAY_UPSTREAM_URL is not
 *                             set (local development and tests). Its host must match the
 *                             cluster; the genesis hash is also checked at runtime.
 * - NEXT_PUBLIC_APP_URL       the FORGE site; its origin is always allowed.
 * - CLIENTS_DOMAIN            client sites live at https://<slug>.<CLIENTS_DOMAIN>. Optional: when
 *                             absent, a client site's browser origin is only accepted at the exact
 *                             host recorded for it (`launchpads.site_host`, origins.ts), next to
 *                             the FORGE site, previews awaiting approval and localhost outside
 *                             production.
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *                             launchpad slug and preview lookups (cached snapshot). Optional: when
 *                             absent, client-site origins and server tokens are refused.
 * - RPC_RELAY_TOKEN_SECRET    optional, at least 32 bytes. Enables the server-to-server tier
 *                             (header X-Forge-Relay-Token, see server-token.ts).
 * - RPC_RELAY_ANONYMOUS       `on` or `off`; default `off` when strict, `on` otherwise. Requests
 *                             with neither an Origin header nor a server token (non-browser
 *                             callers) are refused when `off`. When `on` they share the per-IP
 *                             limits of browsers, have their own class ceiling, and get the
 *                             methods of a sleeping site only (the creator fee claim): dropping
 *                             the Origin header never widens what a caller may call. Not a
 *                             security boundary: any client can send an Origin header.
 * - RPC_RELAY_*_PER_MINUTE    optional numeric overrides of the default limits (limits.ts).
 *                             RPC_RELAY_ORIGIN_UNITS_PER_MINUTE and RPC_RELAY_ANONYMOUS_UNITS_PER_MINUTE
 *                             are alert thresholds (logged, never refused).
 *                             RPC_RELAY_GLOBAL_UNITS_PER_MINUTE is the total of the four class
 *                             ceilings (default 60000, split 25% FORGE site, 50% client sites, 15%
 *                             server tokens, 10% anonymous); RPC_RELAY_GLOBAL_FORGE_UNITS_PER_MINUTE,
 *                             RPC_RELAY_GLOBAL_SITES_UNITS_PER_MINUTE,
 *                             RPC_RELAY_GLOBAL_SERVER_UNITS_PER_MINUTE and
 *                             RPC_RELAY_GLOBAL_ANONYMOUS_UNITS_PER_MINUTE override one class.
 *                             RPC_RELAY_ANONYMOUS_IP_UNITS_PER_MINUTE is no longer read: anonymous
 *                             callers share the per-IP limit (RPC_RELAY_IP_UNITS_PER_MINUTE).
 */

export type Env = Readonly<Record<string, string | undefined>>;

export type RelayCluster = 'devnet' | 'mainnet-beta';

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

/** Variable the relay's upstream URL was read from (its name only, never the value). */
export type UpstreamSource = 'RPC_RELAY_UPSTREAM_URL' | 'RPC_URL';

export interface RelayConfig {
  cluster: RelayCluster;
  /** Upstream provider URL. Secret: never log, never return, never put in an error message. */
  upstreamUrl: string;
  upstreamSource: UpstreamSource;
  /**
   * The relay spends the quota of the server routes: it uses RPC_URL, or RPC_RELAY_UPSTREAM_URL
   * holds the very same URL (same provider key).
   */
  upstreamSharesRpcUrl: boolean;
  /** Origin of the FORGE site (NEXT_PUBLIC_APP_URL), e.g. `https://forge.example`. */
  appOrigin: string | null;
  /** Lower-case domain of the client sites, e.g. `forge-sites.app`, or null. */
  clientsDomain: string | null;
  /** Outside production, `http://localhost:*` and `http://127.0.0.1:*` are allowed origins. */
  allowLocalhost: boolean;
  /** Secret of the server-to-server tokens, or null when the tier is disabled. */
  tokenSecret: Buffer | null;
  allowAnonymous: boolean;
  supabase: { url: string; serviceRoleKey: string } | null;
  limits: RelayLimits;
}

export const MIN_TOKEN_SECRET_BYTES = MIN_SERVER_TOKEN_SECRET_BYTES;

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Devnet unless SOLANA_CLUSTER=mainnet-beta is explicitly set (PLANEXECUTE.md rule 4). */
export function readCluster(env: Env): RelayCluster {
  const value = trimmed(env, 'SOLANA_CLUSTER') ?? 'devnet';
  if (value !== 'devnet' && value !== 'mainnet-beta') {
    throw new RelayConfigError('SOLANA_CLUSTER must be devnet or mainnet-beta');
  }
  return value;
}

/**
 * Strict mode: a production deployment (any cluster, our devnet deployment included) or mainnet.
 * The relay then requires its own upstream and refuses anonymous callers unless told otherwise.
 */
export function isStrict(env: Env, cluster: RelayCluster): boolean {
  return env.NODE_ENV === 'production' || cluster === 'mainnet-beta';
}

/**
 * The upstream must match the cluster, judged on the HOST (a query string could contain anything):
 * a devnet host contains "devnet"; a mainnet host contains neither "devnet" nor "testnet". The
 * genesis hash is verified at runtime as well (upstream.ts). Messages name `name`, never the value.
 */
function validateUpstream(
  name: UpstreamSource,
  raw: string,
  cluster: RelayCluster,
  protocols: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayConfigError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new RelayConfigError(
      protocols.length === 1 ? `${name} must be an https URL` : `${name} must be an http(s) URL`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (cluster === 'devnet' && !host.includes('devnet')) {
    throw new RelayConfigError(
      `${name} host does not look like a devnet endpoint (SOLANA_CLUSTER)`,
    );
  }
  if (cluster === 'mainnet-beta' && (host.includes('devnet') || host.includes('testnet'))) {
    throw new RelayConfigError(
      `${name} host looks like a test cluster while SOLANA_CLUSTER is mainnet-beta`,
    );
  }
  return raw;
}

/**
 * Upstream of the relay: RPC_RELAY_UPSTREAM_URL when set (https only), else RPC_URL outside strict
 * mode. A set but invalid RPC_RELAY_UPSTREAM_URL is an error, never a silent fallback to RPC_URL;
 * in strict mode (production or mainnet) a missing one is an error too (fail closed).
 */
export function readUpstream(
  env: Env,
  cluster: RelayCluster,
): { url: string; source: UpstreamSource } {
  const relay = trimmed(env, 'RPC_RELAY_UPSTREAM_URL');
  if (relay) {
    return {
      url: validateUpstream('RPC_RELAY_UPSTREAM_URL', relay, cluster, ['https:']),
      source: 'RPC_RELAY_UPSTREAM_URL',
    };
  }
  if (isStrict(env, cluster)) {
    throw new RelayConfigError(
      'RPC_RELAY_UPSTREAM_URL is required in production and on mainnet-beta ' +
        '(the relay never shares RPC_URL with the payment and launch routes)',
    );
  }
  const raw = trimmed(env, 'RPC_URL');
  if (!raw) throw new RelayConfigError('RPC_URL is not set');
  return { url: validateUpstream('RPC_URL', raw, cluster, ['https:', 'http:']), source: 'RPC_URL' };
}

/** The relay's upstream URL (see readUpstream). */
export function readUpstreamUrl(env: Env, cluster: RelayCluster): string {
  return readUpstream(env, cluster).url;
}

/**
 * The startup log line naming the upstream variable in use (never its value). Sharing RPC_URL in
 * production is a warning: relay traffic then spends the quota of the payment routes. In strict
 * mode the fallback to RPC_URL is refused (readUpstream), so this only happens when
 * RPC_RELAY_UPSTREAM_URL holds the same URL as RPC_URL.
 */
export function upstreamSelectionLog(
  config: Pick<RelayConfig, 'upstreamSource'> & Partial<Pick<RelayConfig, 'upstreamSharesRpcUrl'>>,
  env: Env = process.env,
) {
  const shared = config.upstreamSource === 'RPC_URL' || config.upstreamSharesRpcUrl === true;
  return {
    level: shared && env.NODE_ENV === 'production' ? ('warn' as const) : ('info' as const),
    event: 'upstream_selected',
    fields: { upstream: config.upstreamSource, sharedWithServerRoutes: shared },
  };
}

function readAppOrigin(env: Env): string | null {
  const raw = trimmed(env, 'NEXT_PUBLIC_APP_URL');
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayConfigError('NEXT_PUBLIC_APP_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RelayConfigError('NEXT_PUBLIC_APP_URL must be an http(s) URL');
  }
  return url.origin;
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function readClientsDomain(env: Env): string | null {
  const raw = trimmed(env, 'CLIENTS_DOMAIN');
  if (!raw) return null;
  const domain = raw.toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    throw new RelayConfigError('CLIENTS_DOMAIN must be a bare domain such as forge-sites.app');
  }
  return domain;
}

function readTokenSecret(env: Env): Buffer | null {
  const secret = readServerTokenSecret(env);
  if (secret === 'invalid') {
    throw new RelayConfigError(
      `RPC_RELAY_TOKEN_SECRET must be at least ${MIN_TOKEN_SECRET_BYTES} bytes`,
    );
  }
  return secret;
}

/** Anonymous callers: off by default in strict mode, on otherwise; `on` / `off` to choose. */
export function readAnonymous(env: Env, cluster: RelayCluster): boolean {
  const raw = trimmed(env, 'RPC_RELAY_ANONYMOUS')?.toLowerCase();
  if (raw === undefined) return !isStrict(env, cluster);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new RelayConfigError('RPC_RELAY_ANONYMOUS must be on or off');
}

function readSupabase(env: Env): RelayConfig['supabase'] {
  const url = trimmed(env, 'SUPABASE_URL');
  const serviceRoleKey = trimmed(env, 'SUPABASE_SERVICE_ROLE_KEY');
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RelayConfigError(`${name} must be a positive number`);
  }
  return n;
}

/**
 * Per-minute overrides of the sustained rates. The burst capacity scales with the rate, but never
 * drops below what one request may cost (otherwise that request could never pass).
 */
export function readLimits(env: Env): RelayLimits {
  const d = DEFAULT_LIMITS;
  const override = (name: string, rule: BucketRule, floor: number): BucketRule => {
    const rate = positive(env, name, rule.refillPerSecond * 60) / 60;
    const scale = rate / rule.refillPerSecond;
    return { capacity: Math.max(floor, Math.round(rule.capacity * scale)), refillPerSecond: rate };
  };
  const units = (name: string, rule: BucketRule) => override(name, rule, MAX_REQUEST_COST);
  const sends = (name: string, rule: BucketRule) => override(name, rule, MAX_SENDS_PER_REQUEST);
  // The total is split between the classes; each class may also be set on its own.
  const total = positive(env, 'RPC_RELAY_GLOBAL_UNITS_PER_MINUTE', DEFAULT_GLOBAL_UNITS_PER_MINUTE);
  const ceiling = (callerClass: CallerClass) =>
    units(
      `RPC_RELAY_GLOBAL_${callerClass.toUpperCase()}_UNITS_PER_MINUTE`,
      classCeilingRule(callerClass, total),
    );
  const [globalForge, globalSites, globalServer, globalAnonymous] = CALLER_CLASSES.map(ceiling) as [
    BucketRule,
    BucketRule,
    BucketRule,
    BucketRule,
  ];
  return {
    ip: units('RPC_RELAY_IP_UNITS_PER_MINUTE', d.ip),
    origin: units('RPC_RELAY_ORIGIN_UNITS_PER_MINUTE', d.origin),
    server: units('RPC_RELAY_SERVER_UNITS_PER_MINUTE', d.server),
    anonymousGlobal: units('RPC_RELAY_ANONYMOUS_UNITS_PER_MINUTE', d.anonymousGlobal),
    sendPerCaller: sends('RPC_RELAY_SENDS_PER_MINUTE', d.sendPerCaller),
    sendServer: sends('RPC_RELAY_SERVER_SENDS_PER_MINUTE', d.sendServer),
    globalForge,
    globalSites,
    globalServer,
    globalAnonymous,
  };
}

export function readRelayConfig(env: Env = process.env): RelayConfig {
  const cluster = readCluster(env);
  const upstream = readUpstream(env, cluster);
  return {
    cluster,
    upstreamUrl: upstream.url,
    upstreamSource: upstream.source,
    upstreamSharesRpcUrl: upstream.source === 'RPC_URL' || trimmed(env, 'RPC_URL') === upstream.url,
    appOrigin: readAppOrigin(env),
    clientsDomain: readClientsDomain(env),
    allowLocalhost: env.NODE_ENV !== 'production',
    tokenSecret: readTokenSecret(env),
    allowAnonymous: readAnonymous(env, cluster),
    supabase: readSupabase(env),
    limits: readLimits(env),
  };
}
