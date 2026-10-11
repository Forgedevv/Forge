/// <reference types="node" />
import {
  FailedStage,
  FlagKey,
  JobStatus,
  JobType,
  type ActiveJobStatus,
  type JobRow,
} from '@forge/shared';
import { z } from 'zod';

/**
 * Supabase (PostgREST) access for the builder worker, service role only.
 *
 * Every state change of a job that the worker owns is a conditional update: it only applies if the
 * row is still locked by this worker in the expected active status. A worker whose lock was
 * recovered as stale therefore can never overwrite the state decided by someone else.
 *
 * No SDK dependency: plain `fetch` against `/rest/v1`.
 */

/** Fields the worker patches when a step succeeds. */
export interface JobPatch {
  preview_url?: string;
  owner_tx?: string;
}

/** The database operations of the worker. Implemented over PostgREST here, faked in tests. */
export interface JobsDb {
  /** SQL function `take_build_job` (INTERFACES.md §5, query 1). Null when nothing is available. */
  takeBuildJob(worker: string): Promise<JobRow | null>;
  /** SQL function `take_post_approval_job` (INTERFACES.md §5, query 2). */
  takePostApprovalJob(worker: string): Promise<JobRow | null>;
  /** SQL function `fail_stale_jobs`: active jobs with a lock older than `staleMinutes` -> failed. */
  failStaleJobs(staleMinutes: number): Promise<JobRow[]>;
  /** Refreshes `locked_at`. False when this worker no longer holds the lock. */
  heartbeat(jobId: string, worker: string): Promise<boolean>;
  /** Moves an active job forward and resets the lock. Null when the lock was lost. */
  completeStep(
    jobId: string,
    worker: string,
    from: ActiveJobStatus,
    to: JobStatus,
    patch: JobPatch,
  ): Promise<JobRow | null>;
  /** Moves an active job to `failed` and resets the lock. Null when the lock was lost. */
  failJob(
    jobId: string,
    worker: string,
    from: ActiveJobStatus,
    stage: FailedStage,
    error: string,
  ): Promise<JobRow | null>;
  /**
   * Gives a `building` job back to the queue (`paid`) without consuming a build attempt.
   * Only used for a graceful shutdown. Null when the lock was lost.
   */
  releaseBuild(jobId: string, worker: string, attemptsBefore: number): Promise<JobRow | null>;
  /** Appends a `job_events` line (read by the web through Realtime). */
  appendEvent(jobId: string, message: string): Promise<void>;
  /** Reads a kill switch. */
  getFlag(key: FlagKey): Promise<boolean>;
}

export class DbError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DbError';
    this.status = status;
  }
}

// The columns the worker relies on are validated; other columns pass through.
const JobRowSchema = z.looseObject({
  id: z.string().min(1),
  launchpad_id: z.string().min(1),
  type: JobType,
  status: JobStatus,
  attempts: z.number().int(),
  failed_stage: FailedStage.nullable(),
  locked_by: z.string().nullable(),
  locked_at: z.string().nullable(),
});

const FlagRowsSchema = z.array(z.object({ value: z.boolean() }));

const ACTIVE_FILTER = 'in.(building,onchain_setup,deploying)';
const MAX_ERROR_BODY = 200;

