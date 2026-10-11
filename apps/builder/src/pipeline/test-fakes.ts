/// <reference types="node" />
/**
 * Test helpers: in-memory fakes of every external dependency of the pipeline (GitHub, Vercel,
 * sandbox, gateway, signer, Supabase). No network, no docker. Each fake records its calls and can
 * fail a call before or after its effect, to simulate errors and crashes at every step.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LaunchpadSpec, type JobRow, type LaunchpadStatus } from '@forge/shared';
import {
  assertRepoPath,
  gitBlobSha,
  repoNameForSlug,
  type CommitFilesInput,
  type CompareResult,
  type CommitFilesResult,
  type MergeResult,
  type RepoInfo,
} from '../github.js';
import { ServiceError } from '../http.js';
import type {
  ResolvedSandboxConfig,
  SandboxRunner,
  SandboxRunOptions,
  SandboxRunResult,
} from '../sandbox/index.js';
import { base58Encode } from '../scan/base58.js';
import {
  PROJECT_ENV_ALLOWLIST,
  projectEnvProblem,
  projectNameForSlug,
  type CreateDeploymentInput,
  type DeploymentProtection,
  type DomainResult,
  type VercelDeployment,
  type VercelProject,
} from '../vercel.js';
import type { JobContext, WorkerLogger } from '../worker.js';
import type { AgentGateway } from './agent.js';
import type { PipelineGithub, PipelineSigner, PipelineVercel } from './context.js';
import type { RepoSnapshot, RepoSource, RepoTree, RepoTreeEntry } from './repo-snapshot.js';
import {
  BLOCKING_FAILED_STAGES,
  launchpadStatusFilter,
  LaunchpadStatusChangedError,
  type BuilderLaunchpadStatus,
  type LaunchpadPatch,
  type LaunchpadRecord,
  type LaunchpadWriteOptions,
  type SleepStore,
} from './store.js';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Deterministic base58 address from a seed (valid shape for the shared schemas). */
export function address(seed: number): string {
  return base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + seed * 17 + 1) % 256));
}

export const OWNER = address(1);
export const LAUNCHPAD_CONFIG = address(2);
export const LAUNCHPAD_COIN_CONFIG = address(3);
export const LAUNCHPAD_COIN_MINT = address(4);
export const OWNER_TX = Buffer.from('partially signed launch transaction').toString('base64');

export const LAUNCHPAD_ID = '11111111-2222-4333-8444-555555555555';
export const CREATE_JOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
export const MODIFY_JOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';

