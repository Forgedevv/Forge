/// <reference types="node" />
import { OPS, type SiteMode } from '@forge/shared';
import type { Alerter } from './alerts.js';
import { repoNameForSlug, type GithubClient } from './github.js';
import { guard, poolConfigKeys, StepAbortedError } from './pipeline/context.js';
import { PipelineError } from './pipeline/errors.js';
import {
  parseSiteConfig,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
  typedSiteConfig,
  withMode,
} from './pipeline/site-config.js';
import type { LaunchpadRecord, SleepStore } from './pipeline/store.js';
import type { VercelClient } from './vercel.js';
import type { WorkerLogger } from './worker.js';
import { sanitizeError } from './worker/messages.js';

/**
 * Sleep mode (docs/OPERATIONS.md): a launchpad with no trade and no job for
 * `OPS.dormantDaysBeforeSleep` days goes to `sleeping`, and comes back when it trades again.
 *
 * Mechanism: the builder sets `forge.config.json#mode` on the default branch (a builder-owned
 * commit), then deploys that commit to production and promotes it. With `mode: sleeping` the
 * template serves its lightweight static page only (no wallet, no RPC, no Jupiter data); the coin
 * stays tradable on Meteora and Jupiter. `launchpads.status` follows. A site whose mode is
 * `disabled` (cut by FORGE) is never touched here.
 *
 * Every step is idempotent: a re-run after a crash finds the mode already set, gets the existing
 * deployment of the commit back from Vercel, and does not promote twice.
 */

export type SleepTarget = Extract<SiteMode, 'sleeping' | 'live'>;

export interface SleepDeps {
  store: SleepStore;
  github: Pick<GithubClient, 'getRepo' | 'getBranchHead' | 'readFile' | 'commitFiles'>;
  vercel: Pick<
    VercelClient,
    | 'ensureProject'
    | 'setEnv'
    | 'pruneEnv'
    | 'createDeployment'
    | 'waitForDeployment'
    | 'promoteToProduction'
  >;
  /** Public variables of client projects (as for the pipeline). */
  projectEnv: Readonly<Record<string, string>>;
  logger: WorkerLogger;
  /** `deploys_paused` kill switch: nothing is deployed while it is set. */
  isPaused?: () => Promise<boolean>;
  alerter?: Pick<Alerter, 'alert'>;
  now?: () => number;
  /** Default OPS.dormantDaysBeforeSleep. */
  dormantDays?: number;
  /** Launchpads handled per direction and cycle. Default 50. */
  batchSize?: number;
  deploymentTimeoutMs?: number;
  promotionTimeoutMs?: number;
}

export interface ModeChange {
  launchpadId: string;
  slug: string;
  mode: SleepTarget;
  /** False when the site was already in that mode and deployed. */
  committed: boolean;
  deploymentId: string;
}

const DAY_MS = 86_400_000;

/**
 * Puts one launchpad in `sleeping` or back to `live`: mode commit (when needed), production
 * deployment of that commit, promotion, status. Throws on any problem.
 */
export async function setLaunchpadMode(
  deps: SleepDeps,
  launchpadId: string,
  target: SleepTarget,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModeChange> {
  const lp = await deps.store.getLaunchpad(launchpadId);
  if (!lp) throw new PipelineError('launchpad not found');
  if (lp.status === 'disabled') throw new PipelineError('launchpad is disabled by FORGE');
  if (lp.status === 'draft') throw new PipelineError('launchpad was never released');
  const repoName = repoNameForSlug(lp.slug);
  const repo = await deps.github.getRepo(repoName);
  if (!repo) throw new PipelineError('the launchpad repository does not exist');

  const text = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, repo.defaultBranch);
  if (text === null)
    throw new PipelineError('forge.config.json is missing from the default branch');
  const raw = parseSiteConfig(text);
  const config = typedSiteConfig(raw);
  if (config.mode === 'disabled') throw new PipelineError('the site is disabled by FORGE');
  if (config.slug !== lp.slug) throw new PipelineError('forge.config.json slug does not match');

  let sha = await deps.github.getBranchHead(repo.name, repo.defaultBranch);
  if (sha === null) throw new PipelineError('the default branch does not exist');
  let committed = false;
  if (config.mode !== target) {
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: target === 'sleeping' ? 'Put the site to sleep' : 'Wake the site up',
      files: [{ path: SITE_CONFIG_PATH, content: serializeSiteConfig(withMode(raw, target)) }],
    });
    sha = commit.commitSha;
    committed = commit.committed;
  }

  guard(signal);
  const { project } = await deps.vercel.ensureProject({ slug: lp.slug });
  if (!project.gitDeploymentsDisabled) {
    throw new PipelineError('git-triggered deployments are not disabled on the Vercel project');
  }
  const vars: Record<string, string> = { ...deps.projectEnv };
  const poolKeys = poolConfigKeys(config.onchain);
  if (poolKeys) {
    vars.POOL_CONFIG_KEY = poolKeys;
    vars.NEXT_PUBLIC_POOL_CONFIG_KEY = poolKeys;
  }
  guard(signal);
  await deps.vercel.setEnv(project.id, vars);
  guard(signal);
  await deps.vercel.pruneEnv(project.id);
  guard(signal);
  const deployment = await deps.vercel.createDeployment({
    project: { id: project.id, name: project.name },
    repo: repo.name,
    ref: repo.defaultBranch,
    sha,
    target: 'production',
  });
  const ready = await deps.vercel.waitForDeployment(deployment.id, {
    timeoutMs: deps.deploymentTimeoutMs ?? 15 * 60_000,
  });
  guard(signal);
  await deps.vercel.promoteToProduction(project.id, ready.id, {
    timeoutMs: deps.promotionTimeoutMs ?? 5 * 60_000,
  });
  if (lp.status !== target) {
    guard(signal);
    await deps.store.updateLaunchpad(lp.id, { status: target });
  }
  deps.logger.info(
    { launchpadId: lp.id, slug: lp.slug, mode: target, deployment: ready.id, sha },
    target === 'sleeping' ? 'launchpad put to sleep' : 'launchpad woken up',
  );
  return { launchpadId: lp.id, slug: lp.slug, mode: target, committed, deploymentId: ready.id };
}

