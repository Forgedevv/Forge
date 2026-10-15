import type { JobRow } from '@forge/shared';
import type { Violation } from '../scan/index.js';
import type { JobContext, JobOutcome } from '../worker.js';
import {
  guard,
  jobBranch,
  jobFields,
  loadLaunchpad,
  poolConfigKeys,
  recordVercelProject,
  safeAlert,
  say,
  syncProjectEnv,
  type PipelineDeps,
} from './context.js';
import { PipelineError, PolicyViolationError } from './errors.js';
import { STEP_EVENTS } from './messages.js';
import { scanRelease } from './release-scan.js';
import { chooseSiteHost } from './site-host.js';
import { StoreError } from './store.js';
import { deepEqual } from '../scan/manifest.js';
import { isProductionNotStaged, type VercelDeployment } from '../vercel.js';
import {
  parseSiteConfig,
  sameOnchain,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
  typedSiteConfig,
  withMode,
  withOnchain,
  type RawSiteConfig,
} from './site-config.js';
import type { BuildKind } from './build.js';

/**
 * The `deploying` step (creation after the owner signed, modification after approval):
 *
 *   checks of forge.config.json on forge/<jobId> -> merge into the default branch
 *   -> mode `live` (builder-owned commit, only when needed) -> env sync
 *   -> production deployment of that commit -> promotion -> subdomain
 *   -> site host (`launchpads.site_host`, from the Vercel aliases) -> launchpad `live`
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
  // Pin the job branch: everything below is checked, scanned and merged at this exact commit,
  // whatever is pushed to the branch meanwhile.
  const headSha = await deps.github.getBranchHead(repo.name, branch);
  if (headSha === null) throw new PipelineError('the job branch does not exist');

  guard(signal);
  const { project } = await deps.vercel.ensureProject({ slug: spec.slug });
  if (!project.gitDeploymentsDisabled) {
    throw new PipelineError('git-triggered deployments are not disabled on the Vercel project');
  }
  if (launchpad.vercel_project_id !== project.id) {
    guard(signal);
    await recordVercelProject(deps.store, launchpad, project.id);
  }

  // What the client approved: the commit of the preview deployment they were shown.
  const previewSha = await approvedPreviewCommit(deps, job, project.id);

  // What is about to be released: the pinned commit, checked against the default branch.
  const branchText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, headSha);
  if (branchText === null)
    throw new PipelineError('forge.config.json is missing from the job branch');
  const branchRaw = parseSiteConfig(branchText);
  const branchConfig = typedSiteConfig(branchRaw);
  // Pin the default branch too: the release must go on top of exactly this commit.
  const mainHead = await deps.github.getBranchHead(repo.name, repo.defaultBranch);
  if (mainHead === null) throw new PipelineError('the default branch does not exist');
  const mainText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, mainHead);
  const mainRaw = mainText === null ? null : parseSiteConfig(mainText);
  const mainConfig = mainRaw === null ? null : typedSiteConfig(mainRaw);
  // A site cut by FORGE is never brought back by a release (only the team re-enables it).
  if (mainConfig?.mode === 'disabled' || branchConfig.mode === 'disabled') {
    throw new PipelineError('the site is disabled by FORGE (forge.config.json mode): no release');
  }
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
  // Second scan: exactly what the merge brings in, as stored on GitHub (merge base -> commit).
  const release = await scanRelease(deps, repo.name, mainHead, headSha);
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
  // Nothing but the approved preview (plus, for a creation, the builder's on-chain commit).
  await checkApprovedHead(deps, job, repo.name, kind, previewSha, headSha, branchRaw);

  await say(jobCtx, STEP_EVENTS.release);
  let mergedSha: string;
  if (release.mergeBaseSha === mainHead) {
    // The branch starts from the current head of the default branch: the merge brings in
    // exactly the scanned diff.
    guard(signal);
    const merged = await deps.github.mergeBranch(repo.name, {
      base: repo.defaultBranch,
      head: headSha,
      message: `Release job ${job.id}`,
    });
    mergedSha = merged.sha;
  } else if (release.mergeBaseSha === headSha) {
    // Re-run after a crash: the commit is already in the default branch. Only the builder's mode
    // commit may sit on top of it.
    if (mainRaw === null || !(await onlyModeChangedSince(deps, repo.name, headSha, mainHead))) {
      throw new PipelineError(
        'the job branch is already in the default branch, which changed since: manual handling required',
      );
    }
    mergedSha = mainHead;
  } else {
    throw new PipelineError(
      'the default branch moved since the preview was built (the merge base is not its head): the release needs manual handling',
    );
  }
  const releasedText = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, mergedSha);
  if (releasedText === null)
    throw new PipelineError('forge.config.json is missing after the merge');
  const releasedRaw = parseSiteConfig(releasedText);
  const released = typedSiteConfig(releasedRaw);
  if (released.mode === 'disabled') {
    // The default branch was cut while the release was merging: never turned back to live.
    throw new PipelineError('the released site is disabled by FORGE: it stays cut');
  }
  if (!sameOnchain(released.onchain, branchConfig.onchain)) {
    throw new PipelineError(
      'the merged forge.config.json does not hold the expected on-chain section',
    );
  }
  // What is deployed must be what was scanned: the merge result holds exactly the tree of the
  // scanned commit (the default branch did not move in between), up to the builder's mode.
  if (!(await onlyModeChangedSince(deps, repo.name, headSha, mergedSha))) {
    throw new PipelineError(
      'the default branch moved during the release: the merge brought in unscanned changes; manual handling required',
    );
  }
  let releaseSha = mergedSha;
  if (released.mode === 'sleeping') {
    // A release wakes a sleeping site (only `sleeping` ever becomes `live` here).
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: `Set the site mode to live (job ${job.id})`,
      files: [
        { path: SITE_CONFIG_PATH, content: serializeSiteConfig(withMode(releasedRaw, 'live')) },
      ],
      expectedHeadSha: mergedSha,
    });
    releaseSha = commit.commitSha;
  }

  // Production deployment of exactly that commit, then promotion. The deployment is staged
  // (vercel.ts): the production domains only move with the promotion, after the re-read below.
  await syncProjectEnv(deps, signal, project.id, spec.slug, poolConfigKeys(released.onchain));
  guard(signal);
  const deployment = await deps.vercel.createDeployment({
    project: { id: project.id, name: project.name },
    repo: repo.name,
    ref: repo.defaultBranch,
    sha: releaseSha,
    target: 'production',
  });
  let ready: VercelDeployment;
  try {
    ready = await deps.vercel.waitForDeployment(deployment.id, {
      timeoutMs: deps.config.deploymentTimeoutMs,
    });
  } catch (err) {
    if (isProductionNotStaged(err)) {
      // Production moved to the release before the checks below and the promotion: refused,
      // and the team is told the release is already public.
      await safeAlert(
        deps,
        'high',
        `production_not_staged:${spec.slug}`,
        'A production deployment went live before its checks and its promotion (Vercel did not stage it)',
        { jobId: job.id, launchpad: spec.slug, deployment: deployment.id, sha: releaseSha },
      );
    }
    throw err;
  }
  // The build took minutes: the team may have disabled the launchpad meanwhile. Read it again
  // right before production changes (loadLaunchpad refuses a disabled launchpad).
  const current = await loadLaunchpad(deps, job);
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
  // The exact host the site is served at, as Vercel reports it for this project and this
  // deployment (site-host.ts). Recorded on every release, so a re-run writes the same value and a
  // host that no longer serves the site is dropped. A verified subdomain wins without waiting;
  // otherwise the aliases get a short while to reach the promoted deployment.
  const productionHosts = await deps.vercel.listProductionHosts(project.id, ready.id, {
    timeoutMs: domain.verified ? 0 : Math.min(SITE_HOST_WAIT_MS, deps.config.promotionTimeoutMs),
  });
  const siteHost = chooseSiteHost({
    slug: spec.slug,
    clientsDomain: deps.config.clientsDomain,
    subdomain: domain,
    productionHosts,
  });
  if (siteHost === null) {
    await safeAlert(
      deps,
      'high',
      `site_host_missing:${spec.slug}`,
      'No verified host serves the released client site: browsers cannot reach FORGE from it',
      { jobId: job.id, domain: domain.domain, productionHosts: productionHosts.length },
    );
  }
  guard(signal);
  try {
    await deps.store.updateLaunchpad(launchpad.id, { site_host: siteHost });
  } catch (err) {
    if (err instanceof StoreError && err.status === 409) {
      // `launchpads.site_host` is unique: another launchpad already holds this host. The release
      // is in production, but the host is not recorded for this site.
      await safeAlert(
        deps,
        'high',
        `site_host_conflict:${spec.slug}`,
        'The released site host is already recorded for another launchpad: not recorded for this one',
        { jobId: job.id, launchpad: spec.slug, siteHost, deployment: ready.id },
      );
    }
    throw err;
  }
  if (current.launchpad.status !== 'live') {
    guard(signal);
    // Conditional: never applies to a launchpad disabled in the meantime (fails the step).
    await deps.store.updateLaunchpad(launchpad.id, { status: 'live' });
  }
  jobCtx.logger.info(
    jobFields(job, { deployment: ready.id, sha: releaseSha, domain: domain.domain, siteHost }),
    'launchpad released',
  );
  return { message: STEP_EVENTS.live(siteHost ?? domain.domain) };
}

/** Longest wait for the production aliases to point at a promoted deployment. */
const SITE_HOST_WAIT_MS = 60_000;

