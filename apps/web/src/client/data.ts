import { FailedStage, JobStatus, JobType, type Job, type JobEvent } from '@forge/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { networkError } from './errors';

/** Columns the browser may read (never `owner_tx`). */
export const JOB_COLUMNS =
  'id,launchpad_id,type,status,attempts,failed_stage,request,preview_url,error,created_at,updated_at';

const Timestamp = z.string().nullable().optional();

export const JobRowSchema = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  type: JobType,
  status: JobStatus,
  attempts: z.number().nullable().optional(),
  failed_stage: FailedStage.nullable().optional(),
  request: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type JobRowData = z.infer<typeof JobRowSchema>;

export const JobEventRowSchema = z.object({
  id: z.number(),
  job_id: z.string(),
  message: z.string(),
  created_at: Timestamp,
});

const PaymentRowSchema = z.object({
  lamports: z.union([z.string(), z.number()]),
  status: z.string(),
  refund_signature: z.string().nullable().optional(),
});

function lamportsString(v: string | number): string {
  try {
    return BigInt(String(v)).toString();
  } catch {
    return '0';
  }
}

export function mapJob(row: JobRowData, refund?: Job['refund']): Job {
  const job: Job = {
    id: row.id,
    launchpadId: row.launchpad_id,
    type: row.type,
    status: row.status,
    attempts: row.attempts ?? 0,
    failedStage: row.failed_stage ?? null,
    error: row.error ?? null,
    previewUrl: row.preview_url ?? null,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? row.created_at ?? '',
  };
  if (refund !== undefined) job.refund = refund;
  return job;
}

export function mapJobEvent(row: z.infer<typeof JobEventRowSchema>): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    message: row.message,
    createdAt: row.created_at ?? '',
  };
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw networkError(new Error(res.error.message));
  return res.data;
}

export async function fetchJob(sb: SupabaseClient, jobId: string): Promise<Job | null> {
  const row = check(await sb.from('jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle());
  if (!row) return null;
  const parsed = JobRowSchema.safeParse(row);
  if (!parsed.success) return null;
  let refund: Job['refund'] = null;
  if (parsed.data.status === 'refunded') {
    const pays = check(
      await sb
        .from('payments')
        .select('lamports,status,refund_signature')
        .eq('job_id', jobId)
        .eq('status', 'refunded'),
    );
    const p = z.array(PaymentRowSchema).safeParse(pays ?? []);
    const first = p.success ? p.data[0] : undefined;
    if (first?.refund_signature) {
      refund = { lamports: lamportsString(first.lamports), signature: first.refund_signature };
    }
  }
  return mapJob(parsed.data, refund);
}

export async function fetchJobEvents(sb: SupabaseClient, jobId: string): Promise<JobEvent[]> {
  const rows = check(
    await sb
      .from('job_events')
      .select('id,job_id,message,created_at')
      .eq('job_id', jobId)
      .order('id'),
  );
  const parsed = z.array(JobEventRowSchema).safeParse(rows ?? []);
  return parsed.success ? parsed.data.map(mapJobEvent) : [];
}
