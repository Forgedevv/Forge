/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto';
import { isSiteHost } from '@forge/shared';
import { z } from 'zod';
import {
  assertDeployableSlug,
  encodeBranch,
  gitBlobSha,
  isSafeTreePath,
  repoNameForSlug,
  TREE_LIMITS,
  treeLimits,
  type GithubClient,
  type TreeLimits,
} from './github.js';
import {
  createHttpClient,
  readApiError,
  redactSecrets,
  ServiceError,
  type HttpClient,
  type HttpResponse,
  type QueryValue,
  type RequestOptions,
  type RetryEvent,
} from './http.js';
import { inPool } from './pool.js';
import {
  RELAY_TOKEN_ENV,
  RELAY_TOKEN_RE,
  RELAY_TOKEN_SECRET_ENV,
  rpcRelayToken,
} from './relay-token.js';

/**
 * Vercel client (REST over fetch).
 *
 * Model: one Vercel project per client, not linked to any git repository, so Vercel never needs
 * access to the GitHub organization (no Vercel GitHub app; the Hobby plan cannot deploy private
 * repositories of an organization anyway). The builder deploys from files: `createDeployment`
 * reads the exact tree of one commit of the client repo through the GitHub App (read-only,
 * github.ts `listCommitTree` / `readBlobs`), uploads what Vercel does not have yet and creates the
 * deployment from that file list. The builder controls when a preview exists; the same preview is
 * later promoted to production without a rebuild (docs/INTERFACES.md section 4: preview_ready ->
 * deploying -> live).
 *
 * Every non-API deployment is turned off on every project (`ensureProject`). A project without a
 * git link cannot be deployed by a git webhook at all: nothing more is needed (the Hobby plan has
 * no deployment policy, `PATCH` answers 403). A project created by earlier code may still be
 * linked to its repo (tolerated, never needed, it must be the client's repo): without the policy,
 * a push of `forge/<jobId>` would build a second, uncontrolled preview, and the merge into `main`
 * would ship to production on its own, bypassing the promotion step; such a project is refused
 * when the policy cannot be set. Every step re-checks it (`gitDeploymentsDisabled`).
 * Mechanism: the project deployment policy (`PATCH /v9/projects/{id}` with
 * `deploymentPolicy.deploymentSources`) allows only the `rest-api` source in production and
 * preview; per the Vercel API reference, `git` is "git provider webhook" and `rest-api` is "direct
 * user/team-token REST upload", which is what a file deployment is. The policy is read back and
 * verified; a project where it does not hold is refused. Not to be confused with
 * `gitProviderOptions.createDeployments`, which only controls the GitHub "deployment" objects the
 * Vercel bot posts. Defence in depth: the client repo also carries `vercel.json` with
 * `{ "git": { "deploymentEnabled": false } }`.
 *
 * Deployments from files (`createDeployment`):
 * - Files: every regular file of the commit tree with its mode (executable or not). Symlinks,
 *   submodules, unsafe paths and a truncated listing are refused, never skipped: a deployment is
 *   the whole commit or nothing. `DEPLOYMENT_LIMITS` (file count, file size, total size) are
 *   checked from the listing before anything is downloaded or uploaded.
 * - Upload: the deployment is first requested with the file list (`files: [{ file, sha, size,
 *   mode }]`, sha1 digests). Vercel answers `missing_files` with the digests it does not hold for
 *   the team; only those are uploaded (`POST /v2/files`, `x-vercel-digest`, bounded concurrency,
 *   retried on 429/5xx since the upload is content-addressed), then the creation is retried once.
 *   The client remembers the digest of every git blob it has read (content-addressed, bounded), so
 *   an unchanged file (for example a template file shared by every client) is not read from
 *   GitHub again unless Vercel asks for its bytes.
 * - Build: `projectSettings: { framework: 'nextjs' }`, everything else left to Vercel's defaults:
 *   it installs with the lockfile the commit holds and runs its `build` script (`next build`),
 *   the same as a git deployment of that commit.
 * - Commit: recorded in `meta.githubCommitSha` (with the ref, repo and org), which `toDeployment`
 *   reports as `commitSha`, so every later check of the deployed commit keeps working.
 * - Idempotency rule: before creating anything, an earlier deployment of the same project, target,
 *   commit and environment is looked up; one that is queued, building or READY (and, for
 *   production, staged) is returned instead of a new one. A failed or canceled one is never
 *   reused: a new deployment is created. The creation itself is never replayed blindly after an
 *   ambiguous failure (network error, timeout, 5xx): each request carries its own nonce
 *   (`meta.forgeRequestId`), which is looked up first (a few reads a moment apart, Vercel may list
 *   a new deployment late), then the lookup of the commit runs again (same rule), then at most one
 *   more attempt. Vercel's own deduplication of similar deployments is turned off (`forceNew=1`),
 *   so a deployment always carries the commit it was asked for.
 * - Environment: a deployment keeps the project variables it was built with (`NEXT_PUBLIC_*` are
 *   inlined in the browser bundle, and Vercel never applies a later change to an existing
 *   deployment). A rebuild after a variable changed (for example the RPC relay URL) with no code
 *   change has the same commit: reusing the earlier deployment would serve the old value. So the
 *   variables that apply to the deployment's target are read first (`GET /v10/projects/{id}/env`,
 *   decrypted) and reduced to a fingerprint (`projectEnvFingerprint`, sha256 of the sorted
 *   `key=value` lines), recorded in `meta.forgeEnvSha256` of every new deployment. Only an earlier
 *   deployment that recorded the same fingerprint is reused; one without it (made before this
 *   rule) never is. Values Vercel never returns (`sensitive`: the relay token) count by their
 *   presence only, so a rotation of the relay token secret is not seen by this rule. When the
 *   variables cannot be read in full (any error, an unexpected answer, a second page), nothing is
 *   reused and the new deployment records no fingerprint, so it is never reused either. The
 *   deployment of a lost request, found by its nonce, must carry the fingerprint that request sent.
 * - Production is staged: a production deployment still building is only accepted when Vercel
 *   echoes `autoAssignCustomDomains: false` (otherwise it is canceled and refused), and once it is
 *   READY the project's production must not point at it yet (`waitForDeployment`): only the
 *   explicit promotion, after the caller's checks, moves production.
 */

const DEFAULT_API_URL = 'https://api.vercel.com';
const FRAMEWORK = 'nextjs';

/** Limits of one deployment (count, per-file and total size), checked before any upload. */
export const DEPLOYMENT_LIMITS: Readonly<TreeLimits> = TREE_LIMITS;
/** Parallel file uploads to Vercel. */
const UPLOAD_CONCURRENCY = 6;
/** Git blob ids whose Vercel digest is remembered (oldest forgotten first). */
const DIGEST_CACHE_MAX = 50_000;
/** Earlier deployments listed, and fully read at most, by the idempotency lookup. */
const REUSE_LOOKUP_LIMIT = 20;
const REUSE_MAX_CHECKS = 5;
/** File modes sent to Vercel (`git`'s regular and executable file modes, as the CLI sends). */
const MODE_REGULAR = 0o100644;
const MODE_EXECUTABLE = 0o100755;
const DIGEST_RE = /^[0-9a-f]{40}$/;
/** Static page served in production until the client's approved site is promoted. */
const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Coming soon</title></head>' +
  '<body style="margin:0;min-height:100vh;display:grid;place-items:center;' +
  'font-family:system-ui,sans-serif;background:#0b0b10;color:#e9e7f5">' +
  '<p>This launchpad is being built. Come back soon.</p></body></html>\n';
const PLACEHOLDER_TIMEOUT_MS = 3 * 60_000;
/** Statuses of a refused creation that are read (a `missing_files` answer among them). */
const CREATE_REFUSALS: readonly number[] = [400, 412, 422];

/** The only deployment source allowed on client projects (see the module comment). */
const ALLOWED_DEPLOYMENT_SOURCES: readonly string[] = ['rest-api'];
const POLICY_TARGETS = ['production', 'preview'] as const;

