/// <reference types="node" />
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
import { assertNotPaused } from './sleep.js';
import {
  clientProjectVars,
  projectNameForSlug,
  type VercelClient,
  type VercelProject,
} from './vercel.js';
import type { WorkerLogger } from './worker.js';
import { sanitizeError } from './worker/messages.js';

/**
 * `launchpads.status = 'disabled'` cuts the site (docs/OPERATIONS.md kill switches, SECURITY.md:
 * "per-launchpad disabled flag that cuts the site"). The team sets the status; the builder makes
 * the deployed site follow, at startup and at every scheduler cycle:
 *
 *   preferred: forge.config.json `mode: disabled` on the default branch (builder-owned commit),
 *              production deployment of that commit, promotion -> the template's maintenance page
 *   fallback:  Vercel pause of the project (production and previews answer a pause page), when
 *              the maintenance page cannot be deployed (or `deploys_paused` is set: a pause
 *              deploys nothing)
 *
 * Idempotent: a site whose production deployment already serves `mode: disabled`, or whose
 * project is paused, is left alone (no commit, no deployment, no alert). The builder never
 * re-enables a site: the team does it by hand (mode back to live on the default branch, a release,
 * and an unpause if the fallback was used).
 */

export interface DisableDeps {
  store: Pick<SleepStore, 'getLaunchpad' | 'listDisabled'>;
  github: Pick<GithubClient, 'getRepo' | 'getBranchHead' | 'readFile' | 'commitFiles'>;
  vercel: Pick<
    VercelClient,
    | 'getProject'
    | 'getDeployment'
    | 'setEnv'
    | 'pruneEnv'
    | 'createDeployment'
    | 'waitForDeployment'
    | 'promoteToProduction'
    | 'pauseProject'
  >;
  /** Public variables of client projects (as for the pipeline). */
  projectEnv: Readonly<Record<string, string>>;
  /** Signs the per-launchpad relay token of each project (relay-token.ts). */
  rpcRelayTokenSecret: string;
  logger: WorkerLogger;
  /** `deploys_paused`: while set, the cut uses the pause (no deployment). */
  isPaused?: () => Promise<boolean>;
  alerter?: Pick<Alerter, 'alert'>;
  /** Rows read per page of disabled launchpads (every page is read). Default 50. */
  pageSize?: number;
  deploymentTimeoutMs?: number;
  promotionTimeoutMs?: number;
  /**
   * Sites already verified as cut, by launchpad id: the project state they were verified in. A
   * later sweep that finds the same state skips the verification reads.
   */
  verified?: Map<string, string>;
}

export type CutHow = 'maintenance' | 'paused';

export type CutOutcome =
  /** The launchpad is not (or no longer) disabled: nothing to cut. */
  | { state: 'not-disabled' }
  /** No Vercel project: nothing was ever deployed. */
  | { state: 'nothing-deployed' }
  | { state: 'already-cut'; how: CutHow }
  /** `reason`: why the fallback (pause) was used. */
  | { state: 'cut'; how: CutHow; reason?: string };

export interface DisableSweepResult {
  cut: Array<{ slug: string; how: CutHow; reason?: string }>;
  alreadyCut: number;
  nothingDeployed: number;
  failed: Array<{ slug: string; error: string }>;
}

/** Pages read per sweep at most (a guard against a runaway listing). */
const MAX_PAGES = 1_000;

const stateKey = (project: VercelProject): string =>
  `${project.id}|${project.productionDeploymentId ?? ''}|${project.paused}`;

/** True when the production deployment serves a `mode: disabled` build of the repo. */
async function productionServesDisabled(
  deps: DisableDeps,
  lp: LaunchpadRecord,
  deploymentId: string,
): Promise<boolean> {
  try {
    const production = await deps.vercel.getDeployment(deploymentId);
    if (production.commitSha === undefined) return false;
    const text = await deps.github.readFile(
      repoNameForSlug(lp.slug),
      SITE_CONFIG_PATH,
      production.commitSha,
    );
    return text !== null && typedSiteConfig(parseSiteConfig(text)).mode === 'disabled';
  } catch {
    // Unknown: the cut below is idempotent and settles it.
    return false;
  }
}

/** Commits `mode: disabled` (when needed), deploys it to production and promotes it. */
async function deployMaintenance(
  deps: DisableDeps,
  lp: LaunchpadRecord,
  project: VercelProject,
  signal: AbortSignal,
): Promise<'cut' | 'already-cut' | 'not-disabled'> {
  await assertNotPaused(deps);
  const repo = await deps.github.getRepo(repoNameForSlug(lp.slug));
  if (!repo) throw new PipelineError('the launchpad repository does not exist');
  const head = await deps.github.getBranchHead(repo.name, repo.defaultBranch);
  if (head === null) throw new PipelineError('the default branch does not exist');
  const text = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, head);
  if (text === null)
    throw new PipelineError('forge.config.json is missing from the default branch');
  const raw = parseSiteConfig(text);
  const config = typedSiteConfig(raw);
  if (config.slug !== lp.slug) throw new PipelineError('forge.config.json slug does not match');

  let sha = head;
  let committed = false;
  if (config.mode !== 'disabled') {
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: 'Disable the site (cut by FORGE)',
      files: [{ path: SITE_CONFIG_PATH, content: serializeSiteConfig(withMode(raw, 'disabled')) }],
      expectedHeadSha: head,
    });
    sha = commit.commitSha;
    committed = commit.committed;
  }

  const vars = clientProjectVars(deps.projectEnv, {
    slug: lp.slug,
    poolKeys: poolConfigKeys(config.onchain),
    relayTokenSecret: deps.rpcRelayTokenSecret,
  });
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
  // The team may have re-enabled the launchpad while the maintenance page was building.
  const current = await deps.store.getLaunchpad(lp.id);
  if (!current || current.status !== 'disabled') return 'not-disabled';
  await assertNotPaused(deps);
  guard(signal);
  const { promoted } = await deps.vercel.promoteToProduction(project.id, ready.id, {
    timeoutMs: deps.promotionTimeoutMs ?? 5 * 60_000,
  });
  return committed || promoted ? 'cut' : 'already-cut';
}

