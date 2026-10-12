import type { JobRow } from '@forge/shared';
import type { RepoFile, RepoInfo } from '../github.js';
import type { SandboxRunner } from '../sandbox/index.js';
import { resolveConfig, hostMatches } from '../scan/config.js';
import type { Violation } from '../scan/index.js';
import type { JobContext, JobOutcome } from '../worker.js';
import {
  builderSystemPrompt,
  createTaskPrompt,
  MAX_REQUEST_CHARS,
  modifyTaskPrompt,
} from '../prompts/index.js';
import { runAgent } from './agent.js';
import {
  guard,
  jobBranch,
  jobFields,
  loadLaunchpad,
  poolConfigKeys,
  safeAlert,
  say,
  syncProjectEnv,
  type LaunchpadContext,
  type PipelineDeps,
} from './context.js';
import { PipelineError, PolicyViolationError, SiteBuildError } from './errors.js';
import { STEP_EVENTS } from './messages.js';
import type { RepoSnapshot } from './repo-snapshot.js';
import {
  checkAgentSiteConfig,
  initialSiteConfig,
  parseSiteConfig,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
  typedSiteConfig,
  withMode,
  type OnchainConfig,
} from './site-config.js';
import { scanInput } from './scan-input.js';
import {
  createWorkdir,
  readWorkdirTree,
  removeWorkdir,
  writeWorkdirFiles,
  type BaselineFile,
  type WorkdirFile,
} from './workdir.js';

/**
 * The `building` step, shared by creation and modification jobs:
 *
 *   repo (create: from the template) -> Vercel project (git deployments off, before any push)
 *   -> job folder from the default branch (+ forge.config.json from the spec on creation)
 *   -> agent in the sandbox, through the gateway (budget, timeout)
 *   -> blocking scan of the diff + forge.config.json check   <- BEFORE any install or build
 *   -> local install + build in the sandbox (the build itself has no network)
 *   -> commit of the scanned bytes to forge/<jobId>
 *   -> env sync + explicit Vercel preview deployment -> preview_url
 *
 * Re-run safe: every external call is idempotent (existing repo/project reused, env upserted,
 * branch mirrored to the new result, one deployment per commit), and each attempt starts from a
 * clean checkout of the default branch.
 */

export type BuildKind = 'create' | 'modify';

interface Baseline {
  files: WorkdirFile[];
  map: Map<string, BaselineFile>;
  /** forge.config.json as written by the builder (the agent's version is checked against it). */
  configText: string;
  /** forge.config.json whose theme/content the scan compares to (template sample, live site). */
  configReference: string | null;
  onchain: OnchainConfig | undefined;
}

/** Files the agent starts from: the default branch, plus the builder's forge.config.json. */
export function prepareBaseline(
  kind: BuildKind,
  snapshot: RepoSnapshot,
  ctx: LaunchpadContext,
): Baseline {
  const files = snapshot.files.filter((f) => f.path !== SITE_CONFIG_PATH);
  const existing = snapshot.files.find((f) => f.path === SITE_CONFIG_PATH);
  let configText: string;
  if (kind === 'create') {
    configText = serializeSiteConfig(initialSiteConfig(ctx.spec));
  } else {
    if (!existing) throw new PipelineError('forge.config.json is missing from the launchpad repo');
    configText = existing.content.toString('utf8');
    const current = parseSiteConfig(configText);
    const mode = typedSiteConfig(current).mode;
    if (mode === 'disabled') {
      throw new PipelineError('the site is disabled by FORGE: it cannot be modified');
    }
    if (mode === 'sleeping') {
      // The modification is previewed, then released, as a live site (the release wakes it up):
      // the builder's baseline says `live`, so the preview shows the site the client will get.
      configText = serializeSiteConfig(withMode(current, 'live'));
    }
  }
  const config = typedSiteConfig(parseSiteConfig(configText));
  if (config.slug !== ctx.spec.slug) {
    throw new PipelineError('forge.config.json slug does not match the launchpad');
  }
  if (kind === 'modify' && !config.onchain) {
    throw new PipelineError('the launchpad has no on-chain configuration yet: nothing to modify');
  }
  files.push({
    path: SITE_CONFIG_PATH,
    content: Buffer.from(configText, 'utf8'),
    executable: false,
  });
  const map = new Map<string, BaselineFile>();
  for (const f of files) map.set(f.path, { content: f.content, executable: f.executable });
  const configReference =
    kind === 'create' ? (existing?.content.toString('utf8') ?? null) : configText;
  return { files, map, configText, configReference, onchain: config.onchain };
}