/** `deploymentPolicy` body that turns off git-triggered (and every non-API) deployment. */
export const API_ONLY_DEPLOYMENT_POLICY = {
  deploymentSources: [
    {
      enabled: true,
      environments: POLICY_TARGETS.map((target) => ({ type: 'system', target })),
      sources: [...ALLOWED_DEPLOYMENT_SOURCES],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Vercel project name for a launchpad (same as the repo name). */
export function projectNameForSlug(slug: string): string {
  return repoNameForSlug(slug);
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Validates the domain under which client sites live (for example `forge-sites.app`). */
export function assertClientsDomain(domain: string): void {
  if (typeof domain !== 'string' || !HOST_RE.test(domain)) {
    throw new ServiceError('vercel', 'invalid_input', 'invalid clients domain');
  }
}

/** `<slug>.<clients domain>`. */
export function subdomainFor(slug: string, clientsDomain: string): string {
  assertDeployableSlug(slug);
  assertClientsDomain(clientsDomain);
  return `${slug}.${clientsDomain}`;
}

// ---------------------------------------------------------------------------------------------
// Environment variables of a client project
// ---------------------------------------------------------------------------------------------

/*
 * A client project runs code generated from user input and is served to the public: anything in
 * its environment must be assumed readable by anyone (`NEXT_PUBLIC_*` is inlined in the browser
 * bundle, and a server route of a generated site can echo any other variable). So a client project
 * only ever receives public values:
 *
 * - `NEXT_PUBLIC_*` values the browser needs (cluster, RPC relay origin, Jupiter referral account,
 *   platform fee wallet and Meteora referral account of the curve swap, public bucket URL, pool
 *   config keys). The template reads them as literal `process.env.NEXT_PUBLIC_*` (inlined at
 *   build time): a name the builder does not set is `undefined` in the browser, and trading
 *   breaks (vercel.template-env.test.ts checks the template source against this list);
 * - the public on-chain FORGE addresses and the cluster, which `@forge/core` reads from
 *   `process.env` on the server (addresses, not credentials);
 * - the public R2 URL and the pool config key read by server routes.
 *
 * Never: `RPC_URL` (raw provider key), R2 write credentials, `JUPITER_API_KEY`,
 * a registry token (`GITHUB_PACKAGES_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN`: client projects install
 * `@forge/core` from the public npm registry with no token), `RPC_RELAY_TOKEN_SECRET`, or any other
 * credential. RPC traffic goes
 * through the FORGE relay and uploads must go through a FORGE-side presigned-URL endpoint.
 *
 * One exception, the only server-only secret a client project holds: `FORGE_RPC_RELAY_TOKEN`
 * (relay-token.ts), the token of the RPC relay and upload routes for this launchpad only. Derived
 * per slug by the builder, stored as a `sensitive` variable, never `NEXT_PUBLIC_*`, never taken
 * from the builder's own environment. A leak only exposes that launchpad's own relay quota.
 *
 * `TEMPLATE_ENV` (packages/shared) still lists RPC_URL, JUPITER_API_KEY and the R2 write keys:
 * this module deliberately does not follow it.
 */

/** Variables a client project may receive (all public). Anything else is refused by `setEnv`. */
export const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'SOLANA_CLUSTER',
  'NEXT_PUBLIC_SOLANA_CLUSTER',
  'FORGE_REVENUE_WALLET',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
  'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_REVENUE_WALLET',
  'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
  'R2_PUBLIC_URL',
  'NEXT_PUBLIC_R2_PUBLIC_URL',
  'POOL_CONFIG_KEY',
  'NEXT_PUBLIC_POOL_CONFIG_KEY',
  RELAY_TOKEN_ENV,
]);

/** Allowlisted variables that are secrets: server-only (`sensitive`), set per launchpad. */
export const PROJECT_SERVER_SECRETS: ReadonlySet<string> = new Set<string>([RELAY_TOKEN_ENV]);

/**
 * Secrets that earlier code (and `TEMPLATE_ENV`) sent to client projects. Refused by `setEnv` with
 * an explicit message; `pruneEnv` removes them (and anything else not allowlisted) from a project.
 */
export const PROJECT_ENV_FORBIDDEN: ReadonlySet<string> = new Set<string>([
  'RPC_URL',
  'JUPITER_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'GITHUB_PACKAGES_TOKEN',
  'NODE_AUTH_TOKEN',
  // The operator's npm publish token (scripts/publish-core.mjs).
  'NPM_TOKEN',
  RELAY_TOKEN_SECRET_ENV,
]);

/** Variables a client project cannot work without (the pool config key is added per launchpad). */
export const PROJECT_ENV_REQUIRED: readonly string[] = [
  'SOLANA_CLUSTER',
  'NEXT_PUBLIC_SOLANA_CLUSTER',
  'FORGE_REVENUE_WALLET',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
  'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_REVENUE_WALLET',
  'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
  'R2_PUBLIC_URL',
];

/**
 * Public `NEXT_PUBLIC_*` twins derived from a FORGE-side variable when not given explicitly. A twin
 * given explicitly must equal its source: the browser and the server must use the same accounts.
 */
const DERIVED_ENV: ReadonlyArray<readonly [string, string]> = [
  ['NEXT_PUBLIC_SOLANA_CLUSTER', 'SOLANA_CLUSTER'],
  ['NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', 'FORGE_JUPITER_REFERRAL_ACCOUNT'],
  ['NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', 'FORGE_PLATFORM_FEE_WALLET'],
  ['NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT', 'FORGE_METEORA_REFERRAL_ACCOUNT'],
  // The browser checks that the Meteora referral account is held by the revenue wallet and
  // that the platform fee wallet is that wallet (D34).
  ['NEXT_PUBLIC_FORGE_REVENUE_WALLET', 'FORGE_REVENUE_WALLET'],
  ['NEXT_PUBLIC_R2_PUBLIC_URL', 'R2_PUBLIC_URL'],
  ['NEXT_PUBLIC_POOL_CONFIG_KEY', 'POOL_CONFIG_KEY'],
];

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_LIST = /^[1-9A-HJ-NP-Za-km-z]{32,44}(,[1-9A-HJ-NP-Za-km-z]{32,44}){0,19}$/;
const CLUSTER = /^(devnet|mainnet-beta)$/;

/**
 * Public https URL without credentials, query or fragment. RPC providers carry their key in the
 * query string (or the path), so any query is refused, as is a path that names a key or token.
 */
function isPublicUrl(value: string): boolean {
  if (value.includes('?') || value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    !/api[-_]?key|token|secret/i.test(url.pathname)
  );
}

const VALUE_CHECKS: Readonly<Record<string, (value: string) => boolean>> = {
  SOLANA_CLUSTER: (v) => CLUSTER.test(v),
  NEXT_PUBLIC_SOLANA_CLUSTER: (v) => CLUSTER.test(v),
  FORGE_REVENUE_WALLET: (v) => BASE58_ADDRESS.test(v),
  FORGE_METEORA_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  FORGE_PLATFORM_FEE_WALLET: (v) => BASE58_ADDRESS.test(v),
  FORGE_JUPITER_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_REVENUE_WALLET: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_RPC_RELAY_URL: isPublicUrl,
  R2_PUBLIC_URL: isPublicUrl,
  NEXT_PUBLIC_R2_PUBLIC_URL: isPublicUrl,
  POOL_CONFIG_KEY: (v) => ADDRESS_LIST.test(v),
  NEXT_PUBLIC_POOL_CONFIG_KEY: (v) => ADDRESS_LIST.test(v),
  [RELAY_TOKEN_ENV]: (v) => RELAY_TOKEN_RE.test(v),
};

export type ProjectEnvType = 'plain' | 'sensitive';

/**
 * Allowed public variables are `plain`; the server-only secret (and anything else, which is never
 * sent anyway) is `sensitive`.
 */
export function envTypeFor(key: string): ProjectEnvType {
  return PROJECT_ENV_ALLOWLIST.has(key) && !PROJECT_SERVER_SECRETS.has(key) ? 'plain' : 'sensitive';
}

/**
 * Why a variable cannot go to a client project, or undefined when it can. The reason names the
 * variable, never its value.
 */
export function projectEnvProblem(key: string, value: unknown): string | undefined {
  if (PROJECT_ENV_FORBIDDEN.has(key)) {
    return `${key} is a secret and must never reach a client project`;
  }
  if (!PROJECT_ENV_ALLOWLIST.has(key)) {
    return `environment variable not allowed: ${key.slice(0, 60)}`;
  }
  if (typeof value !== 'string' || value === '') return `empty value for ${key}`;
  const check = VALUE_CHECKS[key];
  if (!check || !check(value)) return `invalid public value for ${key}`;
  return undefined;
}

/**
 * Picks the allowed variables out of `source` (for example `process.env`) and derives the public
 * `NEXT_PUBLIC_*` twins when absent. Missing and invalid ones are reported rather than silently
 * dropped, so a half-configured project is never deployed. Secrets present in `source` are
 * ignored; a relay URL on the same host as `RPC_URL` (the raw provider) is reported as invalid.
 */
export function pickProjectEnv(
  source: Record<string, string | undefined>,
  required: readonly string[] = PROJECT_ENV_REQUIRED,
): { vars: Record<string, string>; missing: string[]; invalid: string[] } {
  const vars: Record<string, string> = {};
  for (const key of PROJECT_ENV_ALLOWLIST) {
    // Per-launchpad secrets are derived for each project, never copied from an environment.
    if (PROJECT_SERVER_SECRETS.has(key)) continue;
    const v = source[key];
    if (typeof v === 'string' && v !== '') vars[key] = v;
  }
  const invalid = new Set<string>();
  for (const [target, from] of DERIVED_ENV) {
    const v = vars[from];
    if (vars[target] === undefined && v !== undefined) vars[target] = v;
    else if (vars[target] !== undefined && v !== undefined && vars[target] !== v) {
      // An explicit twin that disagrees with its source: the browser would use other accounts.
      invalid.add(target);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    if (projectEnvProblem(key, value) !== undefined) invalid.add(key);
  }
  const relay = vars['NEXT_PUBLIC_FORGE_RPC_RELAY_URL'];
  const rpc = source['RPC_URL'];
  if (relay !== undefined && rpc && sameHost(relay, rpc)) {
    // The relay must be a FORGE endpoint, never the provider itself.
    invalid.add('NEXT_PUBLIC_FORGE_RPC_RELAY_URL');
  }
  for (const key of invalid) delete vars[key];
  const missing = required.filter((k) => vars[k] === undefined && !invalid.has(k));
  return { vars, missing, invalid: [...invalid].sort() };
}

/**
 * Variables of one client project: the shared public ones, its pool config keys and its own relay
 * token (derived here, never taken from `base`).
 */
export function clientProjectVars(
  base: Readonly<Record<string, string>>,
  opts: { slug: string; poolKeys?: string | undefined; relayTokenSecret: string },
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!PROJECT_SERVER_SECRETS.has(k)) vars[k] = v;
  if (opts.poolKeys) {
    vars.POOL_CONFIG_KEY = opts.poolKeys;
    vars.NEXT_PUBLIC_POOL_CONFIG_KEY = opts.poolKeys;
  }
  vars[RELAY_TOKEN_ENV] = rpcRelayToken(opts.relayTokenSecret, opts.slug);
  return vars;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/** One variable as `GET /v10/projects/{id}/env` lists it (only what the fingerprint reads). */
export interface ProjectEnvEntry {
  key: string;
  value?: string | null | undefined;
  type?: string | null | undefined;
  /** Vercel answers an array, or a single target. */
  target?: string | readonly string[] | null | undefined;
  gitBranch?: string | null | undefined;
  decrypted?: boolean | null | undefined;
}

/** First line of the fingerprinted text: a later change of the rule never matches this one. */
const ENV_FINGERPRINT_VERSION = 'forge-env:v1';

/**
 * Fingerprint of the variables a deployment of `target` is built with (module comment): sha256
 * hex of the sorted `key=value` lines of every variable whose target includes `target` (or that
 * names no target: counting more only makes reuse rarer). The value is JSON-encoded, so no value
 * can pass for two lines; a branch-scoped variable is `key@branch`. A `sensitive` (or legacy
 * `secret`) value is never part of it, nor read: Vercel does not return it, it counts by its
 * presence only (`key=<sensitive>`). A value Vercel left encrypted counts by its ciphertext.
 * Deterministic: the order Vercel lists the variables in does not matter.
 */
export function projectEnvFingerprint(
  envs: readonly ProjectEnvEntry[],
  target: 'production' | 'preview',
): string {
  const lines: string[] = [];
  for (const e of envs) {
    const targets = typeof e.target === 'string' ? [e.target] : e.target;
    if (targets !== null && targets !== undefined && !targets.includes(target)) continue;
    const name = e.gitBranch ? `${e.key}@${e.gitBranch}` : e.key;
    lines.push(`${name}=${envValueToken(e)}`);
  }
  // Code-unit order, independent of the locale.
  lines.sort();
  return createHash('sha256')
    .update([ENV_FINGERPRINT_VERSION, ...lines].join('\n'), 'utf8')
    .digest('hex');
}

function envValueToken(e: ProjectEnvEntry): string {
  const type = e.type ?? 'unknown';
  if (type === 'sensitive' || type === 'secret' || typeof e.value !== 'string') return `<${type}>`;
  if (type === 'encrypted' && e.decrypted !== true) return `<encrypted>${JSON.stringify(e.value)}`;
  return JSON.stringify(e.value);
}

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/**
 * Where deployments read the client repo from: the GitHub client (github.ts), read-only.
 * `getBranchHead` only serves a deployment requested without a commit sha.
 */
export type DeploymentSource = Pick<GithubClient, 'getBranchHead' | 'listCommitTree' | 'readBlobs'>;

export interface VercelClientOptions {
  /** API token. Never log it. */
  token: string;
  /** Team id (`team_...`), preferred over `teamSlug`. */
  teamId?: string;
  teamSlug?: string;
  /**
   * GitHub organization owning the client repos: recorded in the deployment metadata; a project
   * still linked by earlier code must be linked to `<org>/<repo>`.
   */
  githubOrg: string;
  /** Client repo reader used by `createDeployment` (required to deploy). */
  source?: DeploymentSource;
  /** Overrides of `DEPLOYMENT_LIMITS`. */
  deploymentLimits?: Partial<TreeLimits>;
  /** Parallel file uploads (default 6). */
  uploadConcurrency?: number;
  /** Domain under which client sites are served (`<slug>.<clientsDomain>`). */
  clientsDomain?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  retryBaseMs?: number;
  maxRetryWaitMs?: number;
  timeoutMs?: number;
  onRetry?: (event: RetryEvent) => void;
}

const EnvSchema = z.object({
  VERCEL_TOKEN: z.string().min(10, 'invalid VERCEL_TOKEN'),
  VERCEL_TEAM_ID: z
    .string()
    .regex(/^team_[A-Za-z0-9]{8,40}$/, 'invalid VERCEL_TEAM_ID')
    .optional(),
  VERCEL_TEAM: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,48}$/, 'invalid VERCEL_TEAM')
    .optional(),
  GITHUB_ORG: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'invalid GITHUB_ORG'),
  CLIENTS_DOMAIN: z.string().optional(),
});

