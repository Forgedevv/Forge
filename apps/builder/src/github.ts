/// <reference types="node" />
import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createHttpClient,
  ServiceError,
  type HttpClient,
  type HttpResponse,
  type RetryEvent,
} from './http.js';

/**
 * GitHub App client (REST over fetch, no Octokit).
 *
 * Auth: JWT (RS256) signed with the App private key -> installation access token. Tokens are cached
 * until shortly before they expire. Repository operations use a token scoped to the single client
 * repo with the minimum permission set (contents:write), as required by docs/SECURITY.md section 3;
 * only repo creation and branch protection use a wider token.
 */

const API_VERSION = '2022-11-28';
const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_TEMPLATE_REPO = 'launchpad-template';
/** Prefix of every client repository, so a slug can never collide with an org repo like "forge". */
export const REPO_PREFIX = 'lp-';
const TOKEN_REFRESH_MARGIN_MS = 2 * 60_000;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;
const COMPARE_PAGE_SIZE = 100;
const COMPARE_MAX_FILES = 3000;

// ---------------------------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------------------------

/**
 * Stricter than the shared `Slug` regex: the slug becomes a repo name, a Vercel project name and a
 * DNS label, so it cannot start or end with a dash nor contain a double dash.
 */
export function assertDeployableSlug(slug: string): void {
  if (
    typeof slug !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) ||
    slug.includes('--')
  ) {
    throw new ServiceError(
      'github',
      'invalid_input',
      'slug must be 3 to 32 characters: lowercase letters, digits and single dashes, not starting or ending with a dash',
    );
  }
}

/** Repo (and Vercel project) name derived from a launchpad slug. */
export function repoNameForSlug(slug: string): string {
  assertDeployableSlug(slug);
  return `${REPO_PREFIX}${slug}`;
}

function assertRepoName(name: string): void {
  if (typeof name !== 'string' || !/^lp-[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 35) {
    throw new ServiceError('github', 'invalid_input', 'invalid client repository name');
  }
}

/** Validates a git branch name and returns it URL-encoded per segment (slashes kept). */
export function encodeBranch(branch: string): string {
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 100 ||
    !/^[A-Za-z0-9._\-/]+$/.test(branch) ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.split('/').some((seg) => seg.startsWith('.'))
  ) {
    throw new ServiceError('github', 'invalid_input', `invalid branch name`);
  }
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** Validates a repository-relative file path. Returns it unchanged. */
export function assertRepoPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 500) {
    throw new ServiceError('github', 'invalid_input', 'invalid file path');
  }
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    throw new ServiceError('github', 'invalid_input', `invalid file path: ${path.slice(0, 80)}`);
  }
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || seg.toLowerCase() === '.git') {
      throw new ServiceError('github', 'invalid_input', `invalid file path: ${path.slice(0, 80)}`);
    }
  }
  return path;
}

/** Git blob object id of a file content (sha1 of "blob <len>\0<content>"). */
export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// App JWT
// ---------------------------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds the short-lived RS256 JWT that authenticates the App itself (max 10 minutes). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // iat is backdated by 60 s to tolerate clock drift, as recommended by GitHub.
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface GithubClientOptions {
  appId: string;
  /** PEM contents. Never log it. */
  privateKey: string;
  org: string;
  templateRepo?: string;
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
  GITHUB_APP_ID: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'invalid GITHUB_APP_ID'),
  GITHUB_ORG: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'invalid GITHUB_ORG'),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_TEMPLATE_REPO: z.string().min(1).optional(),
});

/**
 * Reads the GitHub settings from an env-like object. The key comes from `GITHUB_APP_PRIVATE_KEY_PATH`
 * (a file) or, failing that, `GITHUB_APP_PRIVATE_KEY` (inline PEM, `\n` escapes accepted).
 */
