import type { JobRow } from '@forge/shared';
import type { RepoFile } from '../../github.js';
import { builderSystemPrompt } from '../../prompts/index.js';
import { reviewTaskPrompt } from '../../prompts/review.js';
import { BUILD_DEFAULTS, type SandboxRunner } from '../../sandbox/index.js';
import type { JobContext } from '../../worker.js';
import { runAgent } from '../agent.js';
import {
  guard,
  jobFields,
  safeAlert,
  say,
  StepAbortedError,
  type LaunchpadContext,
  type PipelineDeps,
} from '../context.js';
import { AgentFailedError } from '../errors.js';
import { gateTree, type GateBaseline } from '../gate.js';
import { STEP_EVENTS } from '../messages.js';
import {
  createWorkdir,
  readWorkdirTree,
  removeWorkdir,
  writeWorkdirFiles,
  type WorkdirFile,
} from '../workdir.js';
import { CaptureOutputError, readCaptureOutput, type CaptureResult } from './capture-output.js';
import type { VisualReviewConfig } from './config.js';
import { CAPTURE_IN_CONTAINER, REPORT_FILE, REVIEW_DIR } from './contract.js';
import {
  isReviewPath,
  removeReviewInput,
  reviewInputFiles,
  reviewPath,
  reviewShotSummaries,
} from './review-input.js';

/**
 * Visual review of a new site (BUILDER_VISUAL_REVIEW=on), after the first agent pass has been
 * scanned and built:
 *
 *   capture   a separate sandbox run of the review image: no network (loopback only), no secret,
 *             the pass 1 workdir read-only, output only into a fresh folder. It starts the built
 *             site (`next start`) and a headless browser, and writes screenshots + a layout report.
 *   validate  on the host, everything from the container is untrusted (capture-output.ts).
 *   pass 2    a fresh workdir with exactly the pass 1 files plus `.forge-review/`, the agent again
 *             (same sandbox, gateway and token rules; what is left of the job budget, capped).
 *   gate      `.forge-review/` removed, then the same scan against the same baseline as pass 1,
 *             then install + build again.
 *
 * Any failure of the review (capture, agent, scan, build, time, budget) is logged and the pass 1
 * files, already scanned and built, are kept: the job never fails because of the review. Only an
 * abort of the job itself propagates. The two passes' files are never mixed.
 */

export type ReviewDiscardReason =
  | 'time'
  | 'budget'
  | 'capture_failed'
  | 'capture_invalid'
  | 'no_screenshot'
  | 'agent_failed'
  | 'scan_blocked'
  | 'build_failed'
  | 'timeout'
  | 'error';

export type ReviewOutcome =
  { applied: true; files: RepoFile[] } | { applied: false; reason: ReviewDiscardReason };

export interface VisualReviewInput {
  deps: PipelineDeps;
  review: VisualReviewConfig;
  job: JobRow;
  jobCtx: JobContext;
  lp: LaunchpadContext;
  baseline: GateBaseline;
  /** The pass 1 folder, built (its node_modules and .next are what the capture serves). */
  pass1Workdir: string;
  /** The pass 1 files, scanned and built: the fallback. */
  pass1Files: readonly RepoFile[];
  /** Cost reported by the pass 1 CLI (used only when the gateway cannot tell the job cost). */
  pass1ReportedCostUsd: number | undefined;
  /** Epoch ms by which the review must be over (commit and preview still have to fit). */
  deadline: number;
}

/** argv of the capture run, inside the review image. */
export function captureCommand(deadlineMs: number): string[] {
  return [
    'node',
    CAPTURE_IN_CONTAINER.script,
    '--site',
    '/workspace',
    '--out',
    '/output',
    '--port',
    String(CAPTURE_IN_CONTAINER.port),
    '--browser',
    CAPTURE_IN_CONTAINER.browser,
    '--no-browser-sandbox',
    '--deadline-ms',
    String(deadlineMs),
  ];
}

class ReviewDiscarded extends Error {
  constructor(
    readonly reason: ReviewDiscardReason,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`review discarded (${reason})`);
    this.name = 'ReviewDiscarded';
  }
}