export interface SupabaseJobsDbOptions {
  /** Project URL, e.g. https://xyz.supabase.co */
  url: string;
  /** Service role key. Never logged, never put in an error message. */
  serviceRoleKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export function createSupabaseJobsDb(opts: SupabaseJobsDbOptions): JobsDb {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => new Date());
  const base = opts.url.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Supabase URL must be http(s)');
  if (opts.serviceRoleKey.length === 0) throw new Error('Supabase service role key is required');

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    apikey: opts.serviceRoleKey,
    authorization: `Bearer ${opts.serviceRoleKey}`,
    'content-type': 'application/json',
    ...extra,
  });

  async function request(
    label: string,
    method: string,
    path: string,
    body: unknown,
    prefer?: string,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/rest/v1/${path}`, {
        method,
        headers: headers(prefer ? { prefer } : undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Only the error name: network errors can embed request details.
      throw new DbError(`${label}: request failed (${err instanceof Error ? err.name : 'error'})`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new DbError(
        `${label}: HTTP ${res.status} ${text.slice(0, MAX_ERROR_BODY)}`,
        res.status,
      );
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DbError(`${label}: invalid JSON response`, res.status);
    }
  }

  function parseJobs(label: string, json: unknown): JobRow[] {
    if (!Array.isArray(json)) throw new DbError(`${label}: unexpected response shape`);
    const rows: JobRow[] = [];
    for (const item of json) {
      const parsed = JobRowSchema.safeParse(item);
      if (!parsed.success) throw new DbError(`${label}: unexpected job row shape`);
      rows.push(parsed.data as unknown as JobRow);
    }
    return rows;
  }

  async function rpcOne(fn: string, args: Record<string, unknown>): Promise<JobRow | null> {
    const rows = parseJobs(fn, await request(fn, 'POST', `rpc/${fn}`, args));
    if (rows.length > 1) throw new DbError(`${fn}: returned more than one row`);
    return rows[0] ?? null;
  }

  /** PATCH with filters, returns the updated rows (empty when no row matched). */
  async function patch(
    label: string,
    filters: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<JobRow[]> {
    const qs = Object.entries(filters)
      .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%28/g, '(').replace(/%29/g, ')')}`)
      .join('&');
    return parseJobs(
      label,
      await request(label, 'PATCH', `jobs?${qs}`, body, 'return=representation'),
    );
  }

  const owned = (jobId: string, worker: string, from: ActiveJobStatus): Record<string, string> => ({
    id: `eq.${jobId}`,
    locked_by: `eq.${worker}`,
    status: `eq.${from}`,
  });

  return {
    takeBuildJob: (worker) => rpcOne('take_build_job', { worker }),
    takePostApprovalJob: (worker) => rpcOne('take_post_approval_job', { worker }),

    async failStaleJobs(staleMinutes) {
      if (!Number.isInteger(staleMinutes) || staleMinutes < 1) {
        throw new Error('staleMinutes must be a positive integer');
      }
      return parseJobs(
        'fail_stale_jobs',
        await request('fail_stale_jobs', 'POST', 'rpc/fail_stale_jobs', {
          stale_minutes: staleMinutes,
        }),
      );
    },

    async heartbeat(jobId, worker) {
      const rows = await patch(
        'heartbeat',
        { id: `eq.${jobId}`, locked_by: `eq.${worker}`, status: ACTIVE_FILTER },
        { locked_at: now().toISOString() },
      );
      return rows.length === 1;
    },

    async completeStep(jobId, worker, from, to, jobPatch) {
      const rows = await patch('complete_step', owned(jobId, worker, from), {
        ...jobPatch,
        status: to,
        locked_by: null,
        locked_at: null,
      });
      return rows[0] ?? null;
    },

    async failJob(jobId, worker, from, stage, error) {
      const rows = await patch('fail_job', owned(jobId, worker, from), {
        status: 'failed',
        failed_stage: stage,
        error,
        locked_by: null,
        locked_at: null,
      });
      return rows[0] ?? null;
    },

    async releaseBuild(jobId, worker, attemptsBefore) {
      const rows = await patch('release_build', owned(jobId, worker, 'building'), {
        status: 'paid',
        attempts: Math.max(0, attemptsBefore - 1),
        locked_by: null,
        locked_at: null,
      });
      return rows[0] ?? null;
    },

    async appendEvent(jobId, message) {
      await request(
        'append_event',
        'POST',
        'job_events',
        { job_id: jobId, message },
        'return=minimal',
      );
    },

    async getFlag(key) {
      const json = await request('get_flag', 'GET', `flags?key=eq.${key}&select=value`, undefined);
      const parsed = FlagRowsSchema.safeParse(json);
      if (!parsed.success) throw new DbError('get_flag: unexpected response shape');
      // A missing row means the switch was never set: not paused.
      return parsed.data[0]?.value ?? false;
    },
  };
}
