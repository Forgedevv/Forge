/// <reference types="node" />
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  JobOwnerTxDetails,
  OPS,
  failedStageForStatus,
  isActiveJobStatus,
  type ActiveJobStatus,
  type JobRow,
  type JobStatus,
} from '@forge/shared';
import type { Alerter } from './alerts.js';
import type { JobPatch, JobsDb } from './db.js';
import { EVENT_MESSAGES, failureEventMessage, sanitizeError } from './worker/messages.js';
import { AgentFailedError } from './pipeline/errors.js';

/*
 * Builder worker: picks up jobs, runs them through a JobHandler, records every transition.
 *
 * Job lifecycle owned here (docs/INTERFACES.md §4 and §5):
 *   paid | failed(build, attempts < 2)  --take_build_job-->          building
 *   approved(create) --take_post_approval_job-->                     onchain_setup
 *   approved(modify) | owner_signed --take_post_approval_job-->      deploying
 *   building -> preview_ready, onchain_setup -> awaiting_owner_signature, deploying -> live
 *   any active status -> failed (failed_stage from the status), lock reset every time.
 *
 * D18: a failure at the on-chain or deploy stage is never retried or released automatically:
 * alert + manual handling. The only automatic retry is the SQL pickup of `failed/build` jobs.
 */

export type { JobPatch, JobsDb } from './db.js';

/** Why a running job was aborted from the outside. */
export type AbortReason = 'shutdown' | 'timeout' | 'lock-lost';

export interface WorkerLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface JobContext {
  workerId: string;
  /** Aborted on shutdown (after the grace period), on timeout, or when the lock is lost. */
  signal: AbortSignal;
  logger: WorkerLogger;
  /** Appends a client-visible `job_events` line ("Creating your repo"). Never throws. */
  event(message: string): Promise<void>;
}

/** Result of a successful step. The worker derives the next status from the active one. */
export interface JobOutcome {
  /** Required for `building` (preview_url) and `onchain_setup` (owner_tx + owner_tx_details). */
  patch?: JobPatch;
  /** Overrides the default client-visible completion message. */
  message?: string;
}

/**
 * The pipeline. `job.status` is the active status that was just claimed:
 * - `building`: create or modify, produce a preview. Return `{ patch: { preview_url } }`.
 * - `onchain_setup`: signer configs + launch transaction. Return
 *   `{ patch: { owner_tx, owner_tx_details } }` (the transaction and its launch accounts, written
 *   in the same update).
 * - `deploying`: merge, production deploy. Return `{}`.
 * Throw to fail the step; the message is redacted and stored in `jobs.error`.
 * Must be idempotent (a job can be processed twice after a crash) and honour `ctx.signal`.
 *
 * Abort contract: once `ctx.signal` is aborted (timeout, lost lock, shutdown) the worker has
 * already recorded the job's outcome, or someone else owns the job. Anything the handler does
 * afterwards is unaccounted for. So a handler MUST check the signal (`ctx.signal.throwIfAborted()`)
 * right before every external side effect: GitHub push or merge, Vercel deployment or promotion,
 * signer call, R2 write, database write. It should also pass the signal to `fetch` and to child
 * processes. The worker keeps the concurrency slot of an aborted job until its handler settles (up
 * to `abandonedSettleMs`, then alerts), and never runs the same job again while that handler is
 * still pending.
 */
export interface JobHandler {
  handle(job: JobRow, ctx: JobContext): Promise<JobOutcome>;
}

