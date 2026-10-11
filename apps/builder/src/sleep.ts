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
  /** Rows read per page of candidates (every page is read). Default 50. */
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

/** `deploys_paused` was set (or could not be read): nothing more is deployed in this cycle. */
export class DeploysPausedError extends Error {
  readonly unreadable: boolean;
  constructor(unreadable = false) {
    super(
      unreadable
        ? 'deploys_paused could not be read: nothing is deployed'
        : 'deploys_paused is set: nothing is deployed',
    );
    this.name = 'DeploysPausedError';
    this.unreadable = unreadable;
  }
}

/**
 * Re-reads the `deploys_paused` kill switch right before a side effect. Fails closed: a switch that
 * cannot be read counts as set.
 */
export async function assertNotPaused(deps: Pick<SleepDeps, 'isPaused'>): Promise<void> {
  if (!deps.isPaused) return;
  let paused: boolean;
  try {
    paused = await deps.isPaused();
  } catch {
    throw new DeploysPausedError(true);
  }
  if (paused) throw new DeploysPausedError();
}

/**
 * Puts one launchpad in `sleeping` or back to `live`: mode commit (when needed), production
 * deployment of that commit, promotion, status. Throws on any problem. `deploys_paused` is
 * re-read before the commit, the deployment and the promotion (`DeploysPausedError`).
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
  const status: SleepTarget = lp.status;
  const repoName = repoNameForSlug(lp.slug);
  const repo = await deps.github.getRepo(repoName);
  if (!repo) throw new PipelineError('the launchpad repository does not exist');

  // Pin the head first: the config is read at that commit and the mode commit goes on top of it.
  let sha = await deps.github.getBranchHead(repo.name, repo.defaultBranch);
  if (sha === null) throw new PipelineError('the default branch does not exist');
  const text = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, sha);
  if (text === null)
    throw new PipelineError('forge.config.json is missing from the default branch');
  const raw = parseSiteConfig(text);
  const config = typedSiteConfig(raw);
  if (config.mode === 'disabled') throw new PipelineError('the site is disabled by FORGE');
  if (config.slug !== lp.slug) throw new PipelineError('forge.config.json slug does not match');

  let committed = false;
  if (config.mode !== target) {
    await assertNotPaused(deps);
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: target === 'sleeping' ? 'Put the site to sleep' : 'Wake the site up',
      files: [{ path: SITE_CONFIG_PATH, content: serializeSiteConfig(withMode(raw, target)) }],
      expectedHeadSha: sha,
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
  await assertNotPaused(deps);
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
  // Read the row and the switch again right before production changes: the team may have
  // disabled the launchpad or paused deploys while the deployment was building.
  const current = await deps.store.getLaunchpad(lp.id);
  if (!current) throw new PipelineError('launchpad not found');
  if (current.status === 'disabled') throw new PipelineError('launchpad is disabled by FORGE');
  if (current.status !== status) {
    throw new PipelineError(
      `the launchpad status changed during the mode change (${current.status})`,
    );
  }
  await assertNotPaused(deps);
  guard(signal);
  await deps.vercel.promoteToProduction(project.id, ready.id, {
    timeoutMs: deps.promotionTimeoutMs ?? 5 * 60_000,
  });
  if (status !== target) {
    guard(signal);
    // Conditional on the status read above: never overwrites a FORGE cut made meanwhile.
    await deps.store.updateLaunchpad(lp.id, { status: target }, { expectStatus: [status] });
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
  /** True when `deploys_paused` was set: nothing (or nothing more) was done. */
  paused: boolean;
  slept: string[];
  woken: string[];
  /** Launchpads skipped because a job is in flight, ran recently or failed after approval. */
  skipped: string[];
  failed: Array<{ slug: string; error: string }>;
}

/** Pages read per direction and cycle at most (a guard against a runaway listing). */
const MAX_PAGES = 1_000;

/**
 * One daily pass: dormant `live` launchpads go to sleep, `sleeping` ones that traded again wake
 * up. A launchpad with a job in flight, a job in the dormancy window (for sleeping), or a job that
 * failed after approval (on-chain or deploy stage: manual handling, D18) is left alone so the
 * cycle never races a build or a release, nor redeploys a site the team is repairing. One failure
 * does not stop the others.
 *
 * Candidates are read page by page (`batchSize` rows, keyset on the id) until the end of the
 * list, so skipped or failing launchpads at the head of the list can never starve the others.
 * `deploys_paused` is re-read before each launchpad: once it is set, the cycle stops.
 */
export async function runSleepCycle(
  deps: SleepDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<SleepCycleResult> {
  const result: SleepCycleResult = { paused: false, slept: [], woken: [], skipped: [], failed: [] };
  try {
    await assertNotPaused(deps);
  } catch (err) {
    if (!(err instanceof DeploysPausedError)) throw err;
    deps.logger.warn({ unreadable: err.unreadable }, `${err.message}: sleep cycle skipped`);
    return { ...result, paused: true };
  }
  const now = (deps.now ?? Date.now)();
  const days = deps.dormantDays ?? OPS.dormantDaysBeforeSleep;
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const batch = Math.max(1, Math.trunc(deps.batchSize ?? 50));

  /** False when the cycle must stop (deploys paused). */
  const apply = async (lp: LaunchpadRecord, target: SleepTarget): Promise<boolean> => {
    try {
      await assertNotPaused(deps);
      await setLaunchpadMode(deps, lp.id, target, signal);
      (target === 'sleeping' ? result.slept : result.woken).push(lp.slug);
      return true;
    } catch (err) {
      if (err instanceof StepAbortedError) throw err;
      if (err instanceof DeploysPausedError) {
        deps.logger.warn(
          { launchpadId: lp.id, slug: lp.slug, unreadable: err.unreadable },
          `${err.message}: sleep cycle stopped`,
        );
        result.paused = true;
        return false;
      }
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
      return true;
    }
  };

  const pass = async (
    list: (after: string | undefined) => Promise<LaunchpadRecord[]>,
    target: SleepTarget,
    activitySince: string,
  ): Promise<boolean> => {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      guard(signal);
      const rows = await list(after);
      for (const lp of rows) {
        guard(signal);
        if (await deps.store.hasJobActivity(lp.id, activitySince)) {
          result.skipped.push(lp.slug);
          continue;
        }
        if (!(await apply(lp, target))) return false;
      }
      const last = rows.at(-1);
      if (rows.length < batch || !last) return true;
      after = last.id;
    }
    deps.logger.warn({ target, pages: MAX_PAGES }, 'sleep cycle stopped at the page limit');
    return true;
  };

  const goOn = await pass(
    (after) => deps.store.listDormant(cutoff, batch, after),
    'sleeping',
    cutoff,
  );
  // Only a job in flight (or a failed release) blocks a wake-up: a modification release wakes the
  // site itself.
  if (goOn) await pass((after) => deps.store.listWoken(cutoff, batch, after), 'live', nowIso);
  deps.logger.info(
    {
      slept: result.slept.length,
      woken: result.woken.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      paused: result.paused,
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