export function githubOptionsFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Pick<GithubClientOptions, 'appId' | 'privateKey' | 'org' | 'templateRepo'> {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new ServiceError('github', 'invalid_input', `invalid GitHub environment: ${names}`);
  }
  const e = parsed.data;
  let privateKey: string | undefined;
  if (e.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFile(e.GITHUB_APP_PRIVATE_KEY_PATH);
    } catch (cause) {
      throw new ServiceError('github', 'invalid_input', 'cannot read GITHUB_APP_PRIVATE_KEY_PATH', {
        cause,
      });
    }
  } else if (e.GITHUB_APP_PRIVATE_KEY) {
    privateKey = e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
    throw new ServiceError(
      'github',
      'invalid_input',
      'GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY must provide a PEM private key',
    );
  }
  return {
    appId: e.GITHUB_APP_ID,
    privateKey,
    org: e.GITHUB_ORG,
    ...(e.GITHUB_TEMPLATE_REPO ? { templateRepo: e.GITHUB_TEMPLATE_REPO } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface RepoInfo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  /** Full name of the template the repo was generated from, if any. */
  templateFullName: string | undefined;
  isTemplate: boolean;
}

export interface RepoFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  content: Uint8Array | string;
  /** Sets the executable bit (mode 100755). */
  executable?: boolean;
}

export interface CommitFilesInput {
  repo: string;
  /** Branch to commit to. Created from `baseBranch` when it does not exist. */
  branch: string;
  /** Defaults to the repository default branch. */
  baseBranch?: string;
  message: string;
  files: readonly RepoFile[];
  /** Paths to remove (ignored when they do not exist). */
  deletePaths?: readonly string[];
  /** When true, every file of the base tree that is absent from `files` is deleted (workdir mirror). */
  deleteMissing?: boolean;
}

export interface CommitFilesResult {
  /** False when the tree already matched: nothing was written except, maybe, a new branch ref. */
  committed: boolean;
  /** Head of the branch after the call. */
  commitSha: string;
  treeSha: string;
  branchCreated: boolean;
  changedPaths: string[];
  deletedPaths: string[];
}

export type CompareFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface CompareFile {
  path: string;
  status: CompareFileStatus;
  previousPath: string | undefined;
  additions: number;
  deletions: number;
  /** Unified diff of the file; absent for binary or very large files. */
  patch: string | undefined;
  sha: string;
}

export interface CompareResult {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  mergeBaseSha: string;
  headSha: string;
  files: CompareFile[];
}

export interface RepoToken {
  token: string;
  expiresAt: number;
}

export interface MergeResult {
  /** False when the head was already contained in the base (nothing to do). */
  merged: boolean;
  /** Merge commit sha, or the current base head when nothing was merged. */
  sha: string;
}

export interface ProtectionResult {
  applied: boolean;
  /** Why it was not applied: the private-repo plan does not offer it, or the App lacks the permission. */
  reason?: 'plan' | 'permission';
}

export interface GithubClient {
  /** Reads the App installation on the org (read-only). */
  getInstallation(): Promise<{
    id: number;
    repositorySelection: string;
    permissions: Record<string, string>;
  }>;
  getTemplateRepo(): Promise<RepoInfo>;
  getRepo(repo: string): Promise<RepoInfo | null>;
  /** Creates `lp-<slug>` privately from the template, or returns the existing one. */
  ensureRepoFromTemplate(input: {
    slug: string;
    description?: string;
  }): Promise<{ repo: RepoInfo; created: boolean }>;
  protectDefaultBranch(repo: string, branch?: string): Promise<ProtectionResult>;
  getBranchHead(repo: string, branch: string): Promise<string | null>;
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>;
  compareCommits(repo: string, base: string, head: string): Promise<CompareResult>;
  /** Reads a text file at a ref; null when absent. */
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  mergeBranch(
    repo: string,
    input: { base: string; head: string; message: string },
  ): Promise<MergeResult>;
  deleteBranch(repo: string, branch: string): Promise<boolean>;
  /** Installation token limited to one repo with contents:write only. */
  createRepoToken(repo: string): Promise<RepoToken>;
}