/** Image URLs worth showing to the agent: only those the scan lets the site load. */
function allowedImageUrls(
  deps: PipelineDeps,
  urls: { logoUrl?: string | undefined; coinImageUrl?: string | undefined },
): { logoUrl?: string; coinImageUrl?: string } {
  const hosts = resolveConfig(deps.config.scanOptions).allowedHosts;
  const ok = (u: string | undefined): u is string => {
    if (!u) return false;
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && hostMatches(url.hostname, hosts);
    } catch {
      return false;
    }
  };
  return {
    ...(ok(urls.logoUrl) ? { logoUrl: urls.logoUrl } : {}),
    ...(ok(urls.coinImageUrl) ? { coinImageUrl: urls.coinImageUrl } : {}),
  };
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.rule}|${v.file}|${v.line ?? ''}|${v.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Last lines of the build logs, for `jobs.error` (already redacted by the sandbox). */
function logTail(logs: string, lines = 6): string {
  return logs
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' | ')
    .slice(0, 300);
}

/** Runs the agent and gates its result. Returns the scanned files to commit. */
async function codeAndCheck(
  deps: PipelineDeps,
  job: JobRow,
  jobCtx: JobContext,
  kind: BuildKind,
  lp: LaunchpadContext,
  baseline: Baseline,
): Promise<RepoFile[]> {
  const { signal } = jobCtx;
  const log = jobCtx.logger;
  const workdir = await createWorkdir({
    jobsRoot: deps.runner.config.jobsRoot,
    jobId: job.id,
    attempt: job.attempts,
    ...(deps.config.sandboxUid !== undefined ? { uid: deps.config.sandboxUid } : {}),
    ...(deps.config.sandboxGid !== undefined ? { gid: deps.config.sandboxGid } : {}),
  });
  try {
    await writeWorkdirFiles(workdir, baseline.files, {
      ...(deps.config.sandboxUid !== undefined ? { uid: deps.config.sandboxUid } : {}),
      ...(deps.config.sandboxGid !== undefined ? { gid: deps.config.sandboxGid } : {}),
    });

    // 1. The agent codes the design (or applies the modification).
    let taskPrompt: string;
    if (kind === 'create') {
      taskPrompt = createTaskPrompt(lp.spec, {
        imageUrls: allowedImageUrls(deps, {
          logoUrl: lp.spec.theme.logoUrl,
          coinImageUrl: lp.spec.launchpadCoin.imageUrl,
        }),
      });
    } else {
      const request = (job.request ?? '').trim();
      if (request.length === 0) throw new PipelineError('the modification request is empty');
      if (request.length > MAX_REQUEST_CHARS) {
        throw new PipelineError(
          `the modification request is longer than ${MAX_REQUEST_CHARS} characters`,
        );
      }
      taskPrompt = modifyTaskPrompt(request, { name: lp.spec.name, slug: lp.spec.slug });
    }
    await say(jobCtx, kind === 'create' ? STEP_EVENTS.codeDesign : STEP_EVENTS.applyChanges);
    const agent = await runAgent(
      { runner: deps.runner, gateway: deps.gateway, config: deps.config.agent },
      {
        jobId: job.id,
        workdir,
        systemPrompt: deps.systemPrompt ?? builderSystemPrompt(),
        taskPrompt,
        signal,
      },
    );
    log.info(
      jobFields(job, { turns: agent.turns, durationMs: agent.durationMs }),
      'agent finished',
    );

    // 2. Blocking scan of everything the agent left, before anything is installed or built.
    await say(jobCtx, STEP_EVENTS.checkChanges);
    const tree = await readWorkdirTree(workdir);
    const changes = scanInput({
      baseline: baseline.map,
      tree,
      configReference: baseline.configReference,
    });
    const violations: Violation[] = [];
    const scan = deps.scan(changes, deps.config.scanOptions);
    if (!scan.ok) violations.push(...scan.violations);
    const configEntry = tree.find((e) => e.path === SITE_CONFIG_PATH);
    violations.push(
      ...checkAgentSiteConfig(
        baseline.configText,
        configEntry && configEntry.mode === '100644' ? configEntry.content.toString('utf8') : null,
      ),
    );
    for (const entry of tree) {
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        violations.push({
          rule: 'file-mode',
          file: entry.path,
          line: null,
          reason: 'only regular files can be published',
        });
      }
    }
    if (violations.length > 0) {
      const unique = dedupe(violations);
      log.warn(
        jobFields(job, {
          violations: unique.length,
          rules: [...new Set(unique.map((v) => v.rule))],
        }),
        'scan blocked the changes',
      );
      await say(jobCtx, STEP_EVENTS.scanBlocked);
      await safeAlert(
        deps,
        'normal',
        `scan_blocked:${job.id}`,
        'Deployment blocked by the scan (possible abuse attempt)',
        {
          jobId: job.id,
          launchpad: lp.spec.slug,
          type: job.type,
          attempt: job.attempts,
          violations: unique.length,
          rules: [...new Set(unique.map((v) => v.rule))].join(', '),
          files: [...new Set(unique.map((v) => v.file))].slice(0, 5).join(', '),
        },
      );
      throw new PolicyViolationError(unique);
    }
    log.info(jobFields(job, { changed: changes.length }), 'scan passed');
    // What is committed is exactly what was scanned: the build below runs the agent's code, which
    // may rewrite the folder; nothing is read back from it afterwards.
    const scanned: RepoFile[] = tree.map((e) => ({
      path: e.path,
      content: Buffer.from(e.content),
      executable: e.mode === '100755',
    }));

    // 3. Local install (registries only, no lifecycle script) and build (no network at all).
    await say(jobCtx, STEP_EVENTS.buildSite);
    guard(signal);
    // Each sandbox run of the build checks the signal first (install, then build).
    const guardedRunner: SandboxRunner = {
      config: deps.runner.config,
      cleanupStale: () => deps.runner.cleanupStale(),
      run: (options) => {
        guard(signal);
        return deps.runner.run(options);
      },
    };
    const built = await deps.buildSite(guardedRunner, workdir, {
      jobId: job.id,
      signal,
      ...(deps.config.packagesToken ? { packagesToken: deps.config.packagesToken } : {}),
    });
    guard(signal);
    if (!built.ok) throw new SiteBuildError(built.failedStep, logTail(built.logs));
    return scanned;
  } finally {
    await removeWorkdir(workdir, deps.runner.config.jobsRoot).catch((err: unknown) =>
      log.warn(
        jobFields(job, { error: err instanceof Error ? err.name : 'unknown' }),
        'could not remove the job folder',
      ),
    );
  }
}

