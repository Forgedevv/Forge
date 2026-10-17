import { AuthConfigError, getAppUrl, getSessionSecret, getSupabaseJwtSecret } from './auth/config';
import { parseBetaPolicy } from './beta/config';
import { ChatConfigError, loadChatConfig } from './chat/config';
import { FlagsConfigError, readFlagsEnv } from './flags/flags';
import { RoutesConfigError, readRoutesConfig } from './jobs/config';
import { consoleLogger, errorName, type RoutesLogger } from './jobs/log';
import { readPaymentsConfig } from './payments/config';
import { PaymentConfigError } from './payments/errors';
import { RelayConfigError, readRelayConfig } from './rpc/config';

/*
 * Readiness of a server instance: read once at startup (instrumentation.ts) and by
 * GET /api/health. The routes read their configuration lazily, at their first request, so that a
 * build without secrets still succeeds; this module reads all of it at once:
 *
 *   - payments (readPaymentsConfig), jobs and launchpads (readRoutesConfig), the RPC relay
 *     (readRelayConfig), sign-in (SESSION_SECRET, SUPABASE_JWT_SECRET, NEXT_PUBLIC_APP_URL), the
 *     design chat (ANTHROPIC_API_KEY), the public flags route (SUPABASE_ANON_KEY) and the beta
 *     policy (a closed beta lets nobody in);
 *   - the cluster of the browser bundle: NEXT_PUBLIC_SOLANA_CLUSTER, inlined at build time, must
 *     equal SOLANA_CLUSTER, read at run time. It must be set in production (a production bundle
 *     without it links to mainnet-beta, whatever the server runs on).
 *
 * Coin uploads (not configured yet = 503 NOT_CONFIGURED by design) and the $FORGE gate (read at
 * request time) are not part of it.
 *
 * Problems name variables, never values, and only reach the server log: the public health answer
 * carries a generic code.
 */

export type ReadinessCode = 'config_invalid' | 'cluster_mismatch';

export type Readiness =
  | { ok: true; cluster: 'devnet' | 'mainnet-beta' }
  | { ok: false; code: ReadinessCode; problems: string[] };

/** Errors of the configuration readers: their messages name variables only. */
const CONFIG_ERRORS = [
  PaymentConfigError,
  RoutesConfigError,
  RelayConfigError,
  AuthConfigError,
  ChatConfigError,
  FlagsConfigError,
] as const;

function problemOf(area: string, error: unknown): string {
  if (CONFIG_ERRORS.some((type) => error instanceof type)) return (error as Error).message;
  // Anything else: its name only (an unexpected message could carry a value).
  return `${area}: unexpected ${errorName(error)}`;
}

/**
 * The cluster check: NEXT_PUBLIC_SOLANA_CLUSTER against SOLANA_CLUSTER. Outside production an
 * unset value means devnet (what the browser then links to).
 */
export function browserClusterProblem(
  serverCluster: string,
  publicCluster: string | undefined,
  production: boolean,
): string | null {
  const browser = publicCluster?.trim() ?? '';
  if (browser === '') {
    if (production) return 'NEXT_PUBLIC_SOLANA_CLUSTER is not set';
    return serverCluster === 'devnet'
      ? null
      : 'NEXT_PUBLIC_SOLANA_CLUSTER is not set while SOLANA_CLUSTER is not devnet';
  }
  return browser === serverCluster
    ? null
    : 'NEXT_PUBLIC_SOLANA_CLUSTER does not match SOLANA_CLUSTER';
}

/**
 * Reads the whole server configuration of this instance. `publicCluster` defaults to the
 * build-time value of NEXT_PUBLIC_SOLANA_CLUSTER (a literal `process.env.NEXT_PUBLIC_*` read is
 * inlined by Next.js, as in the browser bundle).
 */
export function checkServerReadiness(
  publicCluster: string | undefined = process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
): Readiness {
  const env = process.env;
  const problems: string[] = [];
  const check = (area: string, read: () => unknown) => {
    try {
      read();
    } catch (error) {
      problems.push(problemOf(area, error));
    }
  };
  let cluster: 'devnet' | 'mainnet-beta' = 'devnet';
  try {
    cluster = readPaymentsConfig(env).cluster;
  } catch (error) {
    problems.push(problemOf('payments', error));
  }
  check('jobs', () => readRoutesConfig(env));
  check('rpc relay', () => readRelayConfig(env));
  check('auth', () => getSessionSecret());
  check('auth', () => getSupabaseJwtSecret());
  check('auth', () => getAppUrl());
  check('chat', () => loadChatConfig(env));
  check('flags', () => readFlagsEnv(env));
  const beta = parseBetaPolicy(env);
  if (beta.mode === 'closed') problems.push(beta.problem);

  const unique = [...new Set(problems)];
  if (unique.length > 0) return { ok: false, code: 'config_invalid', problems: unique };
  const production = process.env.NODE_ENV === 'production';
  const mismatch = browserClusterProblem(cluster, publicCluster, production);
  if (mismatch) return { ok: false, code: 'cluster_mismatch', problems: [mismatch] };
  return { ok: true, cluster };
}

const GLOBAL_KEY = Symbol.for('forge.web.readiness.logged');

/**
 * Logs a readiness result, once per distinct result in this process (the health route may be
 * polled often): `server_ready` (info) or `server_not_ready` (error, with the problems).
 */
export function logReadiness(
  readiness: Readiness,
  phase: 'startup' | 'health',
  logger: RoutesLogger = consoleLogger('readiness'),
): void {
  const key = readiness.ok
    ? `ok:${readiness.cluster}`
    : `${readiness.code}:${readiness.problems.join('|')}`;
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  if (g[GLOBAL_KEY] === key) return;
  g[GLOBAL_KEY] = key;
  if (readiness.ok) {
    logger.log('info', 'server_ready', { phase, cluster: readiness.cluster });
  } else {
    logger.log('error', 'server_not_ready', {
      phase,
      code: readiness.code,
      problems: readiness.problems.join('; '),
    });
  }
}

/** Startup check (instrumentation.ts): logs the readiness, never throws. */
export function logStartupReadiness(logger?: RoutesLogger): Readiness {
  let readiness: Readiness;
  try {
    readiness = checkServerReadiness();
  } catch (error) {
    readiness = { ok: false, code: 'config_invalid', problems: [problemOf('startup', error)] };
  }
  logReadiness(readiness, 'startup', logger);
  return readiness;
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * GET /api/health: 200 `{ ok: true }` when this instance is ready; otherwise 503
 * `{ ok: false, code }` with a generic code (`config_invalid` or `cluster_mismatch`). The
 * problems themselves only go to the server log.
 */
export function healthResponse(logger?: RoutesLogger): Response {
  let readiness: Readiness;
  try {
    readiness = checkServerReadiness();
  } catch (error) {
    readiness = { ok: false, code: 'config_invalid', problems: [problemOf('health', error)] };
  }
  logReadiness(readiness, 'health', logger);
  if (readiness.ok) return Response.json({ ok: true }, { headers: NO_STORE });
  return Response.json({ ok: false, code: readiness.code }, { status: 503, headers: NO_STORE });
}
