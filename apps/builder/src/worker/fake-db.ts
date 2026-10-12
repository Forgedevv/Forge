import type { ActiveJobStatus, FailedStage, FlagKey, JobRow, JobStatus } from '@forge/shared';
import type { JobPatch, JobsDb } from '../db.js';

/**
 * In-memory JobsDb with the same semantics as the SQL functions of
 * supabase/migrations/0004_job_functions.sql and the conditional updates of src/db.ts.
 * Test helper only. Every operation yields to the event loop first, then applies its change
 * synchronously, like a single atomic statement.
 */
export class FakeJobsDb implements JobsDb {
  readonly jobs = new Map<string, JobRow>();
  readonly events: { job_id: string; message: string }[] = [];
  readonly flags = new Map<FlagKey, boolean>();
  /** Test clock in ms. Drives locked_at and the stale cut-off. */
  clock = Date.UTC(2026, 0, 1, 12, 0, 0);
  readonly calls: string[] = [];
  /** Operation name -> number of upcoming calls that must throw. */
  private readonly faults = new Map<string, { remaining: number; error: Error }>();

  failNext(op: keyof JobsDb, times = 1, message = 'connection reset'): void {
    this.faults.set(op, { remaining: times, error: new Error(message) });
  }

  addJob(partial: Partial<JobRow> & { id: string }): JobRow {
    const job: JobRow = {
      launchpad_id: 'lp-1',
      type: 'create_launchpad',
      status: 'paid',
      attempts: 0,
      failed_stage: null,
      request: null,
      preview_url: null,
      owner_tx: null,
      owner_tx_details: null,
      error: null,
      api_cost_usd: 0,
      locked_by: null,
      locked_at: null,
      created_at: new Date(this.clock + this.jobs.size).toISOString(),
      updated_at: new Date(this.clock).toISOString(),
      ...partial,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): JobRow {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }

  eventsFor(id: string): string[] {
    return this.events.filter((e) => e.job_id === id).map((e) => e.message);
  }

  private async enter(op: string): Promise<void> {
    this.calls.push(op);
    await Promise.resolve();
    const fault = this.faults.get(op);
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      throw fault.error;
    }
  }

  private iso(): string {
    return new Date(this.clock).toISOString();
  }

  private sorted(): JobRow[] {
    return [...this.jobs.values()].sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
  }

  private touch(job: JobRow): JobRow {
    job.updated_at = this.iso();
    return { ...job };
  }

  async takeBuildJob(worker: string): Promise<JobRow | null> {
    await this.enter('takeBuildJob');
    const job = this.sorted().find(
      (j) =>
        (j.status === 'paid' ||
          (j.status === 'failed' && j.failed_stage === 'build' && j.attempts < 2)) &&
        j.locked_at === null,
    );
    if (!job) return null;
    job.status = 'building';
    job.locked_by = worker;
    job.locked_at = this.iso();
    job.attempts += 1;
    job.failed_stage = null;
    job.error = null;
    return this.touch(job);
  }

  async takePostApprovalJob(worker: string): Promise<JobRow | null> {
    await this.enter('takePostApprovalJob');
    const job = this.sorted().find(
      (j) => (j.status === 'approved' || j.status === 'owner_signed') && j.locked_at === null,
    );
    if (!job) return null;
    job.status =
      job.status === 'approved' && job.type === 'create_launchpad' ? 'onchain_setup' : 'deploying';
    job.locked_by = worker;
    job.locked_at = this.iso();
    return this.touch(job);
  }

  async failStaleJobs(staleMinutes: number): Promise<JobRow[]> {
    await this.enter('failStaleJobs');
    const cutoff = this.clock - staleMinutes * 60_000;
    const out: JobRow[] = [];
    for (const job of this.sorted()) {
      if (
        (job.status === 'building' ||
          job.status === 'onchain_setup' ||
          job.status === 'deploying') &&
        job.locked_at !== null &&
        Date.parse(job.locked_at) < cutoff
      ) {
        job.failed_stage =
          job.status === 'building'
            ? 'build'
            : job.status === 'onchain_setup'
              ? 'onchain'
              : 'deploy';
        job.status = 'failed';
        job.error = `stale lock: worker ${job.locked_by ?? 'unknown'} stopped responding`;
        job.locked_by = null;
        job.locked_at = null;
        out.push(this.touch(job));
      }
    }
    return out;
  }

  private owned(jobId: string, worker: string, from: ActiveJobStatus): JobRow | null {
    const job = this.jobs.get(jobId);
    return job && job.locked_by === worker && job.status === from ? job : null;
  }

  async heartbeat(jobId: string, worker: string): Promise<boolean> {
    await this.enter('heartbeat');
    const job = this.jobs.get(jobId);
    if (!job || job.locked_by !== worker) return false;
    if (job.status !== 'building' && job.status !== 'onchain_setup' && job.status !== 'deploying') {
      return false;
    }
    job.locked_at = this.iso();
    this.touch(job);
    return true;
  }

  async completeStep(
    jobId: string,
    worker: string,
    from: ActiveJobStatus,
    to: JobStatus,
    patch: JobPatch,
  ): Promise<JobRow | null> {
    await this.enter('completeStep');
    const job = this.owned(jobId, worker, from);
    if (!job) return null;
    Object.assign(job, patch);
    job.status = to;
    job.locked_by = null;
    job.locked_at = null;
    return this.touch(job);
  }

  async failJob(
    jobId: string,
    worker: string,
    from: ActiveJobStatus,
    stage: FailedStage,
    error: string,
  ): Promise<JobRow | null> {
    await this.enter('failJob');
    const job = this.owned(jobId, worker, from);
    if (!job) return null;
    job.status = 'failed';
    job.failed_stage = stage;
    job.error = error;
    job.locked_by = null;
    job.locked_at = null;
    return this.touch(job);
  }

  async releaseBuild(
    jobId: string,
    worker: string,
    attemptsBefore: number,
  ): Promise<JobRow | null> {
    await this.enter('releaseBuild');
    const job = this.owned(jobId, worker, 'building');
    if (!job) return null;
    job.status = 'paid';
    job.attempts = Math.max(0, attemptsBefore - 1);
    job.locked_by = null;
    job.locked_at = null;
    return this.touch(job);
  }

  async appendEvent(jobId: string, message: string): Promise<void> {
    await this.enter('appendEvent');
    this.events.push({ job_id: jobId, message });
  }

  async getFlag(key: FlagKey): Promise<boolean> {
    await this.enter('getFlag');
    return this.flags.get(key) ?? false;
  }
}