/** Makes the deployed site of one disabled launchpad cut. Throws when even the pause fails. */
export async function cutDisabledLaunchpad(
  deps: DisableDeps,
  launchpadId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<CutOutcome> {
  const lp = await deps.store.getLaunchpad(launchpadId);
  if (!lp || lp.status !== 'disabled') return { state: 'not-disabled' };
  const project = await deps.vercel.getProject(lp.vercel_project_id ?? projectNameForSlug(lp.slug));
  if (!project) return { state: 'nothing-deployed' };
  if (project.paused) return { state: 'already-cut', how: 'paused' };

  const pause = async (reason: string): Promise<CutOutcome> => {
    guard(signal);
    await deps.vercel.pauseProject(project.id);
    return { state: 'cut', how: 'paused', reason };
  };
  // Never released: previews may still be reachable. Pausing cuts them all.
  if (project.productionDeploymentId === undefined) return pause('no production deployment');

  const key = stateKey(project);
  if (deps.verified?.get(lp.id) === key) return { state: 'already-cut', how: 'maintenance' };
  if (await productionServesDisabled(deps, lp, project.productionDeploymentId)) {
    deps.verified?.set(lp.id, key);
    return { state: 'already-cut', how: 'maintenance' };
  }

  try {
    const done = await deployMaintenance(deps, lp, project, signal);
    if (done === 'not-disabled') return { state: 'not-disabled' };
    return done === 'cut'
      ? { state: 'cut', how: 'maintenance' }
      : { state: 'already-cut', how: 'maintenance' };
  } catch (err) {
    if (err instanceof StepAbortedError) throw err;
    // The maintenance page could not be deployed (template, build, deploys paused...): pause.
    return pause(sanitizeError(err));
  }
}

async function safeAlert(
  deps: DisableDeps,
  level: 'high' | 'normal',
  code: string,
  message: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!deps.alerter) return;
  await deps.alerter.alert(level, code, message, details).catch(() => undefined);
}

/**
 * One sweep over every disabled launchpad (page by page): cuts the sites that are still up and
 * alerts on each cut and each failure. One failure does not stop the others.
 */
export async function enforceDisabledLaunchpads(
  deps: DisableDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<DisableSweepResult> {
  const result: DisableSweepResult = { cut: [], alreadyCut: 0, nothingDeployed: 0, failed: [] };
  const size = Math.max(1, Math.trunc(deps.pageSize ?? 50));
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    guard(signal);
    const rows = await deps.store.listDisabled(size, after);
    for (const lp of rows) {
      guard(signal);
      try {
        const outcome = await cutDisabledLaunchpad(deps, lp.id, signal);
        if (outcome.state === 'already-cut') result.alreadyCut += 1;
        else if (outcome.state === 'nothing-deployed') result.nothingDeployed += 1;
        else if (outcome.state === 'cut') {
          result.cut.push({
            slug: lp.slug,
            how: outcome.how,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
          deps.logger.warn(
            { launchpadId: lp.id, slug: lp.slug, how: outcome.how, reason: outcome.reason },
            'disabled launchpad: site cut',
          );
          await safeAlert(
            deps,
            outcome.how === 'maintenance' ? 'normal' : 'high',
            `site_cut:${lp.slug}`,
            outcome.how === 'maintenance'
              ? 'Disabled launchpad: maintenance page deployed'
              : 'Disabled launchpad: Vercel project paused (the maintenance page could not be deployed)',
            { launchpad: lp.slug, ...(outcome.reason ? { reason: outcome.reason } : {}) },
          );
        }
      } catch (err) {
        if (err instanceof StepAbortedError) throw err;
        const error = sanitizeError(err);
        result.failed.push({ slug: lp.slug, error });
        deps.logger.error({ launchpadId: lp.id, slug: lp.slug, error }, 'could not cut the site');
        await safeAlert(
          deps,
          'high',
          `site_cut_failed:${lp.slug}`,
          'Disabled launchpad: the site could not be cut and may still be up',
          { launchpad: lp.slug, error },
        );
      }
    }
    const last = rows.at(-1);
    if (rows.length < size || !last) break;
    after = last.id;
  }
  if (result.cut.length > 0 || result.failed.length > 0) {
    deps.logger.info(
      {
        cut: result.cut.length,
        alreadyCut: result.alreadyCut,
        nothingDeployed: result.nothingDeployed,
        failed: result.failed.length,
      },
      'disabled sweep done',
    );
  }
  return result;
}
