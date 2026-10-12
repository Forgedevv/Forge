import { LaunchpadSpec, type JobRow, type SolanaCluster } from '@forge/shared';
import type { Alerter } from '../alerts.js';
import { repoNameForSlug, type GithubClient } from '../github.js';
import type { BuildSiteOptions, BuildSiteResult, SandboxRunner } from '../sandbox/index.js';
import type { ChangedFile, ScanOptions, ScanResult } from '../scan/index.js';
import type { SignerClient } from '../signer-client.js';
import { clientProjectVars, type VercelClient } from '../vercel.js';
import type { JobContext, WorkerLogger } from '../worker.js';
import type { AgentConfig, AgentGateway } from './agent.js';
import { PipelineError } from './errors.js';
import type { RepoSource } from './repo-snapshot.js';
import type { OnchainConfig } from './site-config.js';
import type { LaunchpadRecord, LaunchpadStore } from './store.js';

/** GitHub calls the pipeline makes (github.ts implements them). */
export type PipelineGithub = Pick<
  GithubClient,
  | 'ensureRepoFromTemplate'
  | 'getRepo'
  | 'protectDefaultBranch'
  | 'getBranchHead'
  | 'resetJobBranch'
  | 'commitFiles'
  | 'readFile'
  | 'mergeBranch'
  | 'compareCommits'
>;

/** Vercel calls the pipeline makes (vercel.ts implements them). */
export type PipelineVercel = Pick<
  VercelClient,
  | 'ensureProject'
  | 'setEnv'
  | 'pruneEnv'
  | 'createDeployment'
  | 'getDeployment'
  | 'waitForDeployment'
  | 'promoteToProduction'
  | 'attachSubdomain'
>;

export type PipelineSigner = Pick<SignerClient, 'createConfigs' | 'prepareLaunchCoin'>;

export type ScanFn = (files: ChangedFile[], options?: ScanOptions) => ScanResult;

export type BuildSiteFn = (
  runner: SandboxRunner,
  workdir: string,
  options: BuildSiteOptions,
) => Promise<BuildSiteResult>;

export interface PipelineConfig {
  cluster: SolanaCluster;
  /** Public variables of every client Vercel project (`pickProjectEnv` of vercel.ts). */
  projectEnv: Readonly<Record<string, string>>;
  /** Signs the per-launchpad relay token of each project (relay-token.ts). Never sent anywhere. */
  rpcRelayTokenSecret: string;
  /** Options of the blocking scan (RPC relay host, R2 public host...). */
  scanOptions: ScanOptions;
  agent: AgentConfig;
  /** Read-only packages token for `@forge/core`, used by the local install only. */
  packagesToken?: string;
  /** Owner of job folders when the builder runs as root (the sandbox writes as this uid). */
  sandboxUid?: number;
  sandboxGid?: number;
  /** Wait for a Vercel deployment to be READY. */
  deploymentTimeoutMs: number;
  /** Wait for a promotion to production to apply. */
  promotionTimeoutMs: number;
}

export const PIPELINE_DEFAULTS = {
  deploymentTimeoutMs: 15 * 60_000,
  promotionTimeoutMs: 5 * 60_000,
} as const;

export interface PipelineDeps {
  github: PipelineGithub;
  vercel: PipelineVercel;
  /** Reads a repository branch into memory to prepare the job folder. */
  repoSource: RepoSource;
  runner: SandboxRunner;
  buildSite: BuildSiteFn;
  gateway: AgentGateway;
  scan: ScanFn;
  signer: PipelineSigner;
  store: LaunchpadStore;
  alerter?: Pick<Alerter, 'alert'>;
  config: PipelineConfig;
  /** System prompt of the agent (default: prompts/builder.md). */
  systemPrompt?: string;
}

/** Branch holding the work of one job. */
export function jobBranch(jobId: string): string {
  return `forge/${jobId}`;
}

/** Thrown right before a side effect when the worker aborted the job. */
export class StepAbortedError extends Error {
  constructor(reason: unknown) {
    super(`step aborted (${typeof reason === 'string' ? reason : 'aborted'})`);
    this.name = 'StepAbortedError';
  }
}

/**
 * Must be called right before every external side effect (worker.ts abort contract): once the
 * signal is aborted, the worker has already recorded the job's outcome or someone else owns it.
 */
export function guard(signal: AbortSignal): void {
  if (signal.aborted) throw new StepAbortedError(signal.reason);
}

export interface LaunchpadContext {
  launchpad: LaunchpadRecord;
  spec: LaunchpadSpec;
  /** `lp-<slug>`. */
  repoName: string;
}

/** Reads the job's launchpad and checks its spec. Never trusts the jsonb blindly. */
export async function loadLaunchpad(deps: PipelineDeps, job: JobRow): Promise<LaunchpadContext> {
  const launchpad = await deps.store.getLaunchpad(job.launchpad_id);
  if (!launchpad) throw new PipelineError('launchpad not found');
  const parsed = LaunchpadSpec.safeParse(launchpad.spec);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new PipelineError(`launchpad spec is invalid: ${fields.join(', ')}`);
  }
  const spec = parsed.data;
  if (spec.slug !== launchpad.slug)
    throw new PipelineError('spec slug does not match the launchpad');
  if (spec.ownerWallet !== launchpad.owner_wallet) {
    throw new PipelineError('spec owner wallet does not match the launchpad owner');
  }
  if (launchpad.status === 'disabled') {
    throw new PipelineError('launchpad is disabled by FORGE: nothing is built or deployed');
  }
  const repoName = repoNameForSlug(spec.slug);
  if (launchpad.github_repo !== null && launchpad.github_repo !== repoName) {
    throw new PipelineError('recorded repository does not match the launchpad slug');
  }
  return { launchpad, spec, repoName };
}

/** `POOL_CONFIG_KEY` of a launchpad: the config its coins are created on, then its own coin's. */
export function poolConfigKeys(onchain: OnchainConfig | undefined): string | undefined {
  if (!onchain) return undefined;
  return [onchain.launchpadConfig, onchain.launchpadCoinConfig].join(',');
}

/**
 * Pushes the project variables (public ones, pool keys, the launchpad's relay token) before every
 * deployment, and prunes the rest.
 */
export async function syncProjectEnv(
  deps: PipelineDeps,
  signal: AbortSignal,
  projectId: string,
  slug: string,
  poolKeys: string | undefined,
): Promise<void> {
  const vars = clientProjectVars(deps.config.projectEnv, {
    slug,
    poolKeys,
    relayTokenSecret: deps.config.rpcRelayTokenSecret,
  });
  guard(signal);
  await deps.vercel.setEnv(projectId, vars);
  guard(signal);
  await deps.vercel.pruneEnv(projectId);
}

/**
 * Appends a client-visible event, unless the job was aborted (the job may belong to someone else
 * by then). Never throws.
 */
export async function say(ctx: JobContext, message: string): Promise<void> {
  if (ctx.signal.aborted) return;
  await ctx.event(message);
}

/** Sends an alert; never throws. */
export async function safeAlert(
  deps: PipelineDeps,
  level: 'immediate' | 'high' | 'normal',
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!deps.alerter) return;
  try {
    await deps.alerter.alert(level, code, message, details);
  } catch {
    /* alerting must never break a job */
  }
}

/** Logger fields shared by every line of a job. */
export function jobFields(
  job: JobRow,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jobId: job.id,
    launchpadId: job.launchpad_id,
    type: job.type,
    status: job.status,
    ...extra,
  };
}

export type { WorkerLogger };