export interface WorkerOptions {
  db: JobsDb;
  handler: JobHandler;
  logger: WorkerLogger;
  alerter?: Pick<Alerter, 'alert'>;
  workerId?: string;
  /** Jobs processed at the same time. Default 1. */
  concurrency?: number;
  /** Delay between polls when idle. Default 5 s. */
  pollIntervalMs?: number;
  /** +/- fraction of random spread on the poll delay. Default 0.2. */
  pollJitterRatio?: number;
  /** Lock refresh period. Default 60 s (must stay far below the stale delay). */
  heartbeatIntervalMs?: number;
  /** Default OPS.jobLockStaleMinutes. */
  staleMinutes?: number;
  /** Stale recovery runs at most this often. Default 60 s. */
  staleCheckIntervalMs?: number;
  /** `deploys_paused` is re-read at most this often (docs: at least every minute). Default 30 s. */
  flagCacheMs?: number;
  /** Hard cap on one job, whatever the handler does. Default 2 x the stale delay. */
  maxJobMs?: number;
  /** On stop(): time given to running jobs before they are aborted. Default 30 s. */
  shutdownGraceMs?: number;
  /** On stop(): time given to aborted jobs to settle. Default 10 s. */
  shutdownForceMs?: number;
  /**
   * After a timeout or a lost lock: how long the slot stays reserved for a handler that ignores
   * its abort signal. Past it the slot is freed and a high alert is sent; the job itself stays
   * blocked for this worker until the handler settles. Default 10 minutes.
   */
  abandonedSettleMs?: number;
  /** Backoff after DB errors: base and cap. Default 1 s / 60 s. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Build attempts before a failure is final (the SQL pickup uses 2). */
  maxBuildAttempts?: number;
  /** Retries of a terminal DB write (completion, failure) before giving up. Default 5. */
  persistAttempts?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Hard cap on one job when `WorkerOptions.maxJobMs` is not given: twice the stale delay. The
 * builder checks at startup that the sandbox step timeouts fit in it.
 */
export function defaultMaxJobMs(staleMinutes: number = OPS.jobLockStaleMinutes): number {
  return staleMinutes * 2 * 60_000;
}

const DEFAULT_WORKER_ENV = {
  concurrency: 1,
  pollIntervalMs: 5_000,
  pollJitterRatio: 0.2,
  heartbeatIntervalMs: 60_000,
  staleCheckIntervalMs: 60_000,
  flagCacheMs: 30_000,
  shutdownGraceMs: 30_000,
  shutdownForceMs: 10_000,
  abandonedSettleMs: 10 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxBuildAttempts: 2,
  persistAttempts: 5,
} as const;

/** Next status when a step succeeds. */
const NEXT_STATUS: Record<ActiveJobStatus, JobStatus> = {
  building: 'preview_ready',
  onchain_setup: 'awaiting_owner_signature',
  deploying: 'live',
};

/** Statuses a claim may legitimately return (defence in depth against a wrong SQL function). */
const EXPECTED_CLAIM: Record<'build' | 'post-approval', readonly ActiveJobStatus[]> = {
  build: ['building'],
  'post-approval': ['onchain_setup', 'deploying'],
};

class AbortedError extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super(`job aborted: ${reason}`);
    this.name = 'AbortedError';
    this.reason = reason;
  }
}

class InvalidOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutcomeError';
  }
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Worker {
  readonly workerId: string;
  private readonly o: Required<
    Omit<WorkerOptions, 'alerter' | 'workerId' | 'db' | 'handler' | 'logger'>
  >;
  private readonly db: JobsDb;
  private readonly handler: JobHandler;
  private readonly logger: WorkerLogger;
  private readonly alerter: Pick<Alerter, 'alert'> | undefined;

  private readonly running = new Map<string, Running>();
  /** Jobs whose aborted handler is still pending after its slot was given back. */
  private readonly unsettled = new Set<string>();
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private lastStaleCheck = Number.NEGATIVE_INFINITY;
  private flag: { value: boolean; at: number } | undefined;
  private pausedLogged = false;

  constructor(opts: WorkerOptions) {
    this.db = opts.db;
    this.handler = opts.handler;
    this.logger = opts.logger;
    this.alerter = opts.alerter;
    this.workerId =
      opts.workerId ?? `builder-${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    const staleMinutes = opts.staleMinutes ?? OPS.jobLockStaleMinutes;
    this.o = {
      concurrency: opts.concurrency ?? DEFAULT_WORKER_ENV.concurrency,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_WORKER_ENV.pollIntervalMs,
      pollJitterRatio: opts.pollJitterRatio ?? DEFAULT_WORKER_ENV.pollJitterRatio,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? DEFAULT_WORKER_ENV.heartbeatIntervalMs,
      staleMinutes,
      staleCheckIntervalMs: opts.staleCheckIntervalMs ?? DEFAULT_WORKER_ENV.staleCheckIntervalMs,
      flagCacheMs: opts.flagCacheMs ?? DEFAULT_WORKER_ENV.flagCacheMs,
      maxJobMs: opts.maxJobMs ?? defaultMaxJobMs(staleMinutes),
      shutdownGraceMs: opts.shutdownGraceMs ?? DEFAULT_WORKER_ENV.shutdownGraceMs,
      shutdownForceMs: opts.shutdownForceMs ?? DEFAULT_WORKER_ENV.shutdownForceMs,
      abandonedSettleMs: opts.abandonedSettleMs ?? DEFAULT_WORKER_ENV.abandonedSettleMs,
      backoffBaseMs: opts.backoffBaseMs ?? DEFAULT_WORKER_ENV.backoffBaseMs,
      backoffMaxMs: opts.backoffMaxMs ?? DEFAULT_WORKER_ENV.backoffMaxMs,
      maxBuildAttempts: opts.maxBuildAttempts ?? DEFAULT_WORKER_ENV.maxBuildAttempts,
      persistAttempts: opts.persistAttempts ?? DEFAULT_WORKER_ENV.persistAttempts,
      random: opts.random ?? Math.random,
      sleep: opts.sleep ?? defaultSleep,
      now: opts.now ?? Date.now,
    };
    if (!Number.isInteger(this.o.concurrency) || this.o.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    if (this.o.heartbeatIntervalMs * 3 > this.o.staleMinutes * 60_000) {
      throw new Error('heartbeat interval must be well below the stale lock delay');
    }
  }

  /** Number of slots in use (running jobs, and aborted jobs whose handler has not settled yet). */
  get activeJobs(): number {
    return this.running.size;
  }

  /** Aborted jobs whose handler is still pending past `abandonedSettleMs` (slot already freed). */
  get abandonedJobs(): number {
    return this.unsettled.size;
  }

  /** Starts the polling loop. Idempotent. */
  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.logger.info(
      {
        workerId: this.workerId,
        concurrency: this.o.concurrency,
        pollIntervalMs: this.o.pollIntervalMs,
      },
      'worker started',
    );
    this.loopPromise = this.loop();
  }

  /**
   * Graceful shutdown: stop polling, let running jobs finish for `shutdownGraceMs`, then abort
   * them. A `building` job still running is released to the queue (no attempt consumed); a job at
   * a money step (`onchain_setup`, `deploying`) is marked failed for manual handling (D18).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.loopPromise;
    this.loopPromise = undefined;
    if (this.running.size > 0) {
      this.logger.info({ running: this.running.size }, 'waiting for running jobs');
      await this.settleWithin(this.o.shutdownGraceMs);
    }
    if (this.running.size > 0) {
      this.logger.warn({ running: this.running.size }, 'grace period over, aborting running jobs');
      for (const r of this.running.values()) r.controller.abort('shutdown');
      await this.settleWithin(this.o.shutdownForceMs);
    }
    if (this.running.size > 0) {
      this.logger.error({ running: this.running.size }, 'jobs still running at exit');
    }
    this.logger.info({ workerId: this.workerId }, 'worker stopped');
  }

  /** Resolves when no job is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((r) => r.done));
    }
  }

  /**
   * One polling iteration: stale recovery (rate limited), kill switch check, then claims jobs
   * until the concurrency is reached or nothing is left. Returns the number of jobs started.
   * Throws on DB errors (the loop applies the backoff).
   */
  async tick(): Promise<number> {
    await this.recoverStaleJobs();
    if (this.stopping) return 0;
    if (await this.isPaused()) return 0;

    let claimed = 0;
    while (!this.stopping && this.running.size < this.o.concurrency) {
      let job: JobRow | null;
      let kind: 'build' | 'post-approval';
      try {
        // The client is waiting for the post-approval steps: they go first.
        job = await this.db.takePostApprovalJob(this.workerId);
        kind = 'post-approval';
        if (!job) {
          job = await this.db.takeBuildJob(this.workerId);
          kind = 'build';
        }
      } catch (err) {
        if (claimed === 0) throw err;
        this.logger.warn({ error: sanitizeError(err) }, 'claim failed after starting jobs');
        break;
      }
      if (!job) break;
      if (this.running.has(job.id) || this.unsettled.has(job.id)) {
        // A previous run of this job is still executing here (aborted, handler not settled).
        await this.handBack(job);
        break;
      }
      if (!this.launch(job, kind)) break;
      claimed += 1;
    }
    return claimed;
  }

  // ---------------------------------------------------------------- loop

  private async loop(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopping) {
      let delay: number;
      try {
        const claimed = await this.tick();
        consecutiveErrors = 0;
        delay = claimed > 0 ? 0 : this.pollDelay();
      } catch (err) {
        consecutiveErrors += 1;
        delay = this.backoffDelay(consecutiveErrors);
        this.logger.error(
          { error: sanitizeError(err), consecutiveErrors, retryInMs: delay },
          'database error, backing off',
        );
        if (consecutiveErrors === 5) {
          void this.safeAlert(
            'high',
            'builder_db_errors',
            'Builder worker cannot reach the database',
            {
              consecutiveErrors,
            },
          );
        }
      }
      if (delay > 0) await this.interruptibleSleep(delay);
      else await Promise.resolve();
    }
  }

  private pollDelay(): number {
    const spread = this.o.pollIntervalMs * this.o.pollJitterRatio;
    return Math.max(1, Math.round(this.o.pollIntervalMs + (this.o.random() * 2 - 1) * spread));
  }

  private backoffDelay(errors: number): number {
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (errors - 1));
    // Equal jitter: between half and the full delay.
    return Math.round(exp / 2 + (this.o.random() * exp) / 2);
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.wakeUp = wake;
    try {
      await Promise.race([this.o.sleep(ms), woken]);
    } finally {
      if (this.wakeUp === wake) this.wakeUp = undefined;
    }
  }

  private wake(): void {
    this.wakeUp?.();
  }

  private async settleWithin(ms: number): Promise<void> {
    if (this.running.size === 0) return;
    await Promise.race([this.idle(), this.o.sleep(ms)]);
  }

  // ---------------------------------------------------------------- kill switch and stale jobs

  private async isPaused(): Promise<boolean> {
    const t = this.o.now();
    if (!this.flag || t - this.flag.at >= this.o.flagCacheMs) {
      // A read error propagates: without knowing the switch, nothing is picked up.
      this.flag = { value: await this.db.getFlag('deploys_paused'), at: t };
    }
    if (this.flag.value && !this.pausedLogged) {
      this.logger.warn({}, 'deploys_paused is set: not picking up jobs');
    } else if (!this.flag.value && this.pausedLogged) {
      this.logger.info({}, 'deploys_paused cleared: resuming');
    }
    this.pausedLogged = this.flag.value;
    return this.flag.value;
  }

  private async recoverStaleJobs(): Promise<void> {
    const t = this.o.now();
    if (t - this.lastStaleCheck < this.o.staleCheckIntervalMs) return;
    this.lastStaleCheck = t;
    let stale: JobRow[];
    try {
      stale = await this.db.failStaleJobs(this.o.staleMinutes);
    } catch (err) {
      // Retry at the next tick; the claim below hits the same DB and drives the backoff.
      this.lastStaleCheck = Number.NEGATIVE_INFINITY;
      throw err;
    }
    for (const job of stale) {
      const stage = job.failed_stage ?? 'deploy';
      this.logger.warn(
        { jobId: job.id, stage, attempts: job.attempts, lockedBy: job.locked_by },
        'stale job recovered as failed',
      );
      await this.event(
        job.id,
        stage === 'build' ? EVENT_MESSAGES.staleBuild : EVENT_MESSAGES.staleManual,
      );
      await this.safeAlert(
        stage === 'build' ? 'normal' : 'high',
        `job_stale:${job.id}`,
        stage === 'build'
          ? 'Build job found stale and marked failed'
          : 'Job found stale after approval, manual handling required',
        { jobId: job.id, stage, attempts: job.attempts },
      );
    }
  }

  // ---------------------------------------------------------------- one job

  private launch(job: JobRow, kind: 'build' | 'post-approval'): boolean {
    if (!isActiveJobStatus(job.status) || !EXPECTED_CLAIM[kind].includes(job.status)) {
      // The SQL function returned a status we do not expect: do not touch the job.
      this.logger.error(
        { jobId: job.id, status: job.status, kind },
        'claimed job has an unexpected status, skipping',
      );
      void this.safeAlert(
        'high',
        `job_bad_claim:${job.id}`,
        'Claimed job has an unexpected status',
        {
          jobId: job.id,
          status: job.status,
        },
      );
      return false;
    }
    const controller = new AbortController();
    const done = this.run(job, job.status, controller)
      .catch((err: unknown) => {
        // The state could not be recorded (database down). The lock stays and ages: stale
        // recovery will mark the job failed, which is the safe outcome (D18 for money steps).
        this.logger.error(
          { jobId: job.id, status: job.status, error: sanitizeError(err) },
          'could not record the job state, leaving it to stale recovery',
        );
        void this.safeAlert(
          'high',
          `job_state_unrecorded:${job.id}`,
          'Job state could not be recorded',
          {
            jobId: job.id,
            status: job.status,
          },
        );
      })
      .finally(() => {
        this.running.delete(job.id);
        this.wake();
      });
    this.running.set(job.id, { controller, done });
    return true;
  }

  private async run(
    job: JobRow,
    active: ActiveJobStatus,
    controller: AbortController,
  ): Promise<void> {
    const log = this.logger;
    const base = { jobId: job.id, type: job.type, status: active, attempts: job.attempts };
    log.info(base, 'job claimed');
    await this.event(
      job.id,
      active === 'building' && job.attempts > 1
        ? EVENT_MESSAGES.restarted(job.attempts, this.o.maxBuildAttempts)
        : EVENT_MESSAGES.started[active],
    );

    const heartbeat = setInterval(() => {
      this.db.heartbeat(job.id, this.workerId).then(
        (ok) => {
          if (!ok && !controller.signal.aborted) {
            log.error(base, 'lock lost: the job was taken over or recovered');
            controller.abort('lock-lost');
          }
        },
        (err: unknown) => log.warn({ ...base, error: sanitizeError(err) }, 'heartbeat failed'),
      );
    }, this.o.heartbeatIntervalMs);
    const timeout = setTimeout(() => controller.abort('timeout'), this.o.maxJobMs);

    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new AbortedError(abortReason(controller.signal)));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);

    const ctx: JobContext = {
      workerId: this.workerId,
      signal: controller.signal,
      logger: log,
      event: (message) => this.event(job.id, message),
    };
    const handling = Promise.resolve().then(() => this.handler.handle(job, ctx));
    // Settles (never rejects) when the handler does, whatever won the race below.
    let handlerSettled = false;
    const settled = handling.then(
      () => {
        handlerSettled = true;
      },
      () => {
        handlerSettled = true;
      },
    );

    try {
      let patch: JobPatch;
      let outcome: JobOutcome;
      try {
        outcome = await Promise.race([handling, aborted]);
        patch = validateOutcome(active, outcome);
      } catch (err) {
        await this.handleFailure(job, active, err, controller.signal);
        return;
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
      }
      await this.complete(job, active, patch, outcome.message);
    } finally {
      // The outcome is recorded; an aborted handler may still be running. Keep the slot.
      if (controller.signal.aborted && !handlerSettled) {
        await this.awaitAbandoned(job, active, settled, abortReason(controller.signal));
      }
    }
  }

  /**
   * Holds the concurrency slot until an aborted handler settles, at most `abandonedSettleMs`.
   * Past that the slot is freed with a high alert, and the job stays blocked for this worker
   * (`unsettled`) until the handler finally settles.
   */
  private async awaitAbandoned(
    job: JobRow,
    active: ActiveJobStatus,
    settled: Promise<void>,
    reason: AbortReason,
  ): Promise<void> {
    const base = { jobId: job.id, status: active, reason };
    this.logger.warn(base, 'job aborted, waiting for its handler to stop');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<'cap'>((resolve) => {
      timer = setTimeout(() => resolve('cap'), this.o.abandonedSettleMs);
      // Must not keep a stopping process alive on its own.
      timer.unref?.();
    });
    const first = await Promise.race([settled.then(() => 'settled' as const), capped]);
    clearTimeout(timer);
    if (first === 'settled') {
      this.logger.info(base, 'aborted handler settled');
      return;
    }
    this.unsettled.add(job.id);
    this.logger.error(
      { ...base, waitedMs: this.o.abandonedSettleMs },
      'aborted handler still running, freeing its slot',
    );
    void this.safeAlert(
      'high',
      `job_handler_unsettled:${job.id}`,
      'A job handler ignored its abort signal and is still running: possible side effects after the job was closed',
      { jobId: job.id, status: active, reason, waitedMs: this.o.abandonedSettleMs },
    );
    void settled.then(() => {
      this.unsettled.delete(job.id);
      this.logger.warn(base, 'abandoned handler finally settled');
      this.wake();
    });
  }

  /**
   * A claim returned a job whose previous run is still executing in this worker: give it back
   * without running it. A build goes back to the queue (attempt not consumed); a post-approval
   * step is failed for manual handling (D18). Never throws: on a DB error the lock ages and stale
   * recovery decides.
   */
  private async handBack(job: JobRow): Promise<void> {
    const base = { jobId: job.id, status: job.status };
    this.logger.warn(
      base,
      'claimed a job whose previous run is still executing here, handing back',
    );
    try {
      if (job.status === 'building') {
        const row = await this.persist(() =>
          this.db.releaseBuild(job.id, this.workerId, job.attempts),
        );
        if (!row) this.logger.warn(base, 'lock lost before the build could be handed back');
        return;
      }
      if (isActiveJobStatus(job.status)) {
        await this.fail(
          job,
          job.status,
          'a previous run of this step was still executing: manual handling required',
        );
      }
    } catch (err) {
      this.logger.error({ ...base, error: sanitizeError(err) }, 'could not hand the job back');
      void this.safeAlert(
        'high',
        `job_state_unrecorded:${job.id}`,
        'Job state could not be recorded',
        base,
      );
    }
  }

  private async complete(
    job: JobRow,
    active: ActiveJobStatus,
    patch: JobPatch,
    message: string | undefined,
  ): Promise<void> {
    const next = NEXT_STATUS[active];
    const row = await this.persist(() =>
      this.db.completeStep(job.id, this.workerId, active, next, patch),
    );
    if (!row) {
      this.logger.error(
        { jobId: job.id, status: active },
        'lock lost before completion, result dropped',
      );
      void this.safeAlert(
        'high',
        `job_lock_lost:${job.id}`,
        'Job finished after its lock was lost',
        {
          jobId: job.id,
          status: active,
        },
      );
      return;
    }
    this.logger.info({ jobId: job.id, from: active, to: next }, 'job step completed');
    await this.event(job.id, message ?? EVENT_MESSAGES.completed[active]);
  }

  private async handleFailure(
    job: JobRow,
    active: ActiveJobStatus,
    err: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const reason = err instanceof AbortedError ? err.reason : undefined;
    if (reason === 'lock-lost') {
      // Someone else (stale recovery) already decided the state of this job.
      this.logger.warn({ jobId: job.id }, 'job abandoned: lock lost');
      return;
    }
    if (reason === 'shutdown' || (signal.aborted && signal.reason === 'shutdown')) {
      await this.interrupt(job, active);
      return;
    }
    const message =
      reason === 'timeout'
        ? `job exceeded the maximum duration of ${Math.round(this.o.maxJobMs / 60_000)} minutes`
        : sanitizeError(err);
    if (err instanceof AgentFailedError && err.detail) {
      this.logger.warn({ jobId: job.id, detail: err.detail }, 'agent failure detail');
    }
    await this.fail(job, active, message);
  }

  private async fail(job: JobRow, active: ActiveJobStatus, message: string): Promise<void> {
    const stage = failedStageForStatus(active);
    const row = await this.persist(() =>
      this.db.failJob(job.id, this.workerId, active, stage, message),
    );
    if (!row) {
      this.logger.warn({ jobId: job.id, stage }, 'lock lost before failure was recorded');
      return;
    }
    const final = stage === 'build' && job.attempts >= this.o.maxBuildAttempts;
    this.logger.error(
      { jobId: job.id, stage, attempts: job.attempts, final, error: message },
      'job failed',
    );
    await this.event(job.id, failureEventMessage(stage, job.attempts, this.o.maxBuildAttempts));
    if (stage !== 'build') {
      await this.safeAlert(
        'high',
        `job_failed_${stage}:${job.id}`,
        `Job failed at the ${stage} stage after approval: manual handling required (no automatic retry)`,
        { jobId: job.id, stage, error: message },
      );
    } else if (final) {
      await this.safeAlert(
        'normal',
        `job_failed_build:${job.id}`,
        'Job failed after all build attempts: refund expected',
        { jobId: job.id, attempts: job.attempts, error: message },
      );
    }
  }

  /** Shutdown while the job was running. */
  private async interrupt(job: JobRow, active: ActiveJobStatus): Promise<void> {
    if (active === 'building') {
      const row = await this.persist(() =>
        this.db.releaseBuild(job.id, this.workerId, job.attempts),
      );
      if (row) {
        this.logger.info({ jobId: job.id }, 'build released to the queue on shutdown');
        await this.event(job.id, EVENT_MESSAGES.interruptedBuild);
      } else {
        this.logger.warn({ jobId: job.id }, 'lock lost before the build could be released');
      }
      return;
    }
    // Money steps are never restarted automatically (D18): the team decides.
    await this.fail(job, active, 'worker shut down while the step was running');
  }

  // ---------------------------------------------------------------- helpers

  /** Never throws: events are informative, they must not break a job. */
  private async event(jobId: string, message: string): Promise<void> {
    try {
      await this.db.appendEvent(jobId, message);
    } catch (err) {
      this.logger.warn({ jobId, error: sanitizeError(err) }, 'could not append job event');
    }
  }

  /** Retries a terminal DB write: losing the result of a finished step is expensive. */
  private async persist<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.o.persistAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        this.logger.warn({ attempt, error: sanitizeError(err) }, 'job state write failed');
        if (attempt < this.o.persistAttempts) await this.o.sleep(this.backoffDelay(attempt));
      }
    }
    throw lastError;
  }

  private async safeAlert(
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.alerter) return;
    try {
      await this.alerter.alert(level, code, message, details);
    } catch {
      /* alerting must never break the worker */
    }
  }
}

function abortReason(signal: AbortSignal): AbortReason {
  const r: unknown = signal.reason;
  return r === 'shutdown' || r === 'timeout' || r === 'lock-lost' ? r : 'shutdown';
}

/** Checks the handler result and returns the only fields allowed to reach the database. */
function validateOutcome(active: ActiveJobStatus, outcome: JobOutcome): JobPatch {
  const raw = (outcome as JobOutcome | undefined)?.patch ?? {};
  const patch: JobPatch = {};
  if (active === 'building') {
    if (typeof raw.preview_url !== 'string' || !/^https:\/\/\S+$/.test(raw.preview_url)) {
      throw new InvalidOutcomeError('build step finished without a valid https preview_url');
    }
    patch.preview_url = raw.preview_url;
  } else if (active === 'onchain_setup') {
    if (typeof raw.owner_tx !== 'string' || raw.owner_tx.length === 0) {
      throw new InvalidOutcomeError('on-chain step finished without owner_tx');
    }
    // The launch accounts apps/web pins are stored with the transaction, never without them.
    const details = JobOwnerTxDetails.safeParse(raw.owner_tx_details);
    if (!details.success) {
      throw new InvalidOutcomeError('on-chain step finished without valid owner_tx_details');
    }
    patch.owner_tx = raw.owner_tx;
    patch.owner_tx_details = details.data;
  }
  return patch;
}
