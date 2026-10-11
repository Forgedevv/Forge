/// <reference types="node" />
import { z } from 'zod';
import { assertDeployableSlug, encodeBranch, repoNameForSlug } from './github.js';
import {
  createHttpClient,
  ServiceError,
  type HttpClient,
  type HttpResponse,
  type QueryValue,
  type RequestOptions,
  type RetryEvent,
} from './http.js';
import {
  RELAY_TOKEN_ENV,
  RELAY_TOKEN_RE,
  RELAY_TOKEN_SECRET_ENV,
  rpcRelayToken,
} from './relay-token.js';

/**
 * Vercel client (REST over fetch).
 *
 * Model: one Vercel project per client, linked to the client's GitHub repo (the Vercel GitHub app
 * must be installed on the org). Deployments are created explicitly from a git ref, so the builder
 * controls when a preview exists; the same preview is later promoted to production without a rebuild
 * (docs/INTERFACES.md section 4: preview_ready -> deploying -> live).
 *
 * Git-triggered deployments are turned off on every project (`ensureProject`): otherwise a push of
 * `forge/<jobId>` would build a second, uncontrolled preview, and the merge into `main` would ship
 * to production on its own, bypassing the promotion step. Mechanism: the project deployment policy
 * (`PATCH /v9/projects/{id}` with `deploymentPolicy.deploymentSources`) allows only the `rest-api`
 * source in production and preview; per the Vercel API reference, `git` is "git provider webhook"
 * and `rest-api` is "direct user/team-token REST upload". The policy is read back and verified; a
 * project where it does not hold is refused. Not to be confused with
 * `gitProviderOptions.createDeployments`, which only controls the GitHub "deployment" objects the
 * Vercel bot posts, not whether Vercel builds on push. Defence in depth: the client repo should
 * also carry `vercel.json` with `{ "git": { "deploymentEnabled": false } }` (documented Vercel
 * setting that turns off automatic deployments for all branches).
 */

const DEFAULT_API_URL = 'https://api.vercel.com';
const FRAMEWORK = 'nextjs';

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
 * `GITHUB_PACKAGES_TOKEN`, `RPC_RELAY_TOKEN_SECRET`, or any other credential. RPC traffic goes
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
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
  'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
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
  RELAY_TOKEN_SECRET_ENV,
]);