/** The `building` step. Returns the preview URL. */
export async function runBuildStep(
  deps: PipelineDeps,
  job: JobRow,
  jobCtx: JobContext,
  kind: BuildKind,
): Promise<JobOutcome> {
  const { signal } = jobCtx;
  const log = jobCtx.logger;
  const lp = await loadLaunchpad(deps, job);
  const { launchpad, spec, repoName } = lp;
  if (kind === 'modify' && launchpad.status !== 'live' && launchpad.status !== 'sleeping') {
    throw new PipelineError(
      `a modification needs a launchpad that went live (status ${launchpad.status})`,
    );
  }
  if (kind === 'create' && launchpad.status !== 'draft') {
    throw new PipelineError(`a creation job needs a draft launchpad (status ${launchpad.status})`);
  }
  const branch = jobBranch(job.id);

  // Repository.
  let repo: RepoInfo;
  if (kind === 'create') {
    await say(jobCtx, STEP_EVENTS.createRepo);
    guard(signal);
    const ensured = await deps.github.ensureRepoFromTemplate({
      slug: spec.slug,
      description: `FORGE launchpad ${spec.slug}`,
    });
    repo = ensured.repo;
  } else {
    await say(jobCtx, STEP_EVENTS.openRepo);
    const found = await deps.github.getRepo(repoName);
    if (!found) throw new PipelineError('the launchpad repository does not exist');
    repo = found;
  }
  if (repo.name !== repoName) throw new PipelineError('unexpected repository name');
  // Default branch protection (no force-push, no deletion), on every build and not only when the
  // repo was just created: a repo from an earlier attempt, or one whose protection failed or was
  // removed, gets it back. The call is an idempotent PUT.
  guard(signal);
  const protection = await deps.github.protectDefaultBranch(repo.name);
  if (!protection.applied) {
    log.warn(
      jobFields(job, { reason: protection.reason }),
      'default branch protection not applied',
    );
  }
  if (launchpad.github_repo !== repo.name) {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, { github_repo: repo.name });
  }

  // Vercel project before anything is pushed: git-triggered deployments are off and verified.
  guard(signal);
  const { project } = await deps.vercel.ensureProject({ slug: spec.slug });
  if (!project.gitDeploymentsDisabled) {
    throw new PipelineError('git-triggered deployments are not disabled on the Vercel project');
  }
  if (launchpad.vercel_project_id !== project.id) {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, { vercel_project_id: project.id });
  }

  // Job folder, agent, scan, local build.
  const snapshot = await deps.repoSource.snapshot(repo.name, repo.defaultBranch);
  const baseline = prepareBaseline(kind, snapshot, lp);
  const files = await codeAndCheck(deps, job, jobCtx, kind, lp, baseline);

  // Commit the scanned files. The branch must start from the commit the agent worked on.
  await say(jobCtx, STEP_EVENTS.publishPreview);
  const head = await deps.github.getBranchHead(repo.name, repo.defaultBranch);
  if (head !== snapshot.commitSha) {
    throw new PipelineError(
      'the default branch moved during the build; the build will start again',
    );
  }
  // A retried build: the job branch may still sit on the default branch head of an earlier
  // attempt. The release needs the branch to start from the commit this attempt worked on, so the
  // job branch (never the default branch) is put back on it before the commit.
  guard(signal);
  const realigned = await deps.github.resetJobBranch(repo.name, branch, snapshot.commitSha);
  if (realigned.reset) {
    log.info(
      jobFields(job, { base: snapshot.commitSha }),
      'job branch reset to the default branch',
    );
  }
  guard(signal);
  const commit = await deps.github.commitFiles({
    repo: repo.name,
    branch,
    baseBranch: repo.defaultBranch,
    message:
      kind === 'create'
        ? `Build the launchpad design (job ${job.id})`
        : `Apply a modification request (job ${job.id})`,
    files,
    // The branch mirrors this attempt exactly, whatever an earlier attempt left on it.
    deleteMissing: true,
  });
  log.info(
    jobFields(job, {
      commit: commit.commitSha,
      committed: commit.committed,
      changed: commit.changedPaths.length,
    }),
    'job branch updated',
  );

  // Preview deployment, created explicitly (git deployments are off).
  await syncProjectEnv(deps, signal, project.id, spec.slug, poolConfigKeys(baseline.onchain));
  guard(signal);
  const deployment = await deps.vercel.createDeployment({
    project: { id: project.id, name: project.name },
    repo: repo.name,
    ref: branch,
    sha: commit.commitSha,
    target: 'preview',
  });
  const ready = await deps.vercel.waitForDeployment(deployment.id, {
    timeoutMs: deps.config.deploymentTimeoutMs,
  });
  if (!/^https:\/\/\S+$/.test(ready.url)) throw new PipelineError('the preview has no https URL');
  return { patch: { preview_url: ready.url } };
}