/** `https://<deployment host>` as stored by the build step. */
const PREVIEW_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/?$/;

/**
 * Commit of the preview the client approved: `jobs.preview_url` points to the immutable Vercel
 * deployment the build step created for the scanned commit, and Vercel reports its git commit.
 * Fails closed when any of it is missing.
 */
async function approvedPreviewCommit(
  deps: PipelineDeps,
  job: JobRow,
  projectId: string,
): Promise<string> {
  const url = job.preview_url;
  if (url === null || !PREVIEW_URL_RE.test(url)) {
    throw new PipelineError('the job has no preview deployment: nothing was approved');
  }
  const preview = await deps.vercel.getDeployment(url);
  if (preview.projectId === undefined) {
    throw new PipelineError('the preview deployment does not report its Vercel project');
  }
  if (preview.projectId !== projectId) {
    throw new PipelineError('the preview deployment belongs to another Vercel project');
  }
  if (preview.target !== 'preview') {
    throw new PipelineError('the approved deployment is not a preview deployment');
  }
  if (preview.commitSha === undefined) {
    throw new PipelineError('the preview deployment does not report its commit');
  }
  return preview.commitSha;
}

/**
 * The release must be exactly the commit the client approved. A creation may carry one more
 * commit on top of it: the builder's own, which only adds `onchain` to forge.config.json (the
 * on-chain step runs after the approval). Anything else pushed to the branch is refused.
 */