/** Variables a client project cannot work without (the pool config key is added per launchpad). */
export const PROJECT_ENV_REQUIRED: readonly string[] = [
  'SOLANA_CLUSTER',
  'NEXT_PUBLIC_SOLANA_CLUSTER',
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
  'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
  'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
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
  FORGE_MULTISIG_VAULT: (v) => BASE58_ADDRESS.test(v),
  FORGE_METEORA_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  FORGE_PLATFORM_FEE_WALLET: (v) => BASE58_ADDRESS.test(v),
  FORGE_JUPITER_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET: (v) => BASE58_ADDRESS.test(v),
  NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT: (v) => BASE58_ADDRESS.test(v),
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

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface VercelClientOptions {
  /** API token. Never log it. */
  token: string;
  /** Team id (`team_...`), preferred over `teamSlug`. */
  teamId?: string;
  teamSlug?: string;
  /** GitHub organization owning the client repos (projects are linked as `<org>/<repo>`). */
  githubOrg: string;
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
  /** `<org>/<repo>` when linked to a GitHub repository. */
  linkedRepo: string | undefined;
  /** Id of the deployment currently serving production, if any. */
  productionDeploymentId: string | undefined;
  paused: boolean;
  /**
   * True when the project deployment policy only lets the REST API deploy (no git webhook
   * deployment) in both production and preview.
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
  /** Git commit the deployment was built from (`gitSource.sha`, else `meta.githubCommitSha`). */
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
  verified: boolean;
  /** DNS records to add when the domain is not verified yet. */
  verification: Array<{ type: string; domain: string; value: string }>;
  created: boolean;
}

export interface CreateDeploymentInput {
  project: { id: string; name: string };
  /** Repo name (`lp-<slug>`) in the configured GitHub org. */
  repo: string;
  /** Git ref to build, for example `forge/<jobId>` or `main`. */
  ref: string;
  /** Commit sha to build; recommended: makes the call idempotent per commit. */
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
   * Creates the project for a slug (linked to its repo) or reuses it; turns off git-triggered
   * deployments (verified) and applies protection.
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
   * Creates a deployment from a git ref. A production one is staged: it never takes the
   * production domains by itself, only `promoteToProduction` does (after the caller's checks).
   */
  createDeployment(input: CreateDeploymentInput): Promise<VercelDeployment>;
  getDeployment(idOrUrl: string): Promise<VercelDeployment>;
  /** Polls until READY; throws `deployment_failed` on ERROR/CANCELED and `timeout` past the deadline. */
  waitForDeployment(id: string, opts?: WaitOptions): Promise<VercelDeployment>;
  /** Promotes a READY preview to production (no rebuild) and waits until it serves production. */
  promoteToProduction(
    projectId: string,
    deploymentId: string,
    opts?: WaitOptions,
  ): Promise<{ promoted: boolean }>;
  /** Attaches `<slug>.<clientsDomain>` to the project. Idempotent. */
  attachSubdomain(projectId: string, slug: string): Promise<DomainResult>;
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
  meta: z.object({ githubCommitSha: z.string().optional() }).nullish(),
  /** Echo of the create option ("applies to custom domains only, defaults to `true`"). */
  autoAssignCustomDomains: z.boolean().nullish(),
});

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const DomainSchema = z.object({
  name: z.string(),
  verified: z.boolean(),
  verification: z
    .array(z.object({ type: z.string(), domain: z.string(), value: z.string() }))
    .optional(),
});

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
  return {
    id: p.id,
    name: p.name,
    linkedRepo,
    productionDeploymentId: p.targets?.production?.id ?? undefined,
    paused: p.paused === true,
    gitDeploymentsDisabled: apiOnlyPolicyHolds(p.deploymentPolicy?.deploymentSources ?? []),
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

function toDeployment(d: z.infer<typeof DeploymentSchema>): VercelDeployment {
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
        body: {
          name,
          framework: FRAMEWORK,
          gitRepository: { type: 'github', repo: repoFull },
        },
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

    if (project.linkedRepo === undefined) {
      const res = await call({
        method: 'POST',
        path: `/v9/projects/${seg(project.id, 'project')}/link`,
        body: { type: 'github', repo: repoFull },
        idempotent: true,
      });
      project = toProject(parseBody(ProjectSchema, res, 'linked project'));
    }
    if (project.linkedRepo?.toLowerCase() !== repoFull.toLowerCase()) {
      throw new ServiceError(
        'vercel',
        'conflict',
        `project ${name} is linked to a different repository than ${repoFull}`,
      );
    }
    // Before anything is pushed to the repo: no deployment may start from a git push.
    if (!project.gitDeploymentsDisabled) project = await disableGitDeployments(project.id);
    await setProtection(project.id, protection);
    return { project, created };
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
    if (input.sha !== undefined && !/^[0-9a-f]{40}$/.test(input.sha)) {
      throw new ServiceError('vercel', 'invalid_input', 'invalid commit sha');
    }
    const production = input.target === 'production';
    const res = await call({
      method: 'POST',
      path: '/v13/deployments',
      // No forceNew: for an identical commit Vercel returns the existing deployment, so a replay
      // is harmless.
      body: {
        name: input.project.name,
        project: input.project.id,
        // A staged production deployment: built for production, but the production domains are
        // only assigned by the explicit promotion, after the caller's post-READY checks (the
        // launchpad may have been disabled, or deploys paused, while it was building). Same
        // field as `vercel deploy --prod --skip-domain` (the Vercel CLI sends it in this body).
        ...(production ? { target: 'production', autoAssignCustomDomains: false } : {}),
        gitSource: {
          type: 'github',
          org: githubOrg,
          repo: input.repo,
          ref: input.ref,
          ...(input.sha ? { sha: input.sha } : {}),
        },
      },
      idempotent: true,
    });
    const body = parseBody(DeploymentSchema, res, 'deployment');
    const deployment = toDeployment(body);
    if (
      production &&
      body.autoAssignCustomDomains === true &&
      !FINAL_STATES.has(deployment.readyState)
    ) {
      // Vercel did not stage it: once READY it would take the production domains before the
      // checks. Cancel it (best effort) and fail; the caller alerts.
      await call({
        method: 'PATCH',
        path: `/v12/deployments/${seg(deployment.id, 'deployment')}/cancel`,
        idempotent: true,
        allowStatus: [400, 404, 409],
      }).catch(() => undefined);
      throw new ServiceError(
        'vercel',
        'unexpected',
        `production deployment ${deployment.id} was not staged (domains would be assigned automatically)`,
      );
    }
    return deployment;
  }

  async function getDeployment(idOrUrl: string): Promise<VercelDeployment> {
    const res = await call({
      method: 'GET',
      path: `/v13/deployments/${seg(idOrUrl.replace(/^https?:\/\//, ''), 'deployment')}`,
    });
    return toDeployment(parseBody(DeploymentSchema, res, 'deployment'));
  }

  async function waitForDeployment(id: string, w: WaitOptions = {}): Promise<VercelDeployment> {
    const timeoutMs = w.timeoutMs ?? 15 * 60_000;
    const pollMs = w.pollMs ?? 5_000;
    const deadline = now() + timeoutMs;
    for (;;) {
      const d = await getDeployment(id);
      if (d.readyState === 'READY') return d;
      if (d.readyState === 'ERROR' || d.readyState === 'CANCELED' || d.readyState === 'DELETED') {
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

    const toResult = (body: z.infer<typeof DomainSchema>, created: boolean): DomainResult => ({
      domain: body.name,
      verified: body.verified,
      verification: body.verification ?? [],
      created,
    });

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
    promoteToProduction,
    attachSubdomain,
    detachDomain,
    pauseProject,
    unpauseProject,
    deleteProject,
  };
}

function assertRepoNameLike(repo: string): void {
  if (typeof repo !== 'string' || !/^lp-[a-z0-9]+(-[a-z0-9]+)*$/.test(repo)) {
    throw new ServiceError('vercel', 'invalid_input', 'invalid repository name');
  }
}