// ---------------------------------------------------------------------------------------------
// Response schemas (only what we read)
// ---------------------------------------------------------------------------------------------

const RepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
  is_template: z.boolean().optional(),
  template_repository: z.object({ full_name: z.string() }).nullish(),
});
const InstallationSchema = z.object({
  id: z.number(),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
});
const TokenSchema = z.object({ token: z.string().min(1), expires_at: z.string() });
const RefSchema = z.object({ object: z.object({ sha: z.string() }) });
const CommitSchema = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) });
const ShaSchema = z.object({ sha: z.string() });
const TreeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }),
  ),
});
const CompareSchema = z.object({
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  ahead_by: z.number(),
  behind_by: z.number(),
  total_commits: z.number(),
  merge_base_commit: z.object({ sha: z.string() }),
  commits: z.array(z.object({ sha: z.string() })).optional(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        previous_filename: z.string().optional(),
        additions: z.number().default(0),
        deletions: z.number().default(0),
        patch: z.string().optional(),
        sha: z.string().default(''),
      }),
    )
    .optional(),
});
const ContentSchema = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

function parseBody<S extends z.ZodType>(schema: S, res: HttpResponse, what: string): z.infer<S> {
  const parsed = schema.safeParse(res.json);
  if (!parsed.success) {
    throw new ServiceError('github', 'invalid_response', `unexpected GitHub response for ${what}`, {
      status: res.status,
    });
  }
  return parsed.data;
}

function toRepoInfo(r: z.infer<typeof RepoSchema>): RepoInfo {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    templateFullName: r.template_repository?.full_name,
    isTemplate: r.is_template === true,
  };
}