/** Reads the Vercel settings from an env-like object (`VERCEL_TEAM_ID` or `VERCEL_TEAM` slug). */
export function vercelOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<VercelClientOptions, 'token' | 'githubOrg'> &
  Partial<Pick<VercelClientOptions, 'teamId' | 'teamSlug' | 'clientsDomain'>> {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new ServiceError('vercel', 'invalid_input', `invalid Vercel environment: ${names}`);
  }
  const e = parsed.data;
  if (e.CLIENTS_DOMAIN !== undefined) assertClientsDomain(e.CLIENTS_DOMAIN);
  return {
    token: e.VERCEL_TOKEN,
    githubOrg: e.GITHUB_ORG,
    ...(e.VERCEL_TEAM_ID ? { teamId: e.VERCEL_TEAM_ID } : {}),
    ...(e.VERCEL_TEAM ? { teamSlug: e.VERCEL_TEAM } : {}),
    ...(e.CLIENTS_DOMAIN ? { clientsDomain: e.CLIENTS_DOMAIN } : {}),
  };
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProject {
  id: string;
  name: string;
  /**
   * `<org>/<repo>` when linked to a GitHub repository: only projects created by earlier code,
   * new ones have no link.
   */
  linkedRepo: string | undefined;
  /** Id of the deployment currently serving production, if any. */
  productionDeploymentId: string | undefined;
  /**
   * Framework preset of the project (`nextjs` for every client project; null when Vercel reports
   * none). Only the placeholder deployment switches it off for a moment (`ensureProject` puts it
   * back whenever it differs).
   */
  framework: string | null;
  paused: boolean;
  /**
   * True when no git webhook can deploy the project: it has no git link at all (how projects are
   * created now), or its deployment policy only lets the REST API deploy in both production and
   * preview (required for a linked project; the Hobby plan offers no deployment policy).
   */
  gitDeploymentsDisabled: boolean;
}

export type ReadyState =
  'QUEUED' | 'INITIALIZING' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'DELETED';

export interface VercelDeployment {
  id: string;
  /** Full URL (`https://...`), unique to this deployment. */
  url: string;
  readyState: ReadyState;
  target: 'production' | 'preview';
  errorCode: string | undefined;
  errorMessage: string | undefined;
  /**
   * Git commit the deployment was built from: `gitSource.sha` for a git deployment, else
   * `meta.githubCommitSha`, which every file deployment of this client carries.
   */
  commitSha: string | undefined;
  /** Project the deployment belongs to, when Vercel reports it. */
  projectId: string | undefined;
}

/**
 * Who may open a deployment URL. Client previews must be viewable by the client, who has no Vercel
 * account, so the default is `none` (the URL carries an unguessable hash). Other values map to
 * Vercel Authentication scopes.
 */
export type DeploymentProtection =
  | 'none'
  | 'all'
  | 'preview'
  | 'prod_deployment_urls_and_all_previews'
  | 'all_except_custom_domains';

export interface DomainResult {
  domain: string;
  /**
   * Verified on the project AND its DNS points at Vercel (`GET /v6/domains/{name}/config`
   * `misconfigured: false`). Vercel's own `verified` only means ownership: a subdomain of a
   * domain nobody configured was reported verified on devnet while it resolved nowhere.
   */
  verified: boolean;
  /** DNS records to add when the domain is not verified yet. */
  verification: Array<{ type: string; domain: string; value: string }>;
  created: boolean;
}

