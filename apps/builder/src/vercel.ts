/// <reference types="node" />
import { TEMPLATE_ENV } from '@forge/shared';
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

/**
 * Vercel client (REST over fetch).
 *
 * Model: one Vercel project per client, linked to the client's GitHub repo (the Vercel GitHub app
 * must be installed on the org). Deployments are created explicitly from a git ref, so the builder
 * controls when a preview exists; the same preview is later promoted to production without a rebuild
 * (docs/INTERFACES.md section 4: preview_ready -> deploying -> live).
 */

const DEFAULT_API_URL = 'https://api.vercel.com';
const FRAMEWORK = 'nextjs';

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

/**
 * Variables a client project may receive: what the template needs (shared `TEMPLATE_ENV`) plus the
 * pool config key derived from the on-chain setup, the RPC relay origin, and the read-only token
 * Vercel needs to install `@forge/core` from the GitHub Packages registry.
 */
export const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...TEMPLATE_ENV,
  'POOL_CONFIG_KEY',
  'NEXT_PUBLIC_POOL_CONFIG_KEY',
  'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
  'GITHUB_PACKAGES_TOKEN',
]);

/** Variables that are public by nature (addresses, cluster, `NEXT_PUBLIC_*`, bucket name). */
const PLAIN_ENV: ReadonlySet<string> = new Set([
  'SOLANA_CLUSTER',
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'R2_BUCKET',
  'POOL_CONFIG_KEY',
]);

export type ProjectEnvType = 'plain' | 'sensitive';

export function envTypeFor(key: string): ProjectEnvType {
  return PLAIN_ENV.has(key) || key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'sensitive';
}

/**
 * Picks the allowed variables out of `source` (for example `process.env`). Missing ones are
 * reported rather than silently dropped, so a half-configured project is never deployed.
 */
export function pickProjectEnv(
  source: Record<string, string | undefined>,
  required: readonly string[] = TEMPLATE_ENV,
): { vars: Record<string, string>; missing: string[] } {
  const vars: Record<string, string> = {};
  for (const key of PROJECT_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === 'string' && v !== '') vars[key] = v;
  }
  const missing = required.filter((k) => vars[k] === undefined);
  return { vars, missing };
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
  /** Creates the project for a slug (linked to its repo) or reuses it; applies protection. */
  ensureProject(input: {
    slug: string;
    protection?: DeploymentProtection;
  }): Promise<{ project: VercelProject; created: boolean }>;
  setProtection(projectId: string, protection: DeploymentProtection): Promise<void>;
  /** Upserts environment variables (allowlist only). Idempotent. */
  setEnv(projectId: string, vars: Record<string, string>): Promise<{ count: number }>;
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
});
const DeploymentSchema = z.object({
  id: z.string(),
  url: z.string().default(''),
  readyState: z.string(),
  target: z.string().nullish(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
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
  };
}

function toDeployment(d: z.infer<typeof DeploymentSchema>): VercelDeployment {
  const state = d.readyState.toUpperCase();
  const url = d.url.startsWith('http') ? d.url : d.url ? `https://${d.url}` : '';
  return {
    id: d.id,
    url,
    readyState: (READY_STATES.has(state) ? state : 'QUEUED') as ReadyState,
    target: d.target === 'production' ? 'production' : 'preview',
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
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
    await setProtection(project.id, protection);
    return { project, created };
  }

  async function setEnv(
    projectId: string,
    vars: Record<string, string>,
  ): Promise<{ count: number }> {
    const entries = Object.entries(vars);
    if (entries.length === 0) return { count: 0 };
    const body = entries.map(([key, value]) => {
      if (!PROJECT_ENV_ALLOWLIST.has(key)) {
        throw new ServiceError(
          'vercel',
          'invalid_input',
          `environment variable not allowed: ${key.slice(0, 60)}`,
        );
      }
      if (typeof value !== 'string' || value === '') {
        throw new ServiceError('vercel', 'invalid_input', `empty value for ${key}`);
      }
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

  // --- deployments ---------------------------------------------------------------------------

  async function createDeployment(input: CreateDeploymentInput): Promise<VercelDeployment> {
    assertRepoNameLike(input.repo);
    encodeBranch(input.ref);
    if (input.sha !== undefined && !/^[0-9a-f]{40}$/.test(input.sha)) {
      throw new ServiceError('vercel', 'invalid_input', 'invalid commit sha');
    }
    const res = await call({
      method: 'POST',
      path: '/v13/deployments',
      // No forceNew: for an identical commit Vercel returns the existing deployment, so a replay
      // is harmless.
      body: {
        name: input.project.name,
        project: input.project.id,
        ...(input.target === 'production' ? { target: 'production' } : {}),
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
    return toDeployment(parseBody(DeploymentSchema, res, 'deployment'));
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
