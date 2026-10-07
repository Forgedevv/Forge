import {
  FailedStage,
  JobStatus,
  JobType,
  LaunchpadStatus,
  isActiveJobStatus,
  type Job,
  type JobEvent,
  type LaunchpadDetail,
  type LaunchpadSpecDraft,
  type LaunchpadSummary,
} from '@forge/shared';
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

export const LaunchpadRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  spec: z.record(z.string(), z.unknown()),
  launchpad_config: z.string().nullable().optional(),
  launchpad_coin_config: z.string().nullable().optional(),
  launchpad_coin_mint: z.string().nullable().optional(),
  included_modifications_left: z.number().nullable().optional(),
  status: LaunchpadStatus,
  created_at: Timestamp,
});
export type LaunchpadRowData = z.infer<typeof LaunchpadRowSchema>;

const CoinSpec = z
  .object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    imageUrl: z.string().optional(),
  })
  .optional();

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

export function mapLaunchpadSummary(row: LaunchpadRowData, jobs: Job[]): LaunchpadSummary {
  const name = typeof row.spec.name === 'string' ? row.spec.name : row.slug;
  const coin = CoinSpec.safeParse(row.spec.launchpadCoin);
  const c = coin.success ? coin.data : undefined;
  const active = jobs
    .filter((j) => j.launchpadId === row.id && isActiveJobStatus(j.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    id: row.id,
    name,
    slug: row.slug,
    // Not stored in the database: needs a server-provided value (see contract gaps).
    siteUrl: null,
    status: row.status,
    coin: {
      name: c?.name ?? '',
      symbol: c?.symbol ?? '',
      mint: row.launchpad_coin_mint ?? null,
      imageUrl: c?.imageUrl ?? '',
    },
    coinsCount: 0,
    claimablePartnerFeesLamports: '0',
    includedModificationsLeft: row.included_modifications_left ?? 0,
    activeJobId: active?.id ?? null,
  };
}

export function mapLaunchpadDetail(
  row: LaunchpadRowData,
  jobRows: JobRowData[],
): LaunchpadDetail {
  const jobs = jobRows.map((r) => mapJob(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const versions = jobRows
    .filter((r) => r.status === 'live')
    .map((r) => ({
      jobId: r.id,
      createdAt: r.created_at ?? '',
      request: r.request ?? null,
      previewUrl: r.preview_url ?? null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    ...mapLaunchpadSummary(row, jobs),
    spec: row.spec as LaunchpadSpecDraft,
    onchain: {
      launchpadConfig: row.launchpad_config ?? null,
      launchpadCoinConfig: row.launchpad_coin_config ?? null,
      launchpadCoinMint: row.launchpad_coin_mint ?? null,
    },
    versions,
    jobs,
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
    await sb.from('job_events').select('id,job_id,message,created_at').eq('job_id', jobId).order('id'),
  );
  const parsed = z.array(JobEventRowSchema).safeParse(rows ?? []);
  return parsed.success ? parsed.data.map(mapJobEvent) : [];
}

async function fetchJobRows(sb: SupabaseClient, launchpadIds: string[]): Promise<JobRowData[]> {
  if (launchpadIds.length === 0) return [];
  const rows = check(await sb.from('jobs').select(JOB_COLUMNS).in('launchpad_id', launchpadIds));
  const parsed = z.array(JobRowSchema).safeParse(rows ?? []);
  return parsed.success ? parsed.data : [];
}

export async function fetchLaunchpads(sb: SupabaseClient): Promise<LaunchpadSummary[]> {
  const rows = check(
    await sb.from('launchpads').select('*').order('created_at', { ascending: false }),
  );
  const parsed = z.array(LaunchpadRowSchema).safeParse(rows ?? []);
  if (!parsed.success) return [];
  const jobRows = await fetchJobRows(
    sb,
    parsed.data.map((r) => r.id),
  );
  const jobs = jobRows.map((r) => mapJob(r));
  return parsed.data.map((r) => mapLaunchpadSummary(r, jobs));
}

export async function fetchLaunchpad(
  sb: SupabaseClient,
  id: string,
): Promise<LaunchpadDetail | null> {
  const row = check(await sb.from('launchpads').select('*').eq('id', id).maybeSingle());
  if (!row) return null;
  const parsed = LaunchpadRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const jobRows = await fetchJobRows(sb, [id]);
  return mapLaunchpadDetail(parsed.data, jobRows);
}