export function specFixture(): LaunchpadSpec {
  return LaunchpadSpec.parse({
    version: 1,
    ownerWallet: OWNER,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.01,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'Launch to the moon',
      logoUrl: 'https://cdn.forge.test/logo.png',
      designNotes: 'Space theme with a big hero and stars.',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: 'The MoonPad coin.',
      imageUrl: 'https://elsewhere.example/moon.png',
      firstBuySol: 0.5,
    },
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

/** Files of the launchpad template repository. */
export function templateFiles(): Map<string, FakeFile> {
  const text = (s: string): FakeFile => ({ content: Buffer.from(s, 'utf8'), executable: false });
  return new Map<string, FakeFile>([
    [
      'package.json',
      text(
        `${JSON.stringify(
          {
            name: 'launchpad',
            private: true,
            scripts: { build: 'next build' },
            dependencies: { '@forge/core': '0.1.0', next: '15.5.0', react: '19.0.0' },
          },
          null,
          2,
        )}\n`,
      ),
    ],
    ['pnpm-lock.yaml', text("lockfileVersion: '9.0'\n")],
    [
      'forge.config.json',
      text(
        `${JSON.stringify(
          {
            version: 1,
            name: 'Example Pad',
            slug: 'example-pad',
            mode: 'live',
            theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
            content: { tagline: 'Launch your coin.', about: 'Sample launchpad.' },
          },
          null,
          2,
        )}\n`,
      ),
    ],
    ['next.config.ts', text('export default {};\n')],
    ['src/forge/BuyButton.tsx', text('export function BuyButton() {\n  return null;\n}\n')],
    ['src/theme/theme.css', text(':root {\n  --primary: #7c3aed;\n}\n')],
    ['src/content/index.ts', text("export const content = { title: 'Launchpad' };\n")],
    [
      'src/pages/index.tsx',
      text(
        "import { BuyButton } from '../forge/BuyButton';\n\nexport default function Home() {\n  return (\n    <main>\n      <BuyButton />\n    </main>\n  );\n}\n",
      ),
    ],
    ['public/logo.png', { content: PNG, executable: false }],
  ]);
}

export function launchpadFixture(over: Partial<LaunchpadRecord> = {}): LaunchpadRecord {
  return {
    id: LAUNCHPAD_ID,
    owner_wallet: OWNER,
    slug: 'moonpad',
    spec: specFixture(),
    github_repo: null,
    vercel_project_id: null,
    launchpad_config: null,
    launchpad_coin_config: null,
    launchpad_coin_mint: null,
    status: 'draft',
    last_trade_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function jobFixture(over: Partial<JobRow> = {}): JobRow {
  return {
    id: CREATE_JOB_ID,
    launchpad_id: LAUNCHPAD_ID,
    type: 'create_launchpad',
    status: 'building',
    attempts: 1,
    failed_stage: null,
    request: null,
    preview_url: null,
    owner_tx: null,
    error: null,
    api_cost_usd: 0,
    locked_by: 'w1',
    locked_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export const silentLogger = (): WorkerLogger => ({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** A JobContext whose events are recorded. */
export function jobContext(signal: AbortSignal = new AbortController().signal) {
  const events: string[] = [];
  const ctx: JobContext = {
    workerId: 'w1',
    signal,
    logger: silentLogger(),
    event: async (message) => {
      events.push(message);
    },
  };
  return { ctx, events };
}

// ---------------------------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------------------------

type Fault = { when: 'before' | 'after'; error: Error };

/** Shared call log and faults of a fake. */
class Recorder {
  readonly calls: string[] = [];
  /** Called with the operation name before it runs (tests abort a signal here). */
  onCall: ((op: string) => void) | undefined;
  private readonly faults = new Map<string, Fault[]>();

  /** The next call of `op` fails, before its effect (default) or after it (a crash). */
  fail(op: string, when: 'before' | 'after' = 'before', error?: Error): void {
    const list = this.faults.get(op) ?? [];
    list.push({ when, error: error ?? new Error(`${op} failed (${when})`) });
    this.faults.set(op, list);
  }

  count(op: string): number {
    return this.calls.filter((c) => c === op).length;
  }

  protected async around<T>(op: string, fn: () => T | Promise<T>): Promise<T> {
    this.calls.push(op);
    this.onCall?.(op);
    await Promise.resolve();
    const list = this.faults.get(op) ?? [];
    const fault = list[0];
    if (fault?.when === 'before') {
      list.shift();
      throw fault.error;
    }
    const result = await fn();
    if (fault?.when === 'after') {
      list.shift();
      throw fault.error;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

export interface FakeFile {
  content: Buffer;
  executable: boolean;
}

interface FakeCommit {
  sha: string;
  files: Map<string, FakeFile>;
  parents: string[];
  message: string;
}

interface FakeRepo {
  info: RepoInfo;
  branches: Map<string, string>;
}

function sameFiles(a: Map<string, FakeFile>, b: Map<string, FakeFile>): boolean {
  if (a.size !== b.size) return false;
  for (const [p, f] of a) {
    const g = b.get(p);
    if (!g || g.executable !== f.executable || !g.content.equals(f.content)) return false;
  }
  return true;
}

export class FakeGithub extends Recorder implements PipelineGithub, RepoSource {
  readonly org = 'forge-org';
  readonly repos = new Map<string, FakeRepo>();
  readonly commits = new Map<string, FakeCommit>();
  private counter = 0;

  constructor(private readonly template: Map<string, FakeFile> = templateFiles()) {
    super();
  }

  private newSha(): string {
    this.counter += 1;
    return createHash('sha1').update(`commit-${this.counter}`).digest('hex');
  }

  private repo(name: string): FakeRepo {
    const r = this.repos.get(name);
    if (!r)
      throw new ServiceError('github', 'not_found', `repository ${name} not found`, {
        status: 404,
      });
    return r;
  }

  private resolve(r: FakeRepo, ref: string): FakeCommit | null {
    const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : r.branches.get(ref);
    return sha ? (this.commits.get(sha) ?? null) : null;
  }

  private addCommit(files: Map<string, FakeFile>, parents: string[], message: string): string {
    const sha = this.newSha();
    this.commits.set(sha, { sha, files, parents, message });
    return sha;
  }

  /** Creates a repo directly (modification tests start from a live launchpad). */
  seedRepo(slug: string, files: Map<string, FakeFile>): RepoInfo {
    const name = repoNameForSlug(slug);
    const info: RepoInfo = {
      id: this.repos.size + 1,
      name,
      fullName: `${this.org}/${name}`,
      private: true,
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${this.org}/${name}`,
      templateFullName: `${this.org}/launchpad-template`,
      isTemplate: false,
    };
    const sha = this.addCommit(new Map(files), [], 'Initial commit');
    this.repos.set(name, { info, branches: new Map([['main', sha]]) });
    return info;
  }

  /** Files of a ref (test assertions). */
  filesAt(repo: string, ref: string): Map<string, FakeFile> {
    const commit = this.resolve(this.repo(repo), ref);
    if (!commit) throw new Error(`no ref ${ref}`);
    return commit.files;
  }

  text(repo: string, ref: string, file: string): string | undefined {
    return this.filesAt(repo, ref).get(file)?.content.toString('utf8');
  }

  ensureRepoFromTemplate(input: { slug: string }): Promise<{ repo: RepoInfo; created: boolean }> {
    return this.around('ensureRepoFromTemplate', () => {
      const existing = this.repos.get(repoNameForSlug(input.slug));
      if (existing) return { repo: existing.info, created: false };
      return { repo: this.seedRepo(input.slug, this.template), created: true };
    });
  }

  getRepo(repo: string): Promise<RepoInfo | null> {
    return this.around('getRepo', () => this.repos.get(repo)?.info ?? null);
  }

  /** What protectDefaultBranch answers (the free plan refuses it on private repos). */
  protection: { applied: boolean; reason?: 'plan' | 'permission' } = {
    applied: false,
    reason: 'plan',
  };
  /** Repos whose default branch protection was applied. */
  readonly protectedRepos = new Set<string>();

  protectDefaultBranch(repo: string): Promise<{ applied: boolean; reason?: 'plan' | 'permission' }> {
    return this.around('protectDefaultBranch', () => {
      this.repo(repo);
      if (this.protection.applied) this.protectedRepos.add(repo);
      return { ...this.protection };
    });
  }

  getBranchHead(repo: string, branch: string): Promise<string | null> {
    return this.around('getBranchHead', () => this.repos.get(repo)?.branches.get(branch) ?? null);
  }

  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    return this.around('commitFiles', () => {
      const r = this.repo(input.repo);
      const branchHead = r.branches.get(input.branch) ?? null;
      const parentSha = branchHead ?? r.branches.get(input.baseBranch ?? r.info.defaultBranch);
      if (!parentSha) throw new ServiceError('github', 'not_found', 'base branch not found');
      const parent = this.commits.get(parentSha)!;
      const next = new Map(parent.files);
      const wanted = new Set<string>();
      for (const f of input.files) {
        assertRepoPath(f.path);
        wanted.add(f.path);
        const content =
          typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : Buffer.from(f.content);
        next.set(f.path, { content, executable: f.executable === true });
      }
      for (const p of input.deletePaths ?? []) next.delete(p);
      if (input.deleteMissing)
        for (const p of parent.files.keys()) if (!wanted.has(p)) next.delete(p);
      const changedPaths = [...next.keys()].filter((p) => {
        const before = parent.files.get(p);
        const after = next.get(p)!;
        return (
          !before || before.executable !== after.executable || !before.content.equals(after.content)
        );
      });
      const deletedPaths = [...parent.files.keys()].filter((p) => !next.has(p));
      if (sameFiles(next, parent.files)) {
        if (!branchHead) r.branches.set(input.branch, parentSha);
        return {
          committed: false,
          commitSha: parentSha,
          treeSha: parentSha,
          branchCreated: !branchHead,
          changedPaths: [],
          deletedPaths: [],
        };
      }
      const sha = this.addCommit(next, [parentSha], input.message);
      r.branches.set(input.branch, sha);
      return {
        committed: true,
        commitSha: sha,
        treeSha: sha,
        branchCreated: !branchHead,
        changedPaths: changedPaths.sort(),
        deletedPaths: deletedPaths.sort(),
      };
    });
  }

  readFile(repo: string, file: string, ref: string): Promise<string | null> {
    return this.around('readFile', () => {
      const commit = this.resolve(this.repo(repo), ref);
      if (!commit) throw new ServiceError('github', 'not_found', `ref ${ref} not found`);
      return commit.files.get(file)?.content.toString('utf8') ?? null;
    });
  }

  private ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const s = queue.shift()!;
      if (seen.has(s)) continue;
      seen.add(s);
      queue.push(...(this.commits.get(s)?.parents ?? []));
    }
    return seen;
  }

  mergeBranch(
    repo: string,
    input: { base: string; head: string; message: string },
  ): Promise<MergeResult> {
    return this.around('mergeBranch', () => {
      const r = this.repo(repo);
      const baseSha = r.branches.get(input.base);
      const headSha = r.branches.get(input.head);
      if (!baseSha || !headSha) throw new ServiceError('github', 'not_found', 'branch not found');
      if (this.ancestors(baseSha).has(headSha)) return { merged: false, sha: baseSha };
      const mergeBase = this.mergeBase(baseSha, headSha);
      const ancestor = this.commits.get(mergeBase ?? '')?.files ?? new Map<string, FakeFile>();
      const base = this.commits.get(baseSha)!.files;
      const head = this.commits.get(headSha)!.files;
      const result = new Map(base);
      const same = (a?: FakeFile, b?: FakeFile) =>
        a === b || (!!a && !!b && a.executable === b.executable && a.content.equals(b.content));
      for (const p of new Set([...ancestor.keys(), ...head.keys()])) {
        if (same(ancestor.get(p), head.get(p))) continue;
        if (!same(ancestor.get(p), base.get(p)) && !same(base.get(p), head.get(p))) {
          throw new ServiceError('github', 'conflict', `merge conflict on ${p}`, { status: 409 });
        }
        const h = head.get(p);
        if (h) result.set(p, h);
        else result.delete(p);
      }
      const sha = this.addCommit(result, [baseSha, headSha], input.message);
      r.branches.set(input.base, sha);
      return { merged: true, sha };
    });
  }

  /** First ancestor of head (breadth first) that is also an ancestor of base. */
  private mergeBase(baseSha: string, headSha: string): string | undefined {
    const baseAncestors = this.ancestors(baseSha);
    const queue = [headSha];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const s = queue.shift()!;
      if (seen.has(s)) continue;
      seen.add(s);
      if (baseAncestors.has(s)) return s;
      queue.push(...(this.commits.get(s)?.parents ?? []));
    }
    return undefined;
  }

  private commitOf(repo: string, ref: string): FakeCommit {
    const commit = this.resolve(this.repo(repo), ref);
    if (!commit) throw new ServiceError('github', 'not_found', `ref ${ref} not found`);
    return commit;
  }

  compareCommits(repo: string, base: string, head: string): Promise<CompareResult> {
    return this.around('compareCommits', () => {
      const baseSha = this.commitOf(repo, base).sha;
      const headSha = this.commitOf(repo, head).sha;
      const mergeBaseSha = this.mergeBase(baseSha, headSha);
      if (!mergeBaseSha) throw new ServiceError('github', 'not_found', 'no common ancestor');
      return {
        status:
          mergeBaseSha === headSha ? 'behind' : mergeBaseSha === baseSha ? 'ahead' : 'diverged',
        aheadBy: 0,
        behindBy: 0,
        totalCommits: 0,
        mergeBaseSha,
        headSha,
        files: [],
        source: 'tree',
      } satisfies CompareResult;
    });
  }

  listTree(repo: string, ref: string): Promise<RepoTree> {
    return this.around('listTree', () => {
      const commit = this.commitOf(repo, ref);
      const entries = [...commit.files.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([p, f]) => ({ path: p, sha: gitBlobSha(f.content), executable: f.executable }));
      return { commitSha: commit.sha, entries };
    });
  }

  readBlobs(repo: string, entries: readonly RepoTreeEntry[]): Promise<Map<string, Buffer>> {
    return this.around('readBlobs', () => {
      this.repo(repo);
      const byId = new Map<string, Buffer>();
      for (const c of this.commits.values()) {
        for (const f of c.files.values()) byId.set(gitBlobSha(f.content), f.content);
      }
      const out = new Map<string, Buffer>();
      for (const e of entries) {
        const content = byId.get(e.sha);
        if (!content) throw new ServiceError('github', 'not_found', 'blob not found');
        out.set(e.path, Buffer.from(content));
      }
      return out;
    });
  }

  snapshot(repo: string, ref: string): Promise<RepoSnapshot> {
    return this.around('snapshot', () => {
      const commit = this.commitOf(repo, ref);
      const files = [...commit.files.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([p, f]) => ({ path: p, content: Buffer.from(f.content), executable: f.executable }));
      return { commitSha: commit.sha, files };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------------------------

interface FakeProject {
  id: string;
  name: string;
  linkedRepo: string;
  productionDeploymentId: string | undefined;
  env: Map<string, string>;
  domains: Set<string>;
}

export interface FakeDeployment extends VercelDeployment {
  projectId: string;
  ref: string;
  sha: string | undefined;
  /** Project env at creation time (what the build saw). */
  env: Record<string, string>;
}

export class FakeVercel extends Recorder implements PipelineVercel {
  readonly projects = new Map<string, FakeProject>();
  readonly deployments = new Map<string, FakeDeployment>();
  /** State the next deployments end in. */
  nextState: 'READY' | 'ERROR' = 'READY';
  readonly clientsDomain = 'clients.test';
  private counter = 0;

  private project(id: string): FakeProject {
    const p = this.projects.get(id);
    if (!p) throw new ServiceError('vercel', 'not_found', 'project not found', { status: 404 });
    return p;
  }

  private view(p: FakeProject): VercelProject {
    return {
      id: p.id,
      name: p.name,
      linkedRepo: p.linkedRepo,
      productionDeploymentId: p.productionDeploymentId,
      paused: false,
      gitDeploymentsDisabled: true,
    };
  }

  projectBySlug(slug: string): FakeProject | undefined {
    return [...this.projects.values()].find((p) => p.name === projectNameForSlug(slug));
  }

  ensureProject(input: {
    slug: string;
    protection?: DeploymentProtection;
  }): Promise<{ project: VercelProject; created: boolean }> {
    return this.around('ensureProject', () => {
      const existing = this.projectBySlug(input.slug);
      if (existing) return { project: this.view(existing), created: false };
      this.counter += 1;
      const p: FakeProject = {
        id: `prj_${this.counter}`,
        name: projectNameForSlug(input.slug),
        linkedRepo: `forge-org/${repoNameForSlug(input.slug)}`,
        productionDeploymentId: undefined,
        env: new Map(),
        domains: new Set(),
      };
      this.projects.set(p.id, p);
      return { project: this.view(p), created: true };
    });
  }

  setEnv(projectId: string, vars: Record<string, string>): Promise<{ count: number }> {
    return this.around('setEnv', () => {
      const p = this.project(projectId);
      for (const [k, v] of Object.entries(vars)) {
        const problem = projectEnvProblem(k, v);
        if (problem) throw new ServiceError('vercel', 'invalid_input', problem);
      }
      for (const [k, v] of Object.entries(vars)) p.env.set(k, v);
      return { count: Object.keys(vars).length };
    });
  }

  pruneEnv(projectId: string): Promise<{ removed: string[] }> {
    return this.around('pruneEnv', () => {
      const p = this.project(projectId);
      const removed = [...p.env.keys()].filter((k) => !PROJECT_ENV_ALLOWLIST.has(k));
      for (const k of removed) p.env.delete(k);
      return { removed };
    });
  }

  createDeployment(input: CreateDeploymentInput): Promise<VercelDeployment> {
    return this.around('createDeployment', () => {
      const p = this.project(input.project.id);
      const target = input.target ?? 'preview';
      const existing = [...this.deployments.values()].find(
        (d) => d.projectId === p.id && d.sha === input.sha && d.target === target,
      );
      if (existing) return { ...existing };
      this.counter += 1;
      const d: FakeDeployment = {
        id: `dpl_${this.counter}`,
        url: `https://${p.name}-${this.counter}.vercel.test`,
        readyState: 'BUILDING',
        target,
        errorCode: undefined,
        errorMessage: undefined,
        projectId: p.id,
        ref: input.ref,
        sha: input.sha,
        env: Object.fromEntries(p.env),
      };
      this.deployments.set(d.id, d);
      return { ...d };
    });
  }

  waitForDeployment(id: string): Promise<VercelDeployment> {
    return this.around('waitForDeployment', () => {
      const d = this.deployments.get(id);
      if (!d) throw new ServiceError('vercel', 'not_found', 'deployment not found');
      if (d.readyState === 'BUILDING') d.readyState = this.nextState;
      if (d.readyState !== 'READY') {
        throw new ServiceError('vercel', 'deployment_failed', `deployment ${d.id} ended in ERROR`);
      }
      return { ...d };
    });
  }

  promoteToProduction(projectId: string, deploymentId: string): Promise<{ promoted: boolean }> {
    return this.around('promoteToProduction', () => {
      const p = this.project(projectId);
      if (p.productionDeploymentId === deploymentId) return { promoted: false };
      const d = this.deployments.get(deploymentId);
      if (!d || d.readyState !== 'READY') {
        throw new ServiceError('vercel', 'invalid_input', 'only READY deployments can be promoted');
      }
      p.productionDeploymentId = deploymentId;
      return { promoted: true };
    });
  }

  attachSubdomain(projectId: string, slug: string): Promise<DomainResult> {
    return this.around('attachSubdomain', () => {
      const p = this.project(projectId);
      const domain = `${slug}.${this.clientsDomain}`;
      const created = !p.domains.has(domain);
      p.domains.add(domain);
      return { domain, verified: true, verification: [], created };
    });
  }

  /** Deployments of a project, in creation order. */
  deploymentsOf(projectId: string): FakeDeployment[] {
    return [...this.deployments.values()].filter((d) => d.projectId === projectId);
  }
}

// ---------------------------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------------------------

export type SandboxStep = 'agent' | 'install' | 'build';

export type AgentBehaviour = (workdir: string, options: SandboxRunOptions) => void | Promise<void>;

export class FakeRunner extends Recorder implements SandboxRunner {
  readonly config: ResolvedSandboxConfig;
  readonly runs: Array<{ step: SandboxStep; options: SandboxRunOptions }> = [];
  agent: AgentBehaviour = () => undefined;
  /** CLI result printed by the agent run. */
  agentStdout: string = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Updated the theme and the hero.',
    num_turns: 7,
    total_cost_usd: 0.42,
  });
  agentExitCode = 0;
  agentTimedOut = false;
  installExitCode = 0;
  buildExitCode = 0;
  /** Runs while a step executes (tests use it to rewrite the folder during the build). */
  duringBuild: ((workdir: string) => void | Promise<void>) | undefined;

  constructor(jobsRoot: string) {
    super();
    this.config = {
      image: `sha256:${'a'.repeat(64)}`,
      proxyImage: `sha256:${'b'.repeat(64)}`,
      jobsRoot,
      dockerBinary: 'docker',
      uid: 1000,
      gid: 1000,
      runtime: undefined,
      gateway: { host: 'host.docker.internal', port: 8787 },
      egressHosts: { npm: ['registry.npmjs.org'], 'github-packages': ['npm.pkg.github.com'] },
      egressNetwork: 'forge-egress-out',
      hostEnv: {},
      extraHostSecrets: [],
    };
  }

  private stepOf(options: SandboxRunOptions): SandboxStep {
    const [bin, sub] = options.command;
    if ((bin === 'pnpm' || bin === 'npm') && (sub === 'install' || sub === 'ci')) return 'install';
    if ((bin === 'pnpm' || bin === 'npm') && sub === 'run') return 'build';
    return 'agent';
  }

  run(options: SandboxRunOptions): Promise<SandboxRunResult> {
    const step = this.stepOf(options);
    return this.around(`run:${step}`, async () => {
      this.runs.push({ step, options });
      let exitCode: number;
      let stdout: string;
      let timedOut = false;
      if (step === 'agent') {
        await this.agent(options.workdir, options);
        exitCode = this.agentExitCode;
        stdout = this.agentStdout;
        timedOut = this.agentTimedOut;
      } else if (step === 'install') {
        exitCode = this.installExitCode;
        if (exitCode === 0)
          await mkdir(path.join(options.workdir, 'node_modules'), { recursive: true });
        stdout = exitCode === 0 ? 'Packages: +42' : 'ERR_PNPM_FETCH_404';
      } else {
        await this.duringBuild?.(options.workdir);
        exitCode = this.buildExitCode;
        if (exitCode === 0) await mkdir(path.join(options.workdir, '.next'), { recursive: true });
        stdout =
          exitCode === 0 ? 'Compiled successfully' : "Type error: Cannot find module './Hero'";
      }
      return {
        runId: `run-${this.runs.length}`,
        ok: exitCode === 0 && !timedOut,
        exitCode: timedOut ? 124 : exitCode,
        timedOut,
        oomKilled: false,
        killedReason: timedOut ? 'timeout' : null,
        durationMs: 10,
        stdout,
        stderr: '',
        truncated: { stdout: false, stderr: false },
        outputBytes: { stdout: stdout.length, stderr: 0 },
        egress: null,
      } satisfies SandboxRunResult;
    });
  }

  cleanupStale(): Promise<{ containers: number; networks: number }> {
    return this.around('cleanupStale', () => ({ containers: 0, networks: 0 }));
  }

  stepsRun(): SandboxStep[] {
    return this.runs.map((r) => r.step);
  }
}

// ---------------------------------------------------------------------------------------------
// Gateway, signer, store
// ---------------------------------------------------------------------------------------------

export class FakeGateway extends Recorder implements AgentGateway {
  readonly issued: Array<{
    jobId: string;
    token: string;
    budgetUsd?: number;
    ttlMinutes?: number;
  }> = [];
  readonly revoked: string[] = [];

  issueToken(
    jobId: string,
    options: { budgetUsd?: number; ttlMinutes?: number } = {},
  ): Promise<string> {
    return this.around('issueToken', () => {
      const token = `forge_gw_${'t'.repeat(24)}${this.issued.length + 1}`;
      this.issued.push({ jobId, token, ...options });
      return token;
    });
  }

  revokeToken(token: string): Promise<void> {
    return this.around('revokeToken', () => {
      this.revoked.push(token);
    });
  }
}

export class FakeSigner extends Recorder implements PipelineSigner {
  configs = { launchpadConfig: LAUNCHPAD_CONFIG, launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG };
  prepared = { partiallySignedTx: OWNER_TX, mint: LAUNCHPAD_COIN_MINT };

  createConfigs(): Promise<{ launchpadConfig: string; launchpadCoinConfig: string }> {
    return this.around('createConfigs', () => ({ ...this.configs }));
  }

  prepareLaunchCoin(): Promise<{ partiallySignedTx: string; mint: string }> {
    return this.around('prepareLaunchCoin', () => ({ ...this.prepared }));
  }
}

export interface FakeJobActivity {
  launchpadId: string;
  status: string;
  updatedAt: string;
  failedStage?: string | null;
}

export class FakeStore extends Recorder implements SleepStore {
  readonly launchpads = new Map<string, LaunchpadRecord>();
  readonly jobs: FakeJobActivity[] = [];

  add(lp: LaunchpadRecord): void {
    this.launchpads.set(lp.id, structuredClone(lp));
  }

  get(id: string): LaunchpadRecord {
    const lp = this.launchpads.get(id);
    if (!lp) throw new Error(`no launchpad ${id}`);
    return lp;
  }

  getLaunchpad(id: string): Promise<LaunchpadRecord | null> {
    return this.around('getLaunchpad', () => {
      const lp = this.launchpads.get(id);
      return lp ? structuredClone(lp) : null;
    });
  }

  /** Called right before a write applies (tests change the row concurrently here). */
  beforeWrite: ((id: string, patch: LaunchpadPatch) => void) | undefined;

  updateLaunchpad(id: string, patch: LaunchpadPatch, opts?: LaunchpadWriteOptions): Promise<void> {
    return this.around('updateLaunchpad', () => {
      // Same conditions as the PostgREST store.
      const filter = launchpadStatusFilter(patch, opts);
      this.beforeWrite?.(id, patch);
      const lp = this.launchpads.get(id);
      if (!lp) throw new Error('launchpad not found');
      if (filter !== null) {
        const ok =
          filter === 'neq.disabled'
            ? lp.status !== 'disabled'
            : (opts?.expectStatus ?? []).includes(lp.status as BuilderLaunchpadStatus);
        if (!ok) throw new LaunchpadStatusChangedError();
      }
      Object.assign(lp, patch);
    });
  }

  /** One page of `rows` ordered by id, after the cursor (same contract as the store). */
  private page(rows: LaunchpadRecord[], limit: number, afterId?: string): LaunchpadRecord[] {
    return rows
      .filter((lp) => afterId === undefined || lp.id > afterId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map((lp) => structuredClone(lp));
  }

  listDormant(cutoffIso: string, limit = 500, afterId?: string): Promise<LaunchpadRecord[]> {
    return this.around('listDormant', () =>
      this.page(
        [...this.launchpads.values()].filter(
          (lp) =>
            lp.status === 'live' &&
            ((lp.last_trade_at !== null && lp.last_trade_at < cutoffIso) ||
              (lp.last_trade_at === null && (lp.created_at ?? '') < cutoffIso)),
        ),
        limit,
        afterId,
      ),
    );
  }

  listWoken(cutoffIso: string, limit = 500, afterId?: string): Promise<LaunchpadRecord[]> {
    return this.around('listWoken', () =>
      this.page(
        [...this.launchpads.values()].filter(
          (lp) =>
            lp.status === 'sleeping' && lp.last_trade_at !== null && lp.last_trade_at >= cutoffIso,
        ),
        limit,
        afterId,
      ),
    );
  }

  hasJobActivity(launchpadId: string, sinceIso: string): Promise<boolean> {
    return this.around('hasJobActivity', () =>
      this.jobs.some(
        (j) =>
          j.launchpadId === launchpadId &&
          (j.updatedAt >= sinceIso ||
            !['live', 'failed', 'refunded', 'spec_ready'].includes(j.status) ||
            (j.status === 'failed' &&
              (BLOCKING_FAILED_STAGES as readonly string[]).includes(j.failedStage ?? ''))),
      ),
    );
  }

  setStatus(id: string, status: LaunchpadStatus): void {
    this.get(id).status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Temporary jobs root
// ---------------------------------------------------------------------------------------------

export async function makeJobsRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-pipeline-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