async function checkApprovedHead(
  deps: PipelineDeps,
  job: JobRow,
  repo: string,
  kind: BuildKind,
  previewSha: string,
  headSha: string,
  headConfig: RawSiteConfig,
): Promise<void> {
  if (headSha === previewSha) return;
  const refuse = async (detail: string): Promise<never> => {
    await safeAlert(
      deps,
      'high',
      `release_unapproved:${job.id}`,
      'Release blocked: the job branch is not the approved preview',
      { jobId: job.id, detail, previewSha, headSha },
    );
    throw new PipelineError(`the job branch is not the approved preview: ${detail}`);
  };
  if (kind === 'modify') return refuse('the branch changed after the preview');
  const cmp = await deps.github.compareCommits(repo, previewSha, headSha);
  if (cmp.mergeBaseSha !== previewSha || cmp.behindBy !== 0 || cmp.aheadBy !== 1) {
    return refuse('more than the on-chain commit on top of the preview');
  }
  if (cmp.files.length !== 1 || cmp.files[0]?.path !== SITE_CONFIG_PATH) {
    return refuse('the commit after the preview changes more than forge.config.json');
  }
  const previewText = await deps.github.readFile(repo, SITE_CONFIG_PATH, previewSha);
  if (previewText === null) return refuse('the preview has no forge.config.json');
  const previewConfig = parseSiteConfig(previewText);
  const onchain = typedSiteConfig(headConfig).onchain;
  if (previewConfig.onchain !== undefined || onchain === undefined) {
    return refuse('the commit after the preview is not the on-chain commit');
  }
  if (!deepEqual(withOnchain(previewConfig, onchain), headConfig)) {
    return refuse('the commit after the preview changes more than the on-chain section');
  }
}

/**
 * True when `to` holds exactly the tree of `from`, except possibly the `mode` of
 * forge.config.json (the builder's own mode commit).
 */
async function onlyModeChangedSince(
  deps: PipelineDeps,
  repo: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (from === to) return true;
  const cmp = await deps.github.compareCommits(repo, from, to);
  if (cmp.mergeBaseSha !== from) return false;
  if (cmp.files.some((f) => f.path !== SITE_CONFIG_PATH)) return false;
  if (cmp.files.length === 0) return true;
  const [before, after] = await Promise.all([
    deps.github.readFile(repo, SITE_CONFIG_PATH, from),
    deps.github.readFile(repo, SITE_CONFIG_PATH, to),
  ]);
  if (before === null || after === null) return false;
  const a = parseSiteConfig(before);
  const b = parseSiteConfig(after);
  return deepEqual(withMode(a, 'live'), withMode(b, 'live'));
}