/** Puts a launchpad to sleep. */
export function sleepLaunchpad(deps: SleepDeps, launchpadId: string, signal?: AbortSignal) {
  return setLaunchpadMode(deps, launchpadId, 'sleeping', signal);
}

/** Brings a sleeping launchpad back to `live` (also the entry point for a dashboard request). */
export function wakeLaunchpad(deps: SleepDeps, launchpadId: string, signal?: AbortSignal) {
  return setLaunchpadMode(deps, launchpadId, 'live', signal);
}

export interface SleepCycleResult {
  /** True when `deploys_paused` was set: nothing was done. */
  paused: boolean;
  slept: string[];
  woken: string[];
  /** Launchpads skipped because a job is in flight or ran recently. */
  skipped: string[];
  failed: Array<{ slug: string; error: string }>;
}

/**
 * One daily pass: dormant `live` launchpads go to sleep, `sleeping` ones that traded again wake
 * up. A launchpad with a job in flight (or, for sleeping, a job in the dormancy window) is left
 * alone so the cycle never races a build or a release. One failure does not stop the others.
 */
export async function runSleepCycle(
  deps: SleepDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<SleepCycleResult> {
  const result: SleepCycleResult = { paused: false, slept: [], woken: [], skipped: [], failed: [] };
  if (deps.isPaused && (await deps.isPaused())) {
    deps.logger.warn({}, 'deploys_paused is set: sleep cycle skipped');
    return { ...result, paused: true };
  }
  const now = (deps.now ?? Date.now)();
  const days = deps.dormantDays ?? OPS.dormantDaysBeforeSleep;
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const batch = deps.batchSize ?? 50;

  const apply = async (lp: LaunchpadRecord, target: SleepTarget): Promise<void> => {
    try {
      await setLaunchpadMode(deps, lp.id, target, signal);
      (target === 'sleeping' ? result.slept : result.woken).push(lp.slug);
    } catch (err) {
      if (err instanceof StepAbortedError) throw err;
      const error = sanitizeError(err);
      result.failed.push({ slug: lp.slug, error });
      deps.logger.error(
        { launchpadId: lp.id, slug: lp.slug, target, error },
        'sleep mode change failed',
      );
      if (deps.alerter) {
        await deps.alerter
          .alert('normal', `sleep_failed:${lp.slug}`, `Could not set the site mode to ${target}`, {
            launchpad: lp.slug,
            error,
          })
          .catch(() => undefined);
      }
    }
  };

  for (const lp of await deps.store.listDormant(cutoff, batch)) {
    guard(signal);
    if (await deps.store.hasJobActivity(lp.id, cutoff)) {
      result.skipped.push(lp.slug);
      continue;
    }
    await apply(lp, 'sleeping');
  }
  for (const lp of await deps.store.listWoken(cutoff, batch)) {
    guard(signal);
    // Only a job in flight blocks a wake-up (a modification release wakes the site itself).
    if (await deps.store.hasJobActivity(lp.id, nowIso)) {
      result.skipped.push(lp.slug);
      continue;
    }
    await apply(lp, 'live');
  }
  deps.logger.info(
    {
      slept: result.slept.length,
      woken: result.woken.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    'sleep cycle done',
  );
  return result;
}

export interface SleepScheduler {
  /** Stops scheduling, aborts the running cycle before its next side effect, waits for it. */
  stop(): Promise<void>;
}

/** Runs `runSleepCycle` after `initialDelayMs`, then every `intervalMs` (default 24 h). */
export function startSleepScheduler(
  deps: SleepDeps,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): SleepScheduler {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runSleepCycle(deps, controller.signal)
        .then(
          () => undefined,
          (err: unknown) => {
            if (err instanceof StepAbortedError) return;
            deps.logger.error({ error: sanitizeError(err) }, 'sleep cycle failed');
          },
        )
        .finally(() => {
          running = undefined;
          schedule(intervalMs);
        });
    }, delay);
    timer.unref?.();
  };
  schedule(opts.initialDelayMs ?? 10 * 60_000);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort('shutdown');
      await running;
    },
  };
}
