import type { JobRow } from '@forge/shared';
import type { Violation } from '../scan/index.js';
import type { JobContext, JobOutcome } from '../worker.js';
import {
  guard,
  jobBranch,
  jobFields,
  loadLaunchpad,
  poolConfigKeys,
  safeAlert,
  say,
  syncProjectEnv,
  type PipelineDeps,
} from './context.js';
import { PipelineError, PolicyViolationError } from './errors.js';
import { STEP_EVENTS } from './messages.js';
import { scanRelease } from './release-scan.js';
import {
  parseSiteConfig,
  sameOnchain,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
  typedSiteConfig,
  withMode,
} from './site-config.js';
import type { BuildKind } from './build.js';

/**
 * The `deploying` step (creation after the owner signed, modification after approval):
 *
 *   checks of forge.config.json on forge/<jobId> -> merge into the default branch
 *   -> mode `live` (builder-owned commit, only when needed) -> env sync
 *   -> production deployment of that commit -> promotion -> subdomain -> launchpad `live`
 *
 * Every call is idempotent, so a re-run after a crash at any point converges: the merge answers
 * "already merged", Vercel returns the existing deployment of a commit, a promoted deployment is
 * not promoted again, an attached domain is reused. A failure is not retried automatically (D18).
 */
export async function runDeployStep(
  deps: PipelineDeps,
  job: JobRow,
  jobCtx: JobContext,
  kind: BuildKind,
): Promise<JobOutcome> {
  const { signal } = jobCtx;
  const { launchpad, spec, repoName } = await loadLaunchpad(deps, job);
  if (kind === 'modify' && launchpad.status === 'draft') {
    throw new PipelineError('a modification needs a launchpad that went live');
  }
  const repo = await deps.github.getRepo(repoName);
  if (!repo) throw new PipelineError('the launchpad repository does not exist');
  const branch = jobBranch(job.id);
  if ((await deps.github.getBranchHead(repo.name, branch)) === null) {
    throw new PipelineError('the job branch does not exist');
  }

  guard(signal);
  const { project } = await deps.vercel.ensureProject({ slug: spec.slug });
  if (!project.gitDeploymentsDisabled) {
    throw new PipelineError('git-triggered deployments are not disabled on the Vercel project');
  }
  if (launchpad.vercel_project_id !== project.id) {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, { vercel_project_id: project.id });
  }

  // What is about to be released: the job branch, checked against the default branch.
  const branchText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, branch);
  if (branchText === null)
    throw new PipelineError('forge.config.json is missing from the job branch');
  const branchConfig = typedSiteConfig(parseSiteConfig(branchText));
  const mainText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, repo.defaultBranch);
  const mainConfig = mainText === null ? null : typedSiteConfig(parseSiteConfig(mainText));
  const locked: Violation[] = [];
  const lockedField = (field: string): Violation => ({
    rule: 'forge-config-locked-field',
    file: SITE_CONFIG_PATH,
    line: null,
    reason: `field "${field}" differs from the released site`,
  });
  if (branchConfig.slug !== spec.slug) locked.push(lockedField('slug'));
  if (kind === 'create') {
    const onchain = branchConfig.onchain;
    if (!onchain) {
      throw new PipelineError(
        'forge.config.json has no on-chain section: the on-chain step did not complete',
      );
    }
    if (
      onchain.cluster !== deps.config.cluster ||
      onchain.ownerWallet !== spec.ownerWallet ||
      (launchpad.launchpad_config !== null &&
        onchain.launchpadConfig !== launchpad.launchpad_config) ||
      (launchpad.launchpad_coin_config !== null &&
        onchain.launchpadCoinConfig !== launchpad.launchpad_coin_config) ||
      (launchpad.launchpad_coin_mint !== null &&
        onchain.launchpadCoinMint !== launchpad.launchpad_coin_mint)
    ) {
      locked.push(lockedField('onchain'));
    }
  } else {
    if (!mainConfig)
      throw new PipelineError('forge.config.json is missing from the default branch');
    // A modification never changes the on-chain side, the name or the slug.
    if (!sameOnchain(branchConfig.onchain, mainConfig.onchain)) locked.push(lockedField('onchain'));
    if (branchConfig.name !== mainConfig.name) locked.push(lockedField('name'));
  }
  // Second scan: exactly what the merge brings in, as stored on GitHub (merge base -> branch).
  const release = await scanRelease(deps, repo.name, repo.defaultBranch, branch);
  const blocked = [...locked, ...release.violations];
  if (blocked.length > 0) {
    await safeAlert(
      deps,
      'high',
      `release_blocked:${job.id}`,
      'Release blocked: the job branch does not pass the release checks',
      {
        jobId: job.id,
        launchpad: spec.slug,
        violations: blocked.length,
        rules: [...new Set(blocked.map((v) => v.rule))].join(', '),
        files: [...new Set(blocked.map((v) => v.file))].slice(0, 5).join(', '),
      },
    );
    throw new PolicyViolationError(blocked);
  }
  jobCtx.logger.info(
    jobFields(job, {
      mergeBase: release.mergeBaseSha,
      head: release.headSha,
      changed: release.changed,
    }),
    'release scan passed',
  );

  // Merge (answers "already merged" on a re-run).
  await say(jobCtx, STEP_EVENTS.release);
  guard(signal);
  const merged = await deps.github.mergeBranch(repo.name, {
    base: repo.defaultBranch,
    head: branch,
    message: `Release job ${job.id}`,
  });
  const releasedText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, merged.sha);
  if (releasedText === null)
    throw new PipelineError('forge.config.json is missing after the merge');
  const releasedRaw = parseSiteConfig(releasedText);
  const released = typedSiteConfig(releasedRaw);
  if (!sameOnchain(released.onchain, branchConfig.onchain)) {
    throw new PipelineError(
      'the merged forge.config.json does not hold the expected on-chain section',
    );
  }
  let releaseSha = merged.sha;
  if (released.mode !== 'live') {
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: `Set the site mode to live (job ${job.id})`,
      files: [
        { path: SITE_CONFIG_PATH, content: serializeSiteConfig(withMode(releasedRaw, 'live')) },
      ],
    });
    releaseSha = commit.commitSha;
  }

  // Production deployment of exactly that commit, then promotion.
  await syncProjectEnv(deps, signal, project.id, poolConfigKeys(released.onchain));
  guard(signal);
  const deployment = await deps.vercel.createDeployment({
    project: { id: project.id, name: project.name },
    repo: repo.name,
    ref: repo.defaultBranch,
    sha: releaseSha,
    target: 'production',
  });
  const ready = await deps.vercel.waitForDeployment(deployment.id, {
    timeoutMs: deps.config.deploymentTimeoutMs,
  });
  guard(signal);
  await deps.vercel.promoteToProduction(project.id, ready.id, {
    timeoutMs: deps.config.promotionTimeoutMs,
  });

  await say(jobCtx, STEP_EVENTS.connectDomain);
  guard(signal);
  const domain = await deps.vercel.attachSubdomain(project.id, spec.slug);
  if (!domain.verified) {
    await safeAlert(
      deps,
      'normal',
      `domain_unverified:${spec.slug}`,
      'Client subdomain attached but not verified yet',
      {
        jobId: job.id,
        domain: domain.domain,
      },
    );
  }
  if (launchpad.status !== 'live') {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, { status: 'live' });
  }
  jobCtx.logger.info(
    jobFields(job, { deployment: ready.id, sha: releaseSha, domain: domain.domain }),
    'launchpad released',
  );
  return { message: STEP_EVENTS.live(domain.domain) };
}