function toWorkdirFiles(files: readonly RepoFile[]): WorkdirFile[] {
  return files.map((f) => ({
    path: f.path,
    content: Buffer.from(f.content),
    executable: f.executable === true,
  }));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

export async function runVisualReview(input: VisualReviewInput): Promise<ReviewOutcome> {
  const { deps, review, job, jobCtx, lp } = input;
  const log = jobCtx.logger;
  const now = deps.now ?? Date.now;
  const owner = {
    ...(deps.config.sandboxUid !== undefined ? { uid: deps.config.sandboxUid } : {}),
    ...(deps.config.sandboxGid !== undefined ? { gid: deps.config.sandboxGid } : {}),
  };
  const discard = (reason: ReviewDiscardReason, detail: Record<string, unknown> = {}) => {
    log.warn(jobFields(job, { reason, ...detail }), 'visual review discarded, first pass kept');
    return { applied: false as const, reason };
  };

  const timeLeft = input.deadline - now();
  if (timeLeft < review.minTimeLeftMs) return discard('time', { timeLeftMs: timeLeft });

  // The review's own signal: the job's, plus the review deadline (which only drops the review).
  const controller = new AbortController();
  const onJobAbort = () => controller.abort(jobCtx.signal.reason);
  if (jobCtx.signal.aborted) onJobAbort();
  else jobCtx.signal.addEventListener('abort', onJobAbort, { once: true });
  const timer = setTimeout(() => controller.abort('review deadline'), timeLeft);
  const signal = controller.signal;
  /** Past the deadline nothing new starts (the timer above also kills what is running). */
  const checkDeadline = () => {
    if (now() >= input.deadline) throw new ReviewDiscarded('timeout');
  };
  const runner: SandboxRunner = {
    config: deps.runner.config,
    cleanupStale: () => deps.runner.cleanupStale(),
    run: (options) => {
      guard(signal);
      checkDeadline();
      return deps.runner.run({ ...options, signal });
    },
  };
  const folders: string[] = [];
  const newFolder = async (): Promise<string> => {
    const dir = await createWorkdir({
      jobsRoot: deps.runner.config.jobsRoot,
      jobId: job.id,
      attempt: job.attempts,
      ...owner,
    });
    folders.push(dir);
    return dir;
  };
  const remove = async (dir: string): Promise<void> => {
    await removeWorkdir(dir, deps.runner.config.jobsRoot).catch((err: unknown) =>
      log.warn(jobFields(job, { error: errorName(err) }), 'could not remove a review folder'),
    );
  };

  try {
    // 1. Capture, in the review image: no network, no secret, the built site read-only.
    await say(jobCtx, STEP_EVENTS.reviewDesign);
    const outDir = await newFolder();
    const captureTimeoutMs = Math.min(review.captureTimeoutMs, input.deadline - now());
    const capture = await runner.run({
      jobId: job.id,
      workdir: input.pass1Workdir,
      image: 'review',
      workspaceReadOnly: true,
      outputDir: outDir,
      command: captureCommand(Math.max(10_000, captureTimeoutMs - 20_000)),
      env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
      network: 'none',
      timeoutMs: captureTimeoutMs,
      memoryMb: review.captureMemoryMb,
      cpus: review.captureCpus,
      pidsLimit: 1024,
      tmpSizeMb: 1024,
    });
    if (!capture.ok) {
      throw new ReviewDiscarded('capture_failed', {
        exitCode: capture.exitCode,
        killedReason: capture.killedReason,
        oomKilled: capture.oomKilled,
      });
    }
    let result: CaptureResult;
    try {
      result = await readCaptureOutput(outDir);
    } catch (err) {
      if (err instanceof CaptureOutputError) {
        throw new ReviewDiscarded('capture_invalid', { problem: err.message });
      }
      throw err;
    }
    const usable = result.shots.filter((s) => s.ok && s.images.length > 0);
    if (usable.length === 0) throw new ReviewDiscarded('no_screenshot');
    log.info(
      jobFields(job, {
        screenshots: usable.length,
        failed: result.shots.length - usable.length,
        imageBytes: result.imageBytes,
        ignoredEntries: result.ignoredEntries,
        overflowing: result.shots.filter((s) => s.layout?.horizontalOverflow).length,
      }),
      'visual review captured',
    );
    // The images are in memory now: the capture output and the pass 1 folder are not needed.
    await remove(outDir);
    await remove(input.pass1Workdir);

    // 2. Budget: what is left of the job budget (the gateway's accounting), capped.
    const agentConfig = deps.config.agent;
    const spent = deps.gateway.jobCostUsd
      ? await deps.gateway.jobCostUsd(job.id)
      : (input.pass1ReportedCostUsd ?? 0);
    const leftUsd = agentConfig.budgetUsd - spent;
    if (!Number.isFinite(leftUsd) || leftUsd < review.minBudgetUsd) {
      throw new ReviewDiscarded('budget', { spentUsd: spent });
    }
    // A gateway token's budget caps the job's total cost.
    const budgetUsd = Math.min(agentConfig.budgetUsd, spent + review.maxBudgetUsd);

    // 3. Pass 2, in a fresh folder: exactly the pass 1 files, plus the review input.
    const workdir = await newFolder();
    await writeWorkdirFiles(
      workdir,
      [...toWorkdirFiles(input.pass1Files), ...reviewInputFiles(result)],
      owner,
    );
    const agentTimeoutMs = Math.min(
      review.agentTimeoutMs,
      input.deadline - now() - review.buildReserveMs,
    );
    if (agentTimeoutMs < review.minAgentMs || agentTimeoutMs < 1_000) {
      throw new ReviewDiscarded('time', { agentTimeoutMs });
    }
    await say(jobCtx, STEP_EVENTS.refineDesign);
    const agent = await runAgent(
      {
        runner,
        gateway: deps.gateway,
        config: {
          ...agentConfig,
          timeoutMs: agentTimeoutMs,
          budgetUsd,
          maxTurns: Math.min(agentConfig.maxTurns, review.maxTurns),
        },
      },
      {
        jobId: job.id,
        workdir,
        systemPrompt: deps.systemPrompt ?? builderSystemPrompt(),
        taskPrompt: reviewTaskPrompt(
          {
            reviewDir: REVIEW_DIR,
            reportPath: reviewPath(REPORT_FILE),
            shots: reviewShotSummaries(result),
          },
          lp.spec,
        ),
        signal,
      },
    );
    log.info(
      jobFields(job, {
        pass: 2,
        turns: agent.turns,
        durationMs: agent.durationMs,
        reportedCostUsd: agent.reportedCostUsd,
        budgetUsd,
      }),
      'review agent finished',
    );

    checkDeadline();

    // 4. The review input goes before anything is read back; then the pass 1 gate, same baseline.
    await removeReviewInput(workdir);
    const tree = await readWorkdirTree(workdir);
    if (tree.some((e) => isReviewPath(e.path))) throw new ReviewDiscarded('error');
    const gate = gateTree(tree, input.baseline, deps.scan, deps.config.scanOptions);
    if (gate.violations.length > 0) {
      const rules = [...new Set(gate.violations.map((v) => v.rule))];
      await safeAlert(
        deps,
        'normal',
        `review_scan_blocked:${job.id}`,
        'Visual review changes blocked by the scan (first version kept)',
        {
          jobId: job.id,
          launchpad: lp.spec.slug,
          attempt: job.attempts,
          violations: gate.violations.length,
          rules: rules.join(', '),
          files: [...new Set(gate.violations.map((v) => v.file))].slice(0, 5).join(', '),
        },
      );
      throw new ReviewDiscarded('scan_blocked', { violations: gate.violations.length, rules });
    }
    // What is committed is exactly what was scanned (the build below runs the agent's code).
    const files: RepoFile[] = tree.map((e) => ({
      path: e.path,
      content: Buffer.from(e.content),
      executable: e.mode === '100755',
    }));

    // 5. Install + build the reviewed site, within what is left of the review time.
    await say(jobCtx, STEP_EVENTS.buildRefined);
    const buildLeft = input.deadline - now();
    if (buildLeft < 1_000) throw new ReviewDiscarded('time', { buildLeftMs: buildLeft });
    const built = await deps.buildSite(runner, workdir, {
      jobId: job.id,
      signal,
      install: { timeoutMs: Math.min(BUILD_DEFAULTS.install.timeoutMs, buildLeft) },
      build: { timeoutMs: Math.min(BUILD_DEFAULTS.build.timeoutMs, buildLeft) },
    });
    if (!built.ok) throw new ReviewDiscarded('build_failed', { step: built.failedStep });
    guard(signal);
    checkDeadline();
    log.info(
      jobFields(job, { changed: gate.changes.length, files: files.length }),
      'visual review applied',
    );
    return { applied: true, files };
  } catch (err) {
    // An abort of the job itself is not the review's to swallow.
    if (jobCtx.signal.aborted) {
      throw err instanceof StepAbortedError ? err : new StepAbortedError(jobCtx.signal.reason);
    }
    if (err instanceof ReviewDiscarded) {
      return discard(signal.aborted ? 'timeout' : err.reason, err.detail);
    }
    if (signal.aborted) return discard('timeout');
    if (err instanceof AgentFailedError) return discard('agent_failed', { problem: err.message });
    return discard('error', { error: errorName(err) });
  } finally {
    clearTimeout(timer);
    jobCtx.signal.removeEventListener('abort', onJobAbort);
    for (const dir of folders) await remove(dir);
  }
}