const VALID_COMPARE_STATUS = new Set<string>([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(opts.appId)) {
    throw new ServiceError('github', 'invalid_input', 'invalid GitHub App id');
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opts.org)) {
    throw new ServiceError('github', 'invalid_input', 'invalid GitHub organization');
  }
  const org = opts.org;
  const templateRepo = opts.templateRepo ?? DEFAULT_TEMPLATE_REPO;
  if (
    !/^[A-Za-z0-9._-]{1,100}$/.test(templateRepo) ||
    templateRepo === '.' ||
    templateRepo === '..'
  ) {
    throw new ServiceError('github', 'invalid_input', 'invalid template repository name');
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const http: HttpClient = createHttpClient({
    service: 'github',
    baseUrl: opts.apiBaseUrl ?? DEFAULT_API_URL,
    defaultHeaders: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'forge-builder',
    },
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

  const jwt = (): string => createAppJwt(opts.appId, opts.privateKey, Math.floor(now() / 1000));
  const appAuth = async (): Promise<string> => `Bearer ${jwt()}`;

  // --- installation and tokens ---------------------------------------------------------------

  let installationId: number | undefined;
  const tokenCache = new Map<string, CachedToken>();
  const inflight = new Map<string, Promise<CachedToken>>();

  async function getInstallationId(): Promise<number> {
    if (installationId !== undefined) return installationId;
    const res = await http.request({
      method: 'GET',
      path: `/orgs/${encodeURIComponent(org)}/installation`,
      authorization: appAuth,
    });
    installationId = parseBody(InstallationSchema, res, 'installation').id;
    return installationId;
  }

  async function mintToken(
    repositories: string[] | undefined,
    permissions: Record<string, string> | undefined,
  ): Promise<CachedToken> {
    const id = await getInstallationId();
    const res = await http.request({
      method: 'POST',
      path: `/app/installations/${id}/access_tokens`,
      authorization: appAuth,
      body: {
        ...(repositories ? { repositories } : {}),
        ...(permissions ? { permissions } : {}),
      },
      // A replayed request just mints another token.
      idempotent: true,
    });
    const body = parseBody(TokenSchema, res, 'access token');
    const expiresAt = Date.parse(body.expires_at);
    if (Number.isNaN(expiresAt)) {
      throw new ServiceError('github', 'invalid_response', 'invalid token expiry', {
        status: res.status,
      });
    }
    return { token: body.token, expiresAt };
  }

  async function installationToken(
    repositories?: string[],
    permissions?: Record<string, string>,
  ): Promise<CachedToken> {
    const key = JSON.stringify([repositories ?? null, permissions ?? null]);
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = mintToken(repositories, permissions)
      .then((t) => {
        tokenCache.set(key, t);
        return t;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const REPO_PERMS = { contents: 'write' };

  /** Authorization provider for calls scoped to one repo. */
  function repoAuth(repo: string, perms: Record<string, string> = REPO_PERMS) {
    return async (): Promise<string> => `Bearer ${(await installationToken([repo], perms)).token}`;
  }
  /** Org-wide installation token (create repo from template). */
  const orgAuth = async (): Promise<string> => `Bearer ${(await installationToken()).token}`;

  /**
   * Runs `fn`; when GitHub says the cached installation token is no longer valid (revoked early),
   * drops the cache and retries once.
   */
  async function withFreshTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceError && err.kind === 'auth' && tokenCache.size > 0) {
        tokenCache.clear();
        return fn();
      }
      throw err;
    }
  }

  const base = (repo: string): string => {
    assertRepoName(repo);
    return `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  };

  // --- repos ---------------------------------------------------------------------------------

  async function fetchRepo(path: string, auth: () => Promise<string>): Promise<RepoInfo | null> {
    const res = await http.request({
      method: 'GET',
      path,
      authorization: auth,
      allowStatus: [404],
    });
    if (res.status === 404) return null;
    return toRepoInfo(parseBody(RepoSchema, res, 'repository'));
  }

  async function getRepo(repo: string): Promise<RepoInfo | null> {
    const path = base(repo);
    // Org-wide token: a repo-scoped token cannot be minted for a repo that does not exist yet.
    return withFreshTokenRetry(() => fetchRepo(path, orgAuth));
  }

  async function getTemplateRepo(): Promise<RepoInfo> {
    const path = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(templateRepo)}`;
    const repo = await withFreshTokenRetry(() => fetchRepo(path, orgAuth));
    if (!repo) {
      throw new ServiceError(
        'github',
        'not_found',
        `template repository ${org}/${templateRepo} not found or not accessible to the App`,
        { status: 404 },
      );
    }
    return repo;
  }

  async function getBranchHead(repo: string, branch: string): Promise<string | null> {
    const path = `${base(repo)}/git/ref/heads/${encodeBranch(branch)}`;
    return withFreshTokenRetry(async () => {
      const res = await http.request({
        method: 'GET',
        path,
        authorization: repoAuth(repo),
        allowStatus: [404],
      });
      if (res.status === 404) return null;
      return parseBody(RefSchema, res, 'ref').object.sha;
    });
  }

  async function waitForDefaultBranch(repo: RepoInfo): Promise<void> {
    // Repo generation from a template is asynchronous: the default branch may appear a moment later.
    for (let i = 0; i < 20; i++) {
      if ((await getBranchHead(repo.name, repo.defaultBranch)) !== null) return;
      await sleep(1500);
    }
    throw new ServiceError(
      'github',
      'timeout',
      `repository ${repo.fullName} was created but its default branch is not ready`,
    );
  }

  async function ensureRepoFromTemplate(input: {
    slug: string;
    description?: string;
  }): Promise<{ repo: RepoInfo; created: boolean }> {
    const name = repoNameForSlug(input.slug);
    const templateFullName = `${org}/${templateRepo}`;

    const verify = (repo: RepoInfo): RepoInfo => {
      if (!repo.private) {
        throw new ServiceError(
          'github',
          'conflict',
          `repository ${repo.fullName} exists and is public`,
        );
      }
      if (repo.templateFullName !== templateFullName) {
        throw new ServiceError(
          'github',
          'conflict',
          `repository ${repo.fullName} exists but was not generated from ${templateFullName}`,
        );
      }
      return repo;
    };

    const existing = await getRepo(name);
    if (existing) {
      verify(existing);
      await waitForDefaultBranch(existing);
      return { repo: existing, created: false };
    }

    const description = (input.description ?? `FORGE launchpad ${input.slug}`).slice(0, 200);
    const res = await withFreshTokenRetry(() =>
      http.request({
        method: 'POST',
        path: `/repos/${encodeURIComponent(org)}/${encodeURIComponent(templateRepo)}/generate`,
        authorization: orgAuth,
        body: { owner: org, name, description, private: true, include_all_branches: false },
        // A replay after an ambiguous failure yields 422 "already exists", handled below.
        idempotent: true,
        allowStatus: [404, 422],
      }),
    );

    if (res.status === 404) {
      throw new ServiceError(
        'github',
        'not_found',
        `template ${templateFullName} not found, not a template repository, or not accessible to the App`,
        { status: 404 },
      );
    }
    if (res.status === 422) {
      // Most likely the repo appeared between our check and the call (retry or concurrent worker).
      const raced = await getRepo(name);
      if (raced) {
        verify(raced);
        await waitForDefaultBranch(raced);
        return { repo: raced, created: false };
      }
      throw new ServiceError('github', 'validation', `cannot create repository ${name} (422)`, {
        status: 422,
      });
    }
    const repo = verify(toRepoInfo(parseBody(RepoSchema, res, 'generated repository')));
    await waitForDefaultBranch(repo);
    return { repo, created: true };
  }

  async function protectDefaultBranch(repo: string, branch?: string): Promise<ProtectionResult> {
    const info = await getRepo(repo);
    if (!info) {
      throw new ServiceError('github', 'not_found', `repository ${org}/${repo} not found`, {
        status: 404,
      });
    }
    const target = branch ?? info.defaultBranch;
    const path = `${base(repo)}/branches/${encodeBranch(target)}/protection`;
    let res: HttpResponse;
    try {
      res = await withFreshTokenRetry(() =>
        http.request({
          method: 'PUT',
          path,
          authorization: repoAuth(repo, { administration: 'write' }),
          // Minimal rule set: nobody can force-push or delete the default branch. No review gate,
          // because the builder itself merges after its own checks.
          body: {
            required_status_checks: null,
            enforce_admins: false,
            required_pull_request_reviews: null,
            restrictions: null,
            allow_force_pushes: false,
            allow_deletions: false,
          },
          idempotent: true,
          allowStatus: [403, 404],
        }),
      );
    } catch (err) {
      // The App was not granted administration:write, so the scoped token cannot be minted.
      if (err instanceof ServiceError && (err.kind === 'validation' || err.kind === 'forbidden')) {
        return { applied: false, reason: 'permission' };
      }
      throw err;
    }
    if (res.status === 403 || res.status === 404) {
      // Private repos on a free plan answer 403 "Upgrade to GitHub Pro or make this repository public".
      return { applied: false, reason: res.status === 403 ? 'plan' : 'permission' };
    }
    return { applied: true };
  }

  // --- commits -------------------------------------------------------------------------------

  async function commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    const root = base(input.repo);
    const branchPath = encodeBranch(input.branch);
    if (
      typeof input.message !== 'string' ||
      input.message.trim() === '' ||
      input.message.length > 2000
    ) {
      throw new ServiceError('github', 'invalid_input', 'invalid commit message');
    }
    if (input.files.length > MAX_FILES) {
      throw new ServiceError('github', 'invalid_input', `too many files (max ${MAX_FILES})`);
    }

    // Validate and normalize the input.
    const wanted = new Map<string, { content: Buffer; executable: boolean; sha: string }>();
    let total = 0;
    for (const f of input.files) {
      const path = assertRepoPath(f.path);
      if (wanted.has(path)) {
        throw new ServiceError(
          'github',
          'invalid_input',
          `duplicate file path: ${path.slice(0, 80)}`,
        );
      }
      const content =
        typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : Buffer.from(f.content);
      if (content.byteLength > MAX_FILE_BYTES) {
        throw new ServiceError('github', 'invalid_input', `file too large: ${path.slice(0, 80)}`);
      }
      total += content.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        throw new ServiceError('github', 'invalid_input', 'total size of files too large');
      }
      wanted.set(path, { content, executable: f.executable === true, sha: gitBlobSha(content) });
    }
    const explicitDeletes = new Set<string>();
    for (const p of input.deletePaths ?? []) {
      assertRepoPath(p);
      if (wanted.has(p)) {
        throw new ServiceError(
          'github',
          'invalid_input',
          `path both written and deleted: ${p.slice(0, 80)}`,
        );
      }
      explicitDeletes.add(p);
    }

    const auth = repoAuth(input.repo);
    const call = (req: Parameters<HttpClient['request']>[0]): Promise<HttpResponse> =>
      withFreshTokenRetry(() => http.request({ ...req, authorization: auth }));

    // Resolve the parent commit.
    let parentSha = await getBranchHead(input.repo, input.branch);
    const branchExists = parentSha !== null;
    if (parentSha === null) {
      const baseBranch = input.baseBranch ?? (await getRepoDefaultBranch(input.repo));
      parentSha = await getBranchHead(input.repo, baseBranch);
      if (parentSha === null) {
        throw new ServiceError('github', 'not_found', `base branch ${baseBranch} not found`, {
          status: 404,
        });
      }
    }

    const commit = parseBody(
      CommitSchema,
      await call({ method: 'GET', path: `${root}/git/commits/${parentSha}` }),
      'commit',
    );
    const baseTree = parseBody(
      TreeSchema,
      await call({
        method: 'GET',
        path: `${root}/git/trees/${commit.tree.sha}`,
        query: { recursive: '1' },
      }),
      'tree',
    );
    if (baseTree.truncated) {
      throw new ServiceError('github', 'unexpected', 'repository tree too large to compare');
    }
    const existing = new Map<string, { mode: string; sha: string }>();
    for (const e of baseTree.tree) {
      if (e.type === 'blob') existing.set(e.path, { mode: e.mode, sha: e.sha });
    }

    // Work out what actually changed.
    const toWrite: Array<{ path: string; mode: string; sha: string; content: Buffer }> = [];
    for (const [path, f] of wanted) {
      const mode = f.executable ? '100755' : '100644';
      const prev = existing.get(path);
      if (prev && prev.sha === f.sha && prev.mode === mode) continue;
      toWrite.push({ path, mode, sha: f.sha, content: f.content });
    }
    const deleted = new Set<string>();
    for (const p of explicitDeletes) if (existing.has(p)) deleted.add(p);
    if (input.deleteMissing) {
      for (const p of existing.keys()) if (!wanted.has(p)) deleted.add(p);
    }

    const finishNoChange = async (): Promise<CommitFilesResult> => {
      let created = false;
      if (!branchExists) {
        await createRef(root, input.branch, parentSha, call);
        created = true;
      }
      return {
        committed: false,
        commitSha: parentSha,
        treeSha: commit.tree.sha,
        branchCreated: created,
        changedPaths: [],
        deletedPaths: [],
      };
    };
    if (toWrite.length === 0 && deleted.size === 0) return finishNoChange();

    // Upload the changed blobs (content-addressed, so replays are harmless).
    const uploaded = new Map<string, string>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(BLOB_CONCURRENCY, toWrite.length) }, async () => {
      while (cursor < toWrite.length) {
        const item = toWrite[cursor++];
        if (!item) break;
        const res = await call({
          method: 'POST',
          path: `${root}/git/blobs`,
          body: { content: item.content.toString('base64'), encoding: 'base64' },
          idempotent: true,
        });
        uploaded.set(item.path, parseBody(ShaSchema, res, 'blob').sha);
      }
    });
    await Promise.all(workers);

    const entries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }> = [];
    for (const item of toWrite) {
      const sha = uploaded.get(item.path);
      if (sha !== item.sha) {
        throw new ServiceError('github', 'invalid_response', 'blob sha mismatch after upload');
      }
      entries.push({ path: item.path, mode: item.mode, type: 'blob', sha });
    }
    for (const path of deleted) entries.push({ path, mode: '100644', type: 'blob', sha: null });

    const tree = parseBody(
      ShaSchema,
      await call({
        method: 'POST',
        path: `${root}/git/trees`,
        body: { base_tree: commit.tree.sha, tree: entries },
        idempotent: true,
      }),
      'tree',
    );
    if (tree.sha === commit.tree.sha) return finishNoChange();

    const newCommit = parseBody(
      ShaSchema,
      await call({
        method: 'POST',
        path: `${root}/git/commits`,
        body: { message: input.message, tree: tree.sha, parents: [parentSha] },
        idempotent: true,
      }),
      'commit',
    );

    if (branchExists) {
      // force:false -> a concurrent push to the same branch fails instead of being overwritten.
      const res = await call({
        method: 'PATCH',
        path: `${root}/git/refs/heads/${branchPath}`,
        body: { sha: newCommit.sha, force: false },
        idempotent: true,
        allowStatus: [422],
      });
      if (res.status === 422) {
        throw new ServiceError(
          'github',
          'conflict',
          `branch ${input.branch} moved while committing; retry`,
          { status: 422 },
        );
      }
    } else {
      await createRef(root, input.branch, newCommit.sha, call);
    }

    return {
      committed: true,
      commitSha: newCommit.sha,
      treeSha: tree.sha,
      branchCreated: !branchExists,
      changedPaths: toWrite.map((w) => w.path).sort(),
      deletedPaths: [...deleted].sort(),
    };
  }

  async function createRef(
    root: string,
    branch: string,
    sha: string,
    call: (req: Parameters<HttpClient['request']>[0]) => Promise<HttpResponse>,
  ): Promise<void> {
    encodeBranch(branch);
    const res = await call({
      method: 'POST',
      path: `${root}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha },
      idempotent: true,
      allowStatus: [422],
    });
    if (res.status === 422) {
      throw new ServiceError('github', 'conflict', `branch ${branch} already exists; retry`, {
        status: 422,
      });
    }
  }

  async function getRepoDefaultBranch(repo: string): Promise<string> {
    const info = await getRepo(repo);
    if (!info) {
      throw new ServiceError('github', 'not_found', `repository ${org}/${repo} not found`, {
        status: 404,
      });
    }
    return info.defaultBranch;
  }

  // --- read, compare, merge ------------------------------------------------------------------

  async function compareCommits(
    repo: string,
    baseRef: string,
    headRef: string,
  ): Promise<CompareResult> {
    const root = base(repo);
    const spec = `${encodeBranchOrSha(baseRef)}...${encodeBranchOrSha(headRef)}`;
    const files: CompareFile[] = [];
    let first: z.infer<typeof CompareSchema> | undefined;
    for (let page = 1; ; page++) {
      const res = await withFreshTokenRetry(() =>
        http.request({
          method: 'GET',
          path: `${root}/compare/${spec}`,
          query: { per_page: COMPARE_PAGE_SIZE, page },
          authorization: repoAuth(repo),
        }),
      );
      const body = parseBody(CompareSchema, res, 'comparison');
      first ??= body;
      for (const f of body.files ?? []) {
        files.push({
          path: f.filename,
          status: (VALID_COMPARE_STATUS.has(f.status) ? f.status : 'changed') as CompareFileStatus,
          previousPath: f.previous_filename,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
          sha: f.sha,
        });
      }
      if ((body.files?.length ?? 0) < COMPARE_PAGE_SIZE) break;
      if (files.length >= COMPARE_MAX_FILES) {
        throw new ServiceError('github', 'unexpected', 'comparison touches too many files');
      }
    }
    // `first` is set: the loop body ran at least once.
    const c = first as z.infer<typeof CompareSchema>;
    const commits = c.commits ?? [];
    return {
      status: c.status,
      aheadBy: c.ahead_by,
      behindBy: c.behind_by,
      totalCommits: c.total_commits,
      mergeBaseSha: c.merge_base_commit.sha,
      headSha: commits[commits.length - 1]?.sha ?? c.merge_base_commit.sha,
      files,
    };
  }

  async function readFile(repo: string, path: string, ref: string): Promise<string | null> {
    assertRepoPath(path);
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const res = await withFreshTokenRetry(() =>
      http.request({
        method: 'GET',
        path: `${base(repo)}/contents/${encodedPath}`,
        query: { ref },
        authorization: repoAuth(repo),
        allowStatus: [404],
      }),
    );
    if (res.status === 404) return null;
    const body = parseBody(ContentSchema, res, 'contents');
    if (body.type !== 'file' || body.encoding !== 'base64' || body.content === undefined) {
      throw new ServiceError('github', 'unexpected', `${path.slice(0, 80)} is not a regular file`);
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  }

  async function mergeBranch(
    repo: string,
    input: { base: string; head: string; message: string },
  ): Promise<MergeResult> {
    encodeBranch(input.base);
    encodeBranch(input.head);
    const res = await withFreshTokenRetry(() =>
      http.request({
        method: 'POST',
        path: `${base(repo)}/merges`,
        authorization: repoAuth(repo),
        body: { base: input.base, head: input.head, commit_message: input.message },
        // A replay after an ambiguous failure answers 204 (already merged).
        idempotent: true,
        allowStatus: [204],
      }),
    );
    if (res.status === 204) {
      const sha = await getBranchHead(repo, input.base);
      if (sha === null) {
        throw new ServiceError('github', 'not_found', `base branch ${input.base} not found`);
      }
      return { merged: false, sha };
    }
    return { merged: true, sha: parseBody(ShaSchema, res, 'merge').sha };
  }

  async function deleteBranch(repo: string, branch: string): Promise<boolean> {
    const res = await withFreshTokenRetry(() =>
      http.request({
        method: 'DELETE',
        path: `${base(repo)}/git/refs/heads/${encodeBranch(branch)}`,
        authorization: repoAuth(repo),
        allowStatus: [404, 422],
      }),
    );
    return res.status !== 404 && res.status !== 422;
  }

  async function getInstallation() {
    const res = await http.request({
      method: 'GET',
      path: `/orgs/${encodeURIComponent(org)}/installation`,
      authorization: appAuth,
    });
    const body = parseBody(InstallationSchema, res, 'installation');
    return {
      id: body.id,
      repositorySelection: body.repository_selection ?? 'unknown',
      permissions: body.permissions ?? {},
    };
  }

  async function createRepoToken(repo: string): Promise<RepoToken> {
    assertRepoName(repo);
    const t = await withFreshTokenRetry(() => installationToken([repo], REPO_PERMS));
    return { token: t.token, expiresAt: t.expiresAt };
  }

  return {
    getInstallation,
    getTemplateRepo,
    getRepo,
    ensureRepoFromTemplate,
    protectDefaultBranch,
    getBranchHead,
    commitFiles,
    compareCommits,
    readFile,
    mergeBranch,
    deleteBranch,
    createRepoToken,
  };
}

/** A branch name or a commit sha, URL-encoded for the compare endpoint. */
function encodeBranchOrSha(ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return encodeBranch(ref);
}