export interface CreateDeploymentInput {
  project: { id: string; name: string };
  /** Repo name (`lp-<slug>`) in the configured GitHub org: the files are read from it. */
  repo: string;
  /**
   * Branch the commit belongs to, for example `forge/<jobId>` or `main`: recorded in the
   * deployment metadata, and resolved to its head when `sha` is absent.
   */
  ref: string;
  /**
   * Commit to deploy, exactly. Always pass it: without it, whatever the branch head is when the
   * call reads it gets deployed.
   */
  sha?: string;
  target?: 'production' | 'preview';
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface VercelClient {
  listTeams(): Promise<VercelTeam[]>;
  listProjects(limit?: number): Promise<Array<{ id: string; name: string }>>;
  getProject(nameOrId: string): Promise<VercelProject | null>;
  /**
   * Creates the project for a slug (no git link) or reuses it; restricts deployments to the REST
   * API (verified) and applies protection.
   */
  ensureProject(input: {
    slug: string;
    protection?: DeploymentProtection;
  }): Promise<{ project: VercelProject; created: boolean }>;
  setProtection(projectId: string, protection: DeploymentProtection): Promise<void>;
  /** Upserts environment variables (public allowlist only, values checked). Idempotent. */
  setEnv(projectId: string, vars: Record<string, string>): Promise<{ count: number }>;
  /** Deletes every variable of the project that is not allowlisted. Returns the removed names. */
  pruneEnv(projectId: string): Promise<{ removed: string[] }>;
  /** Restricts deployments to the REST API (no git webhook deployment) and verifies it. */
  disableGitDeployments(projectId: string): Promise<VercelProject>;
  /**
   * Deploys the exact files of one commit of the client repo (module comment). Idempotent per
   * commit and environment: an earlier deployment of the same project, target and commit, built
   * with the same project variables (`meta.forgeEnvSha256`), that has not failed is returned
   * instead. A production one is staged: it never takes the production domains by
   * itself, only `promoteToProduction` does (after the caller's checks). One still building that
   * Vercel does not confirm as staged is canceled and refused; one that does not report this
   * project is refused.
   */
  createDeployment(input: CreateDeploymentInput): Promise<VercelDeployment>;
  getDeployment(idOrUrl: string): Promise<VercelDeployment>;
  /**
   * Polls until READY; throws `deployment_failed` on ERROR/CANCELED and `timeout` past the deadline.
   * A production deployment `createDeployment` returned while it was still building must still be
   * staged once READY: when the project's production already points at it before any promotion,
   * it throws (`isProductionNotStaged`).
   */
  waitForDeployment(id: string, opts?: WaitOptions): Promise<VercelDeployment>;
  /** Cancels a deployment that is still building; one that already ended is left as it is. */
  cancelDeployment(id: string): Promise<void>;
  /**
   * Deploys the static placeholder page again and makes it the project's production deployment
   * (promoted when Vercel does not assign it by itself), verified by reading the project back.
   * Used when a deployment that must stay private took production.
   */
  restorePlaceholder(projectId: string): Promise<{ deploymentId: string }>;
  /** Promotes a READY preview to production (no rebuild) and waits until it serves production. */
  promoteToProduction(
    projectId: string,
    deploymentId: string,
    opts?: WaitOptions,
  ): Promise<{ promoted: boolean }>;
  /** Attaches `<slug>.<clientsDomain>` to the project. Idempotent. */
  attachSubdomain(projectId: string, slug: string): Promise<DomainResult>;
  /**
   * Hosts at which Vercel serves `deploymentId` for `projectId`: the aliases the API lists for the
   * project (team scope) whose own record names this very project and this very deployment, with
   * no redirect. Lowercase, site-host shaped only (`isSiteHost`), deduplicated and sorted. Read
   * only; never guessed from a name. With `timeoutMs`, an empty answer is read again until the
   * deadline (aliases move to a promoted deployment shortly after the promotion).
   */
  listProductionHosts(
    projectId: string,
    deploymentId: string,
    opts?: WaitOptions,
  ): Promise<string[]>;
  detachDomain(projectId: string, domain: string): Promise<boolean>;
  /** Disables the site: production and previews answer with a pause page. Reversible. */
  pauseProject(projectId: string): Promise<void>;
  unpauseProject(projectId: string): Promise<void>;
  /** Deletes the project; false when it did not exist. */
  deleteProject(idOrName: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------------------------

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  link: z
    .object({
      type: z.string().optional(),
      org: z.string().optional(),
      repo: z.string().optional(),
    })
    .nullish(),
  targets: z.object({ production: z.object({ id: z.string().optional() }).nullish() }).nullish(),
  framework: z.string().nullish(),
  paused: z.boolean().optional(),
  deploymentPolicy: z
    .object({
      deploymentSources: z
        .array(
          z.object({
            enabled: z.boolean(),
            environments: z.array(z.object({ type: z.string(), target: z.string().optional() })),
            sources: z.array(z.string()),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
const DeploymentSchema = z.object({
  id: z.string(),
  url: z.string().default(''),
  readyState: z.string(),
  target: z.string().nullish(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  projectId: z.string().optional(),
  gitSource: z.object({ sha: z.string().optional() }).nullish(),
  meta: z
    .object({
      githubCommitSha: z.string().optional(),
      forgeRequestId: z.string().optional(),
      forgeEnvSha256: z.string().optional(),
    })
    .nullish(),
  /** Echo of the create option ("applies to custom domains only, defaults to `true`"). */
  autoAssignCustomDomains: z.boolean().nullish(),
});
type DeploymentBody = z.infer<typeof DeploymentSchema>;

/** `GET /v6/deployments` (only what the lookups read; ids are `uid` there). */
const DeploymentListSchema = z.object({
  deployments: z.array(
    z.object({
      uid: z.string(),
      readyState: z.string().nullish(),
      state: z.string().nullish(),
      target: z.string().nullish(),
      meta: z
        .object({
          githubCommitSha: z.string().optional(),
          forgeRequestId: z.string().optional(),
          forgeEnvSha256: z.string().optional(),
        })
        .nullish(),
    }),
  ),
});
type DeploymentListItem = z.infer<typeof DeploymentListSchema>['deployments'][number];

/**
 * `GET /v10/projects/{id}/env` (only what the fingerprint reads). `pagination.next` set means
 * another page: the list is then not the whole environment.
 */
const ProjectEnvListSchema = z.object({
  envs: z.array(
    z.object({
      key: z.string(),
      value: z.string().nullish(),
      type: z.string().nullish(),
      target: z.union([z.array(z.string()), z.string()]).nullish(),
      gitBranch: z.string().nullish(),
      decrypted: z.boolean().nullish(),
    }),
  ),
  pagination: z.object({ next: z.number().nullish() }).nullish(),
});

/**
 * Nonce of one creation request (`meta.forgeRequestId`), looked up after an ambiguous failure:
 * this many reads at most, this long apart (Vercel may list a new deployment a moment late).
 */
const REQUEST_LOOKUP_TRIES = 3;
const REQUEST_LOOKUP_WAIT_MS = 2_000;

/** Staged production deployments remembered until READY (oldest forgotten first). */
const STAGED_TRACK_MAX = 1_000;

/** `apiCode` of the error thrown when a staged production deployment took production by itself. */
export const PRODUCTION_NOT_STAGED = 'forge_production_not_staged';

/** True for the error `waitForDeployment` throws when production moved before the promotion. */
export function isProductionNotStaged(err: unknown): boolean {
  return err instanceof ServiceError && err.apiCode === PRODUCTION_NOT_STAGED;
}

/** A clean-up that failed after an earlier error, kept on that error (never thrown instead of it). */
export interface CleanupFailure {
  what: string;
  error: unknown;
}

const CLEANUP_FAILURE = Symbol('forge.cleanupFailure');

function attachCleanupFailure(err: unknown, failure: CleanupFailure): void {
  if (err instanceof Error) {
    Object.defineProperty(err, CLEANUP_FAILURE, { value: failure, configurable: true });
  }
}

/** The clean-up failure attached to an error by this module, if any. */
export function cleanupFailureOf(err: unknown): CleanupFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  return (err as Error & { [CLEANUP_FAILURE]?: CleanupFailure })[CLEANUP_FAILURE];
}

/** Refused creation: `{ error: { code: 'missing_files', missing: [<sha1>...] } }`. */
const MissingFilesSchema = z.object({
  error: z.object({ code: z.literal('missing_files'), missing: z.array(z.string()).optional() }),
});

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const DomainConfigSchema = z.object({ misconfigured: z.boolean().optional() });

const DomainSchema = z.object({
  name: z.string(),
  verified: z.boolean(),
  verification: z
    .array(z.object({ type: z.string(), domain: z.string(), value: z.string() }))
    .optional(),
});

/**
 * `GET /v4/aliases` (only what `listProductionHosts` reads). Each alias names the project and the
 * deployment it points at; `pagination.next` is the `until` of the next page (null at the end).
 */
const AliasListSchema = z.object({
  aliases: z.array(
    z.object({
      alias: z.string(),
      projectId: z.string().nullish(),
      deploymentId: z.string().nullish(),
      redirect: z.string().nullish(),
    }),
  ),
  pagination: z.object({ next: z.number().nullish() }).nullish(),
});
/**
 * Aliases asked per page (the API's default page size) and pages read at most: a client project
 * holds a handful of aliases.
 */
const ALIAS_PAGE_LIMIT = 20;
const ALIAS_MAX_PAGES = 10;

function parseBody<S extends z.ZodType>(schema: S, res: HttpResponse, what: string): z.infer<S> {
  const parsed = schema.safeParse(res.json);
  if (!parsed.success) {
    throw new ServiceError('vercel', 'invalid_response', `unexpected Vercel response for ${what}`, {
      status: res.status,
    });
  }
  return parsed.data;
}

/** States after which a deployment never changes (READY already got whatever it was assigned). */
const FINAL_STATES = new Set<string>(['READY', 'ERROR', 'CANCELED', 'DELETED']);

/** States of a deployment the idempotency lookup may return (anything else is never reused). */
const REUSABLE_STATES = new Set<string>(['QUEUED', 'INITIALIZING', 'BUILDING', 'READY']);

const READY_STATES = new Set<string>([
  'QUEUED',
  'INITIALIZING',
  'BUILDING',
  'READY',
  'ERROR',
  'CANCELED',
  'DELETED',
]);

function toProject(p: z.infer<typeof ProjectSchema>): VercelProject {
  const linkedRepo =
    p.link?.type === 'github' && p.link.org && p.link.repo
      ? `${p.link.org}/${p.link.repo}`
      : undefined;
  // Any link (whatever the provider, even partial) counts: only an unlinked project cannot be
  // deployed by a git webhook without the policy.
  const linked = p.link !== null && p.link !== undefined;
  return {
    id: p.id,
    name: p.name,
    linkedRepo,
    productionDeploymentId: p.targets?.production?.id ?? undefined,
    framework: p.framework ?? null,
    paused: p.paused === true,
    gitDeploymentsDisabled:
      !linked || apiOnlyPolicyHolds(p.deploymentPolicy?.deploymentSources ?? []),
  };
}

/**
 * True when, for each of production and preview, an enabled rule covers it and every enabled rule
 * covering it allows only the REST API source.
 */
function apiOnlyPolicyHolds(
  rules: ReadonlyArray<{
    enabled: boolean;
    environments: ReadonlyArray<{ type: string; target?: string | undefined }>;
    sources: readonly string[];
  }>,
): boolean {
  return POLICY_TARGETS.every((target) => {
    const covering = rules.filter(
      (r) => r.enabled && r.environments.some((e) => e.type === 'system' && e.target === target),
    );
    return (
      covering.length > 0 &&
      covering.every((r) => r.sources.every((s) => ALLOWED_DEPLOYMENT_SOURCES.includes(s)))
    );
  });
}

function toDeployment(d: DeploymentBody): VercelDeployment {
  const state = d.readyState.toUpperCase();
  const url = d.url.startsWith('http') ? d.url : d.url ? `https://${d.url}` : '';
  const sha = d.gitSource?.sha ?? d.meta?.githubCommitSha;
  return {
    id: d.id,
    url,
    readyState: (READY_STATES.has(state) ? state : 'QUEUED') as ReadyState,
    target: d.target === 'production' ? 'production' : 'preview',
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    commitSha: sha !== undefined && COMMIT_SHA_RE.test(sha) ? sha : undefined,
    projectId: d.projectId,
  };
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export function createVercelClient(opts: VercelClientOptions): VercelClient {
  if (typeof opts.token !== 'string' || opts.token.length < 10) {
    throw new ServiceError('vercel', 'invalid_input', 'invalid Vercel token');
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opts.githubOrg)) {
    throw new ServiceError('vercel', 'invalid_input', 'invalid GitHub organization');
  }
  if (opts.clientsDomain !== undefined) assertClientsDomain(opts.clientsDomain);
  const githubOrg = opts.githubOrg;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const token = opts.token;
  const source = opts.source;
  const limits: TreeLimits = treeLimits(opts.deploymentLimits);
  const uploadConcurrency = opts.uploadConcurrency ?? UPLOAD_CONCURRENCY;
  /** Git blob id -> Vercel digest (sha1) and size of its content, learned from read contents. */
  const digests = new Map<string, { digest: string; size: number }>();
  /**
   * Production deployments `createDeployment` returned while still building, by id -> project id.
   * None of them can have been promoted yet (only READY deployments are): once READY, the
   * project's production must not point at one of them (`waitForDeployment`).
   */
  const stagedProduction = new Map<string, string>();
  const trackStaged = (deploymentId: string, projectId: string): void => {
    if (stagedProduction.size >= STAGED_TRACK_MAX) {
      const oldest = stagedProduction.keys().next();
      if (!oldest.done) stagedProduction.delete(oldest.value);
    }
    stagedProduction.set(deploymentId, projectId);
  };

  const http: HttpClient = createHttpClient({
    service: 'vercel',
    baseUrl: opts.apiBaseUrl ?? DEFAULT_API_URL,
    defaultHeaders: { accept: 'application/json', 'user-agent': 'forge-builder' },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    sleep,
    now,
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
    ...(opts.maxRetryWaitMs !== undefined ? { maxRetryWaitMs: opts.maxRetryWaitMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
  });

  const scope: Record<string, QueryValue> = opts.teamId
    ? { teamId: opts.teamId }
    : opts.teamSlug
      ? { slug: opts.teamSlug }
      : {};
  const authorization = async (): Promise<string> => `Bearer ${token}`;

  function call(req: Omit<RequestOptions, 'authorization'>): Promise<HttpResponse> {
    return http.request({
      ...req,
      query: { ...scope, ...req.query },
      authorization,
    });
  }

  /** Project id or name as one validated path segment. */
  function seg(value: string, what: string): string {
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(value) ||
      value.includes('..')
    ) {
      throw new ServiceError('vercel', 'invalid_input', `invalid ${what}`);
    }
    return encodeURIComponent(value);
  }

  // --- reads ---------------------------------------------------------------------------------

  async function listTeams(): Promise<VercelTeam[]> {
    const res = await http.request({ method: 'GET', path: '/v2/teams', authorization });
    const body = parseBody(
      z.object({
        teams: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
      }),
      res,
      'teams',
    );
    return body.teams;
  }

  async function listProjects(limit = 100): Promise<Array<{ id: string; name: string }>> {
    const res = await call({
      method: 'GET',
      path: '/v9/projects',
      query: { limit: Math.min(Math.max(1, limit), 100) },
    });
    const body = parseBody(
      z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
      res,
      'projects',
    );
    return body.projects;
  }

  async function getProject(nameOrId: string): Promise<VercelProject | null> {
    const res = await call({
      method: 'GET',
      path: `/v9/projects/${seg(nameOrId, 'project')}`,
      allowStatus: [404],
    });
    if (res.status === 404) return null;
    return toProject(parseBody(ProjectSchema, res, 'project'));
  }

  // --- project -------------------------------------------------------------------------------

  async function setProtection(projectId: string, protection: DeploymentProtection): Promise<void> {
    await call({
      method: 'PATCH',
      path: `/v9/projects/${seg(projectId, 'project')}`,
      // `ssoProtection: null` turns Vercel Authentication off.
      body: { ssoProtection: protection === 'none' ? null : { deploymentType: protection } },
      idempotent: true,
    });
  }

  async function ensureProject(input: {
    slug: string;
    protection?: DeploymentProtection;
  }): Promise<{ project: VercelProject; created: boolean }> {
    const name = projectNameForSlug(input.slug);
    const repoFull = `${githubOrg}/${repoNameForSlug(input.slug)}`;
    const protection = input.protection ?? 'none';

    let project = await getProject(name);
    let created = false;
    if (!project) {
      const res = await call({
        method: 'POST',
        path: '/v10/projects',
        // No `gitRepository`: deployments upload the commit's files (module comment).
        body: { name, framework: FRAMEWORK },
        // A replay after an ambiguous failure answers 409 (name taken), handled below.
        idempotent: true,
        allowStatus: [409],
      });
      if (res.status === 409) {
        project = await getProject(name);
        if (!project) {
          throw new ServiceError('vercel', 'conflict', `project name ${name} is unavailable`, {
            status: 409,
          });
        }
      } else {
        project = toProject(parseBody(ProjectSchema, res, 'created project'));
        created = true;
      }
    }

    // A git link is never needed (and never made); one made by earlier code must at least be the
    // client's own repo, otherwise this is not the project it claims to be.
    if (
      project.linkedRepo !== undefined &&
      project.linkedRepo.toLowerCase() !== repoFull.toLowerCase()
    ) {
      throw new ServiceError(
        'vercel',
        'conflict',
        `project ${name} is linked to a different repository than ${repoFull}`,
      );
    }
    // Before anything is pushed to the repo: no deployment may start from anything but the API.
    if (!project.gitDeploymentsDisabled) project = await disableGitDeployments(project.id);
    await setProtection(project.id, protection);
    if (project.productionDeploymentId === undefined) {
      project = (await installPlaceholder(project)).project;
    }
    // The placeholder turns the framework off for a moment: an earlier run that could not turn it
    // back (or anything else that changed it) is repaired here, on every run.
    if (project.framework !== FRAMEWORK) {
      await setFramework(project.id, FRAMEWORK);
      project = { ...project, framework: FRAMEWORK };
    }
    return { project, created };
  }

  function setFramework(projectId: string, framework: string | null): Promise<HttpResponse> {
    return call({
      method: 'PATCH',
      path: `/v9/projects/${seg(projectId, 'project')}`,
      body: { framework },
      idempotent: true,
    });
  }

  /**
   * Vercel makes the FIRST deployment of a project without git its production deployment, whatever
   * its target (checked on the API: `staging` too), and gives it the public `*.vercel.app` aliases.
   * The client's first preview would then be public before approval. So a new project first gets
   * a static placeholder in production; every later deployment without target is a real preview,
   * and a staged production one only goes public through the explicit promotion.
   *
   * The same page is deployed again by `restorePlaceholder` when a deployment that must stay
   * private took production anyway. On a project that already has deployments, Vercel may not
   * give production to the placeholder by itself: it is promoted explicitly when needed, and the
   * project is read back until its production deployment is the placeholder.
   */
  async function installPlaceholder(
    project: VercelProject,
  ): Promise<{ project: VercelProject; deploymentId: string }> {
    const content = Buffer.from(PLACEHOLDER_HTML, 'utf8');
    const digest = sha1Hex(content);
    await call({
      method: 'POST',
      path: '/v2/files',
      rawBody: { data: bytesOf(content), contentType: 'application/octet-stream' },
      headers: { 'x-vercel-digest': digest, 'content-length': String(content.byteLength) },
      idempotent: true,
      allowNonJsonResponse: true,
    });
    // The project's framework (nextjs) would make Vercel build the static page as a Next.js app
    // ("No Next.js version detected"), and a deployment's `projectSettings.framework: null` does not
    // override it: the project is set to no framework for the placeholder, then back (checked on
    // the API).
    await setFramework(project.id, null);
    let placeholderId: string | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const res = await call({
        method: 'POST',
        path: '/v13/deployments',
        query: { skipAutoDetectionConfirmation: '1' },
        body: {
          name: project.name,
          project: project.id,
          target: 'production',
          files: [{ file: 'index.html', sha: digest, size: content.byteLength }],
          meta: { forgePlaceholder: '1' },
        },
        // A replay only creates another identical static placeholder.
        idempotent: true,
      });
      const placeholder = toDeployment(parseBody(DeploymentSchema, res, 'placeholder deployment'));
      await waitForDeployment(placeholder.id, { timeoutMs: PLACEHOLDER_TIMEOUT_MS });
      placeholderId = placeholder.id;
    } catch (err) {
      failure = { error: err };
    }
    // Always put the framework back. When the placeholder itself failed, that failure is what
    // the caller gets; a failed restore is attached to it, never thrown in its place (the next
    // `ensureProject` repairs the framework).
    try {
      await setFramework(project.id, FRAMEWORK);
    } catch (restoreError) {
      if (failure === undefined) throw restoreError;
      attachCleanupFailure(failure.error, { what: 'framework restore', error: restoreError });
    }
    if (failure !== undefined) throw failure.error;
    if (placeholderId === undefined) {
      throw new ServiceError('vercel', 'unexpected', 'the placeholder deployment has no id');
    }
    // No-op when Vercel already gave it production (the first deployment of a project).
    await promoteToProduction(project.id, placeholderId, { timeoutMs: PLACEHOLDER_TIMEOUT_MS });
    const after = await getProject(project.id);
    if (!after || after.productionDeploymentId !== placeholderId) {
      throw new ServiceError(
        'vercel',
        'unexpected',
        `project ${project.name} is not served by the placeholder after its deployment`,
      );
    }
    return { project: after, deploymentId: placeholderId };
  }

  async function restorePlaceholder(projectId: string): Promise<{ deploymentId: string }> {
    const project = await getProject(projectId);
    if (!project) {
      throw new ServiceError('vercel', 'not_found', 'project not found', { status: 404 });
    }
    const { deploymentId } = await installPlaceholder(project);
    return { deploymentId };
  }

  async function disableGitDeployments(projectId: string): Promise<VercelProject> {
    await call({
      method: 'PATCH',
      path: `/v9/projects/${seg(projectId, 'project')}`,
      body: { deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY },
      idempotent: true,
    });
    // Read back: the stored policy is what counts, not the PATCH answer.
    const after = await getProject(projectId);
    if (!after) {
      throw new ServiceError('vercel', 'not_found', 'project not found', { status: 404 });
    }
    if (!after.gitDeploymentsDisabled) {
      throw new ServiceError(
        'vercel',
        'unexpected',
        `git-triggered deployments could not be turned off on project ${after.name}`,
      );
    }
    return after;
  }

  async function setEnv(
    projectId: string,
    vars: Record<string, string>,
  ): Promise<{ count: number }> {
    const entries = Object.entries(vars);
    if (entries.length === 0) return { count: 0 };
    const body = entries.map(([key, value]) => {
      const problem = projectEnvProblem(key, value);
      if (problem !== undefined) throw new ServiceError('vercel', 'invalid_input', problem);
      return { key, value, type: envTypeFor(key), target: ['production', 'preview'] };
    });
    const res = await call({
      method: 'POST',
      path: `/v10/projects/${seg(projectId, 'project')}/env`,
      query: { upsert: 'true' },
      body,
      idempotent: true,
    });
    const parsed = z
      .object({
        failed: z
          .array(z.object({ error: z.object({ key: z.string().optional() }).optional() }))
          .optional(),
      })
      .safeParse(res.json);
    const failed = parsed.success ? (parsed.data.failed ?? []) : [];
    if (failed.length > 0) {
      const keys = failed.map((f) => f.error?.key).filter((k): k is string => !!k);
      throw new ServiceError(
        'vercel',
        'validation',
        `Vercel rejected ${failed.length} environment variable(s)${keys.length ? `: ${keys.join(', ')}` : ''}`,
        { status: res.status },
      );
    }
    return { count: body.length };
  }

  async function pruneEnv(projectId: string): Promise<{ removed: string[] }> {
    const pid = seg(projectId, 'project');
    const res = await call({ method: 'GET', path: `/v10/projects/${pid}/env` });
    const parsed = parseBody(
      z.object({ envs: z.array(z.object({ id: z.string(), key: z.string() })) }),
      res,
      'environment variables',
    );
    const removed = new Set<string>();
    for (const e of parsed.envs) {
      if (PROJECT_ENV_ALLOWLIST.has(e.key)) continue;
      await call({
        method: 'DELETE',
        path: `/v9/projects/${pid}/env/${seg(e.id, 'environment variable')}`,
        allowStatus: [404],
      });
      removed.add(e.key);
    }
    return { removed: [...removed].sort() };
  }

  // --- deployments ---------------------------------------------------------------------------

  async function createDeployment(input: CreateDeploymentInput): Promise<VercelDeployment> {
    assertRepoNameLike(input.repo);
    encodeBranch(input.ref);
    if (input.sha !== undefined && !COMMIT_SHA_RE.test(input.sha)) {
      throw new ServiceError('vercel', 'invalid_input', 'invalid commit sha');
    }
    const projectId = input.project.id;
    seg(projectId, 'project');
    if (!source) {
      throw new ServiceError(
        'vercel',
        'invalid_input',
        'no repository source configured: deployments read the client repo through GitHub',
      );
    }
    const target = input.target === 'production' ? 'production' : 'preview';
    const production = target === 'production';
    const sha = input.sha ?? (await branchHead(source, input.repo, input.ref));

    // Idempotency rule (module comment): an earlier deployment of this commit, built with the
    // variables the project holds now, is reused. Unreadable variables: nothing is reused.
    const envSha = await readEnvFingerprint(projectId, target);
    const earlier = await findReusableDeployment(projectId, sha, target, envSha);
    if (earlier) {
      const reused = toDeployment(earlier);
      if (production && !FINAL_STATES.has(reused.readyState)) trackStaged(reused.id, projectId);
      return reused;
    }

    const prepared = await prepareFiles(source, input.repo, sha);
    const body: DeploymentRequest = {
      name: input.project.name,
      project: projectId,
      // A staged production deployment: built for production, but the production domains are
      // only assigned by the explicit promotion, after the caller's post-READY checks (the
      // launchpad may have been disabled, or deploys paused, while it was building). Same
      // field as `vercel deploy --prod --skip-domain` (the Vercel CLI sends it in this body).
      ...(production ? { target: 'production', autoAssignCustomDomains: false } : {}),
      files: prepared.entries,
      // As the project was created; install, build and output settings stay Vercel's defaults.
      projectSettings: { framework: FRAMEWORK },
      meta: {
        githubCommitSha: sha,
        githubCommitRef: input.ref,
        githubRepo: input.repo,
        githubOrg,
        // The variables this build reads; absent when they could not be read in full, so the
        // deployment is never reused.
        ...(envSha !== undefined ? { forgeEnvSha256: envSha } : {}),
      },
    };
    const created = await postDeployment(body, {
      source,
      repo: input.repo,
      projectId,
      sha,
      target,
      envSha,
      prepared,
    });
    const deployment = toDeployment(created);
    if (
      production &&
      created.autoAssignCustomDomains !== false &&
      !FINAL_STATES.has(deployment.readyState)
    ) {
      // Vercel did not confirm the staging (the echo says true, or nothing): once READY it could
      // take the production domains before the checks. Cancel it (best effort) and fail; the
      // caller alerts.
      await cancelDeployment(deployment.id).catch(() => undefined);
      throw new ServiceError(
        'vercel',
        'unexpected',
        `production deployment ${deployment.id} was not staged (Vercel did not confirm that the domains wait for the promotion)`,
      );
    }
    if (deployment.commitSha !== undefined && deployment.commitSha !== sha) {
      throw new ServiceError(
        'vercel',
        'unexpected',
        `deployment ${deployment.id} reports commit ${deployment.commitSha} instead of ${sha}`,
      );
    }
    // Fails closed: a deployment that does not say which project it belongs to is not ours.
    if (deployment.projectId !== projectId) {
      throw new ServiceError(
        'vercel',
        'unexpected',
        deployment.projectId === undefined
          ? `deployment ${deployment.id} does not report its project`
          : `deployment ${deployment.id} belongs to another project`,
      );
    }
    if (production && !FINAL_STATES.has(deployment.readyState)) {
      trackStaged(deployment.id, projectId);
    }
    return deployment;
  }

  /** Head commit of a branch of the client repo (a deployment requested without a sha). */
  async function branchHead(src: DeploymentSource, repo: string, ref: string): Promise<string> {
    const head = await src.getBranchHead(repo, ref);
    if (head === null) {
      throw new ServiceError('github', 'not_found', `branch ${ref} not found in ${repo}`, {
        status: 404,
      });
    }
    if (!COMMIT_SHA_RE.test(head)) {
      throw new ServiceError('github', 'invalid_response', 'invalid branch head');
    }
    return head;
  }

  // --- idempotency lookup --------------------------------------------------------------------

  /**
   * Fingerprint of the project variables a deployment of `target` is built with
   * (`projectEnvFingerprint`), or undefined when they cannot be read in full: an error (after the
   * HTTP client's retries), an unexpected answer or a list with another page. Fails closed without
   * failing the deployment: undefined means no earlier deployment is reused and the new one
   * records no fingerprint. Neither the values nor the list are logged or kept.
   */
  async function readEnvFingerprint(
    projectId: string,
    target: 'production' | 'preview',
  ): Promise<string | undefined> {
    let res: HttpResponse;
    try {
      res = await call({
        method: 'GET',
        path: `/v10/projects/${seg(projectId, 'project')}/env`,
        // Encrypted values come back in clear (the client projects only hold public ones, plus
        // the `sensitive` relay token, which Vercel never returns).
        query: { decrypt: 'true' },
      });
    } catch (err) {
      if (err instanceof ServiceError) return undefined;
      throw err;
    }
    const parsed = ProjectEnvListSchema.safeParse(res.json);
    if (!parsed.success) return undefined;
    const next = parsed.data.pagination?.next;
    if (next !== null && next !== undefined) return undefined;
    return projectEnvFingerprint(parsed.data.envs, target);
  }

  /**
   * Latest deployments of the project (of one target when given), filtered on one metadata value
   * when Vercel can.
   */
  async function listDeploymentsByMeta(
    projectId: string,
    target: 'production' | 'preview' | undefined,
    meta: { key: 'githubCommitSha' | 'forgeRequestId'; value: string },
  ): Promise<DeploymentListItem[]> {
    const query = {
      projectId,
      ...(target !== undefined ? { target } : {}),
      limit: REUSE_LOOKUP_LIMIT,
    };
    let res: HttpResponse;
    try {
      res = await call({
        method: 'GET',
        path: '/v6/deployments',
        // Metadata filter, as `vercel list --meta <key>=<value>` sends it.
        query: { ...query, [`meta-${meta.key}`]: meta.value },
      });
    } catch (err) {
      if (!(err instanceof ServiceError && err.kind === 'validation')) throw err;
      // The filter was refused: the latest deployments are checked one by one instead.
      res = await call({ method: 'GET', path: '/v6/deployments', query });
    }
    return parseBody(DeploymentListSchema, res, 'deployments').deployments;
  }

  /** Earlier deployments of the project for a target, filtered on the commit when Vercel can. */
  function listEarlierDeployments(
    projectId: string,
    sha: string,
    target: 'production' | 'preview',
  ): Promise<DeploymentListItem[]> {
    return listDeploymentsByMeta(projectId, target, { key: 'githubCommitSha', value: sha });
  }

  /**
   * The deployment one creation request made, found by its nonce (`meta.forgeRequestId`), read in
   * full; undefined when the bounded lookup finds none. Any target: the first deployment of a
   * project may come back as production whatever it asked for. It must carry the environment
   * fingerprint that request sent (`envSha`, absent when it sent none): always true of the
   * deployment of that very request, checked anyway like every other field read back.
   */
  async function findByRequestId(
    projectId: string,
    requestId: string,
    envSha: string | undefined,
  ): Promise<DeploymentBody | undefined> {
    for (let attempt = 0; attempt < REQUEST_LOOKUP_TRIES; attempt++) {
      if (attempt > 0) await sleep(REQUEST_LOOKUP_WAIT_MS);
      let checked = 0;
      const items = await listDeploymentsByMeta(projectId, undefined, {
        key: 'forgeRequestId',
        value: requestId,
      });
      for (const item of items) {
        const listed = item.meta?.forgeRequestId;
        if (listed !== undefined && listed !== requestId) continue;
        if (checked >= REUSE_MAX_CHECKS) break;
        checked++;
        const full = await getDeploymentBody(item.uid);
        if (
          full.meta?.forgeRequestId === requestId &&
          full.projectId === projectId &&
          full.meta.forgeEnvSha256 === envSha
        ) {
          return full;
        }
      }
    }
    return undefined;
  }

  /**
   * An earlier deployment of exactly this project, target and commit, built with the variables
   * whose fingerprint is `envSha`, that has not failed (and, for production, that is staged or
   * already finished), read in full; undefined when none, or when `envSha` is undefined (the
   * variables could not be read: no earlier deployment can be vouched for, none is looked up).
   */
  async function findReusableDeployment(
    projectId: string,
    sha: string,
    target: 'production' | 'preview',
    envSha: string | undefined,
  ): Promise<DeploymentBody | undefined> {
    if (envSha === undefined) return undefined;
    let checked = 0;
    for (const item of await listEarlierDeployments(projectId, sha, target)) {
      // Cheap pre-checks on the list entry, when it carries the fields.
      const state = (item.readyState ?? item.state ?? '').toUpperCase();
      if (state !== '' && !REUSABLE_STATES.has(state)) continue;
      if (item.meta?.githubCommitSha !== undefined && item.meta.githubCommitSha !== sha) continue;
      if (item.meta?.forgeEnvSha256 !== undefined && item.meta.forgeEnvSha256 !== envSha) continue;
      if (
        item.target !== undefined &&
        (item.target === 'production') !== (target === 'production')
      ) {
        continue;
      }
      if (checked >= REUSE_MAX_CHECKS) break;
      checked++;
      // The decision is made on the full record only.
      const full = await getDeploymentBody(item.uid);
      if (isReusable(full, projectId, sha, target, envSha)) return full;
    }
    return undefined;
  }

  function isReusable(
    d: DeploymentBody,
    projectId: string,
    sha: string,
    target: 'production' | 'preview',
    envSha: string,
  ): boolean {
    const state = d.readyState.toUpperCase();
    const view = toDeployment(d);
    return (
      REUSABLE_STATES.has(state) &&
      view.projectId === projectId &&
      view.commitSha === sha &&
      view.target === target &&
      // Built with the same variables; a deployment that recorded none (made before the rule, or
      // when the variables could not be read) never matches.
      d.meta?.forgeEnvSha256 === envSha &&
      // A production deployment still building is only adopted when Vercel confirms it is staged
      // (it would otherwise take the domains by itself once READY).
      !(target === 'production' && d.autoAssignCustomDomains !== false && state !== 'READY')
    );
  }

  // --- files ---------------------------------------------------------------------------------

  /** Body of a file deployment request (each request adds its own `meta.forgeRequestId`). */
  interface DeploymentRequest {
    name: string;
    project: string;
    target?: 'production';
    autoAssignCustomDomains?: false;
    files: PreparedFiles['entries'];
    projectSettings: { framework: string };
    meta: Record<string, string>;
  }

  interface PreparedFiles {
    /** The `files` of the deployment body. */
    entries: Array<{ file: string; sha: string; size: number; mode: number }>;
    /** Vercel digest -> git blob id, to read the bytes Vercel asks for. */
    blobOf: Map<string, string>;
    /** Contents read during this deployment, by git blob id. */
    contents: Map<string, Buffer>;
  }

  function rememberDigest(blobSha: string, digest: string, size: number): void {
    if (digests.has(blobSha)) return;
    if (digests.size >= DIGEST_CACHE_MAX) {
      const oldest = digests.keys().next();
      if (!oldest.done) digests.delete(oldest.value);
    }
    digests.set(blobSha, { digest, size });
  }

  /** Reads blobs and checks each against its id (whatever the source implementation). */
  async function readChecked(
    src: DeploymentSource,
    repo: string,
    blobShas: readonly string[],
  ): Promise<Map<string, Buffer>> {
    const read = await src.readBlobs(repo, blobShas, { maxBlobBytes: limits.maxFileBytes });
    const out = new Map<string, Buffer>();
    for (const blobSha of blobShas) {
      const content = read.get(blobSha);
      if (!content || gitBlobSha(content) !== blobSha) {
        throw new ServiceError('github', 'invalid_response', `blob ${blobSha} was not read intact`);
      }
      out.set(blobSha, content);
    }
    return out;
  }

  /** The file list of the commit, with the Vercel digest of every file. */
  async function prepareFiles(
    src: DeploymentSource,
    repo: string,
    sha: string,
  ): Promise<PreparedFiles> {
    const tree = await src.listCommitTree(repo, sha, limits);
    if (tree.commitSha !== sha) {
      throw new ServiceError('github', 'invalid_response', 'the tree of another commit was listed');
    }
    // Checked here too: the deployment limits hold whatever the source enforced.
    if (tree.files.length > limits.maxFiles) {
      throw new ServiceError(
        'vercel',
        'invalid_input',
        `too many files to deploy: ${tree.files.length} (max ${limits.maxFiles})`,
      );
    }
    let total = 0;
    const paths = new Set<string>();
    const known = new Map<string, { digest: string; size: number }>();
    for (const f of tree.files) {
      if (!isSafeTreePath(f.path) || paths.has(f.path) || !COMMIT_SHA_RE.test(f.blobSha)) {
        throw new ServiceError(
          'github',
          'invalid_response',
          `invalid file in the tree: ${JSON.stringify(f.path.slice(0, 120))}`,
        );
      }
      paths.add(f.path);
      if (f.size > limits.maxFileBytes) {
        throw new ServiceError(
          'vercel',
          'invalid_input',
          `file too large to deploy: ${JSON.stringify(f.path.slice(0, 120))} (${f.size} bytes, max ${limits.maxFileBytes})`,
        );
      }
      total += f.size;
      const cached = digests.get(f.blobSha);
      if (cached) known.set(f.blobSha, cached);
    }
    if (total > limits.maxTotalBytes) {
      throw new ServiceError(
        'vercel',
        'invalid_input',
        `files too large to deploy: ${total} bytes in total (max ${limits.maxTotalBytes})`,
      );
    }

    // Only blobs whose digest is not known yet are read now.
    const unknown = [...new Set(tree.files.map((f) => f.blobSha))].filter((b) => !known.has(b));
    const contents = unknown.length > 0 ? await readChecked(src, repo, unknown) : new Map();
    for (const [blobSha, content] of contents) {
      const entry = { digest: sha1Hex(content), size: content.byteLength };
      known.set(blobSha, entry);
      rememberDigest(blobSha, entry.digest, entry.size);
    }

    const entries: PreparedFiles['entries'] = [];
    const blobOf = new Map<string, string>();
    for (const f of tree.files) {
      const k = known.get(f.blobSha);
      if (!k || k.size !== f.size) {
        throw new ServiceError('github', 'invalid_response', 'listed size differs from the blob');
      }
      entries.push({
        file: f.path,
        sha: k.digest,
        size: f.size,
        mode: f.executable ? MODE_EXECUTABLE : MODE_REGULAR,
      });
      blobOf.set(k.digest, f.blobSha);
    }
    return { entries, blobOf, contents };
  }

  /** Uploads the files Vercel reported missing (each digest once), reading them if needed. */
  async function uploadMissing(
    src: DeploymentSource,
    repo: string,
    missing: readonly string[],
    prepared: PreparedFiles,
  ): Promise<void> {
    const wanted = [...new Set(missing)];
    const toRead: string[] = [];
    for (const digest of wanted) {
      const blobSha = prepared.blobOf.get(digest);
      if (blobSha === undefined) {
        throw new ServiceError(
          'vercel',
          'invalid_response',
          'Vercel asked for a file that is not part of the deployment',
        );
      }
      if (!prepared.contents.has(blobSha)) toRead.push(blobSha);
    }
    if (toRead.length > 0) {
      for (const [blobSha, content] of await readChecked(src, repo, toRead)) {
        prepared.contents.set(blobSha, content);
      }
    }
    await inPool(wanted, uploadConcurrency, async (digest) => {
      const content = prepared.contents.get(prepared.blobOf.get(digest) ?? '');
      if (!content || sha1Hex(content) !== digest) {
        throw new ServiceError('vercel', 'unexpected', 'file content does not match its digest');
      }
      await call({
        method: 'POST',
        path: '/v2/files',
        rawBody: { data: bytesOf(content), contentType: 'application/octet-stream' },
        headers: { 'x-vercel-digest': digest, 'content-length': String(content.byteLength) },
        // Content-addressed: a replay stores the same bytes under the same digest.
        idempotent: true,
        allowNonJsonResponse: true,
      });
    });
  }

  /**
   * `POST /v13/deployments`; on `missing_files`, uploads those files and retries once. Never
   * replayed blindly: every request carries its own nonce (`meta.forgeRequestId`); after an
   * ambiguous failure the deployment of that very request is looked up (a few reads, a moment
   * apart), then the idempotency lookup of the commit runs (same environment fingerprint), and
   * only then one more request.
   */
  async function postDeployment(
    body: DeploymentRequest,
    ctx: {
      source: DeploymentSource;
      repo: string;
      projectId: string;
      sha: string;
      target: 'production' | 'preview';
      /** Fingerprint recorded in `body.meta.forgeEnvSha256` (absent there when undefined). */
      envSha: string | undefined;
      prepared: PreparedFiles;
    },
  ): Promise<DeploymentBody> {
    const path = '/v13/deployments';
    let uploaded = false;
    let replayed = false;
    for (;;) {
      const requestId = randomBytes(16).toString('hex');
      let res: HttpResponse;
      try {
        res = await call({
          method: 'POST',
          path,
          // forceNew: Vercel's deduplication of similar deployments could answer with one of
          // another commit; reuse is decided by the lookup above, per commit.
          // skipAutoDetectionConfirmation: the framework is given, never asked back.
          query: { forceNew: '1', skipAutoDetectionConfirmation: '1' },
          body: { ...body, meta: { ...body.meta, forgeRequestId: requestId } },
          // Each accepted call creates a deployment: not replayed by the HTTP client on a 5xx.
          idempotent: false,
          allowStatus: CREATE_REFUSALS,
        });
      } catch (err) {
        if (!replayed && isAmbiguous(err)) {
          replayed = true;
          // The deployment may exist although its answer was lost: this request's own first
          // (it is what the answer would have been, checked like it by the caller).
          const mine = await findByRequestId(ctx.projectId, requestId, ctx.envSha);
          if (mine) return mine;
          const earlier = await findReusableDeployment(
            ctx.projectId,
            ctx.sha,
            ctx.target,
            ctx.envSha,
          );
          if (earlier) return earlier;
          continue;
        }
        throw err;
      }
      if (res.status >= 200 && res.status < 300) {
        return parseBody(DeploymentSchema, res, 'deployment');
      }
      const missing = missingFilesOf(res);
      if (missing === undefined) throw refusal('POST', path, res);
      if (uploaded) {
        throw new ServiceError(
          'vercel',
          'unexpected',
          `Vercel still reports ${missing.length} missing file(s) after the upload`,
          { status: res.status, apiCode: 'missing_files' },
        );
      }
      await uploadMissing(ctx.source, ctx.repo, missing, ctx.prepared);
      uploaded = true;
    }
  }

  async function getDeploymentBody(idOrUrl: string): Promise<DeploymentBody> {
    const res = await call({
      method: 'GET',
      path: `/v13/deployments/${seg(idOrUrl.replace(/^https?:\/\//, ''), 'deployment')}`,
    });
    return parseBody(DeploymentSchema, res, 'deployment');
  }

  async function getDeployment(idOrUrl: string): Promise<VercelDeployment> {
    return toDeployment(await getDeploymentBody(idOrUrl));
  }

  /**
   * A staged production deployment just became READY: the project's production must not point at
   * it yet (only the explicit promotion may move it there).
   */
  async function checkStillStaged(d: VercelDeployment): Promise<void> {
    const projectId = stagedProduction.get(d.id);
    if (projectId === undefined) return;
    const project = await getProject(projectId);
    if (!project) {
      throw new ServiceError('vercel', 'not_found', 'project not found', { status: 404 });
    }
    stagedProduction.delete(d.id);
    if (project.productionDeploymentId === d.id) {
      throw new ServiceError(
        'vercel',
        'unexpected',
        `production deployment ${d.id} took production before its promotion (it was not staged)`,
        { apiCode: PRODUCTION_NOT_STAGED },
      );
    }
  }

  async function waitForDeployment(id: string, w: WaitOptions = {}): Promise<VercelDeployment> {
    const timeoutMs = w.timeoutMs ?? 15 * 60_000;
    const pollMs = w.pollMs ?? 5_000;
    const deadline = now() + timeoutMs;
    for (;;) {
      const d = await getDeployment(id);
      if (d.readyState === 'READY') {
        await checkStillStaged(d);
        return d;
      }
      if (d.readyState === 'ERROR' || d.readyState === 'CANCELED' || d.readyState === 'DELETED') {
        stagedProduction.delete(d.id);
        const detail = d.errorMessage ? `: ${d.errorMessage.slice(0, 200)}` : '';
        throw new ServiceError(
          'vercel',
          'deployment_failed',
          `deployment ${d.id} ended in ${d.readyState}${detail}`,
          d.errorCode ? { apiCode: d.errorCode } : {},
        );
      }
      if (now() + pollMs > deadline) {
        throw new ServiceError(
          'vercel',
          'timeout',
          `deployment ${d.id} not ready after ${timeoutMs} ms`,
        );
      }
      await sleep(pollMs);
    }
  }

  async function cancelDeployment(id: string): Promise<void> {
    await call({
      method: 'PATCH',
      path: `/v12/deployments/${seg(id, 'deployment')}/cancel`,
      idempotent: true,
      // Already finished (or gone): nothing left to cancel.
      allowStatus: [400, 404, 409],
    });
  }

  async function promoteToProduction(
    projectId: string,
    deploymentId: string,
    w: WaitOptions = {},
  ): Promise<{ promoted: boolean }> {
    const timeoutMs = w.timeoutMs ?? 5 * 60_000;
    const pollMs = w.pollMs ?? 3_000;
    const deadline = now() + timeoutMs;

    const current = await getProject(projectId);
    if (!current) {
      throw new ServiceError('vercel', 'not_found', 'project not found', { status: 404 });
    }
    if (current.productionDeploymentId === deploymentId) return { promoted: false };

    const d = await getDeployment(deploymentId);
    if (d.readyState !== 'READY') {
      throw new ServiceError(
        'vercel',
        'invalid_input',
        `deployment ${d.id} is ${d.readyState}, only READY deployments can be promoted`,
      );
    }
    await call({
      method: 'POST',
      path: `/v10/projects/${seg(projectId, 'project')}/promote/${seg(deploymentId, 'deployment')}`,
      idempotent: true,
    });
    for (;;) {
      const p = await getProject(projectId);
      if (p?.productionDeploymentId === deploymentId) return { promoted: true };
      if (now() + pollMs > deadline) {
        throw new ServiceError(
          'vercel',
          'timeout',
          `promotion of ${deploymentId} not applied in time`,
        );
      }
      await sleep(pollMs);
    }
  }

  // --- domains -------------------------------------------------------------------------------

  async function attachSubdomain(projectId: string, slug: string): Promise<DomainResult> {
    if (!opts.clientsDomain) {
      throw new ServiceError('vercel', 'invalid_input', 'clients domain is not configured');
    }
    const domain = subdomainFor(slug, opts.clientsDomain);
    const pid = seg(projectId, 'project');

    // Whether the name's DNS actually points at Vercel; any doubt counts as not configured.
    const dnsConfigured = async (): Promise<boolean> => {
      const res = await call({
        method: 'GET',
        path: `/v6/domains/${encodeURIComponent(domain)}/config`,
        allowStatus: [400, 403, 404],
      });
      if (res.status !== 200) return false;
      try {
        return parseBody(DomainConfigSchema, res, 'domain config').misconfigured === false;
      } catch {
        return false;
      }
    };
    const toResult = async (
      body: z.infer<typeof DomainSchema>,
      created: boolean,
    ): Promise<DomainResult> => {
      // The answer must be about exactly the domain asked for: its name (and verification) is
      // recorded as the site's host, so nothing Vercel says about another name is taken.
      if (body.name !== domain) {
        throw new ServiceError(
          'vercel',
          'invalid_response',
          `Vercel answered for another domain than ${domain}`,
        );
      }
      return {
        domain,
        verified: body.verified && (await dnsConfigured()),
        verification: body.verification ?? [],
        created,
      };
    };

    const existing = await call({
      method: 'GET',
      path: `/v9/projects/${pid}/domains/${encodeURIComponent(domain)}`,
      allowStatus: [404],
    });
    if (existing.status !== 404)
      return toResult(parseBody(DomainSchema, existing, 'domain'), false);

    const res = await call({
      method: 'POST',
      path: `/v10/projects/${pid}/domains`,
      body: { name: domain },
      idempotent: true,
      allowStatus: [409],
    });
    if (res.status === 409) {
      // Either a replay (now attached to this project) or the name belongs to another project.
      const again = await call({
        method: 'GET',
        path: `/v9/projects/${pid}/domains/${encodeURIComponent(domain)}`,
        allowStatus: [404],
      });
      if (again.status === 404) {
        throw new ServiceError(
          'vercel',
          'conflict',
          `domain ${domain} is used by another project`,
          {
            status: 409,
          },
        );
      }
      return toResult(parseBody(DomainSchema, again, 'domain'), false);
    }
    return toResult(parseBody(DomainSchema, res, 'domain'), true);
  }

  async function listProductionHosts(
    projectId: string,
    deploymentId: string,
    w: WaitOptions = {},
  ): Promise<string[]> {
    seg(projectId, 'project');
    seg(deploymentId, 'deployment');
    const pollMs = w.pollMs ?? 3_000;
    const deadline = now() + (w.timeoutMs ?? 0);
    for (;;) {
      const hosts = await readProductionHosts(projectId, deploymentId);
      // Right after a promotion Vercel may still be moving the aliases to the new deployment.
      if (hosts.length > 0 || now() + pollMs > deadline) return hosts;
      await sleep(pollMs);
    }
  }

  async function readProductionHosts(projectId: string, deploymentId: string): Promise<string[]> {
    const hosts = new Set<string>();
    let until: number | undefined;
    for (let page = 0; page < ALIAS_MAX_PAGES; page++) {
      const res = await call({
        method: 'GET',
        path: '/v4/aliases',
        query: { projectId, limit: ALIAS_PAGE_LIMIT, until },
      });
      const body = parseBody(AliasListSchema, res, 'aliases');
      for (const a of body.aliases) {
        // The `projectId` filter is Vercel's; the ownership check is ours, on every record: an
        // alias of another project (a look-alike name) or of another deployment never counts.
        if (a.projectId !== projectId || a.deploymentId !== deploymentId) continue;
        if (a.redirect !== null && a.redirect !== undefined) continue;
        const host = a.alias.toLowerCase();
        if (isSiteHost(host)) hosts.add(host);
      }
      const next = body.pagination?.next;
      if (typeof next !== 'number' || next === until) break;
      until = next;
    }
    return [...hosts].sort();
  }

  async function detachDomain(projectId: string, domain: string): Promise<boolean> {
    assertClientsDomain(domain);
    const res = await call({
      method: 'DELETE',
      path: `/v9/projects/${seg(projectId, 'project')}/domains/${encodeURIComponent(domain)}`,
      allowStatus: [404],
    });
    return res.status !== 404;
  }

  // --- disable / delete ----------------------------------------------------------------------

  async function pauseProject(projectId: string): Promise<void> {
    await call({
      method: 'POST',
      path: `/v1/projects/${seg(projectId, 'project')}/pause`,
      idempotent: true,
    });
  }

  async function unpauseProject(projectId: string): Promise<void> {
    await call({
      method: 'POST',
      path: `/v1/projects/${seg(projectId, 'project')}/unpause`,
      idempotent: true,
    });
  }

  async function deleteProject(idOrName: string): Promise<boolean> {
    const res = await call({
      method: 'DELETE',
      path: `/v9/projects/${seg(idOrName, 'project')}`,
      allowStatus: [404],
    });
    return res.status !== 404;
  }

  return {
    listTeams,
    listProjects,
    getProject,
    ensureProject,
    setProtection,
    setEnv,
    pruneEnv,
    disableGitDeployments,
    createDeployment,
    getDeployment,
    waitForDeployment,
    cancelDeployment,
    restorePlaceholder,
    promoteToProduction,
    attachSubdomain,
    listProductionHosts,
    detachDomain,
    pauseProject,
    unpauseProject,
    deleteProject,
  };
}

/** Vercel's file digest: sha1 of the content, hex. */
function sha1Hex(content: Uint8Array): string {
  return createHash('sha1').update(content).digest('hex');
}

/** The bytes of a Buffer as a plain view (no copy). */
function bytesOf(content: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);
}

/** A failure after which the request may or may not have been processed. */
function isAmbiguous(err: unknown): boolean {
  return (
    err instanceof ServiceError &&
    (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'server')
  );
}

/** Digests listed by a `missing_files` refusal; undefined for any other answer. */
function missingFilesOf(res: HttpResponse): string[] | undefined {
  const parsed = MissingFilesSchema.safeParse(res.json);
  if (!parsed.success) return undefined;
  const missing = parsed.data.error.missing ?? [];
  if (missing.length === 0 || missing.some((d) => !DIGEST_RE.test(d))) {
    throw new ServiceError(
      'vercel',
      'invalid_response',
      'Vercel reported missing files without valid digests',
      { status: res.status, apiCode: 'missing_files' },
    );
  }
  return missing;
}

/** A refused request returned through `allowStatus`, as the HTTP client would have thrown it. */
function refusal(method: string, path: string, res: HttpResponse): ServiceError {
  const api = readApiError(res.json);
  const detail = api.message ? `: ${redactSecrets(api.message).slice(0, 200)}` : '';
  return new ServiceError(
    'vercel',
    res.status === 400 || res.status === 422 ? 'validation' : 'unexpected',
    `vercel ${method} ${path} failed with ${res.status}${detail}`,
    { status: res.status, ...(api.code !== undefined ? { apiCode: api.code } : {}) },
  );
}

function assertRepoNameLike(repo: string): void {
  if (typeof repo !== 'string' || !/^lp-[a-z0-9]+(-[a-z0-9]+)*$/.test(repo)) {
    throw new ServiceError('vercel', 'invalid_input', 'invalid repository name');
  }
}
