import type { FlagKey, JobStatus, LaunchpadStatus } from '@forge/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  JOB_COLUMNS,
  LAUNCHPAD_COLUMNS,
  StoreError,
  parseConversationRow,
  parseJobEventRow,
  parseJobRow,
  parseLaunchpadRow,
  parseRefundRow,
  type ConversationRecord,
  type JobEventRecord,
  type JobRecord,
  type LaunchpadRecord,
  type OwnedJob,
  type RefundRecord,
  type RoutesStore,
} from './store';

/*
 * RoutesStore over Supabase with the service role key (server only). The service role bypasses
 * Row Level Security, so every query carries the owner filter itself: `owner_wallet = wallet` on
 * launchpads and conversations, an inner join on the launchpad for jobs and job events, and
 * `payer_wallet = wallet` on payments.
 */

interface DbError {
  code?: string;
}

function fail(operation: string, error: DbError | null): never {
  throw new StoreError(operation, error?.code);
}

/** Bounds the `in (...)` lists (a wallet has a handful of launchpads). */
const MAX_IN_LIST = 200;

function bounded(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_IN_LIST);
}

export function createServiceSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class SupabaseRoutesStore implements RoutesStore {
  constructor(private readonly db: SupabaseClient) {}

  async getOwnedJob(jobId: string, wallet: string): Promise<OwnedJob | null> {
    const res = await this.db
      .from('jobs')
      .select(`${JOB_COLUMNS}, launchpad:launchpads!inner(${LAUNCHPAD_COLUMNS})`)
      .eq('id', jobId)
      .eq('launchpad.owner_wallet', wallet)
      .maybeSingle();
    if (res.error) fail('read job', res.error);
    if (!res.data) return null;
    const row = res.data as Record<string, unknown>;
    const launchpad = parseLaunchpadRow(row.launchpad);
    // Defense in depth: the inner join already filtered on the owner.
    if (launchpad.ownerWallet !== wallet) return null;
    return { job: parseJobRow(row), launchpad };
  }

  async listJobEvents(jobId: string, wallet: string): Promise<JobEventRecord[]> {
    const res = await this.db
      .from('job_events')
      .select(
        'id, job_id, message, created_at, job:jobs!inner(launchpad:launchpads!inner(owner_wallet))',
      )
      .eq('job_id', jobId)
      .eq('job.launchpad.owner_wallet', wallet)
      .order('id', { ascending: true })
      .limit(500);
    if (res.error) fail('read job events', res.error);
    return (res.data ?? []).map(parseJobEventRow);
  }

  async transitionJob(
    jobId: string,
    launchpadId: string,
    from: JobStatus,
    to: JobStatus,
  ): Promise<boolean> {
    const res = await this.db
      .from('jobs')
      .update({ status: to })
      .eq('id', jobId)
      .eq('launchpad_id', launchpadId)
      .eq('status', from)
      .select('id');
    if (res.error) fail('update job status', res.error);
    return (res.data ?? []).length === 1;
  }

  async addJobEvent(jobId: string, message: string): Promise<void> {
    const res = await this.db.from('job_events').insert({ job_id: jobId, message });
    if (res.error) fail('insert job event', res.error);
  }

  async getFlag(key: FlagKey): Promise<boolean> {
    const res = await this.db.from('flags').select('value').eq('key', key).maybeSingle();
    if (res.error) fail('read flag', res.error);
    if (!res.data) return false;
    const value = (res.data as { value: unknown }).value;
    if (typeof value !== 'boolean') throw new StoreError('unexpected flag row');
    return value;
  }

  async getOwnedLaunchpad(launchpadId: string, wallet: string): Promise<LaunchpadRecord | null> {
    const res = await this.db
      .from('launchpads')
      .select(LAUNCHPAD_COLUMNS)
      .eq('id', launchpadId)
      .eq('owner_wallet', wallet)
      .maybeSingle();
    if (res.error) fail('read launchpad', res.error);
    return res.data ? parseLaunchpadRow(res.data) : null;
  }

  async listOwnedLaunchpads(wallet: string): Promise<LaunchpadRecord[]> {
    const res = await this.db
      .from('launchpads')
      .select(LAUNCHPAD_COLUMNS)
      .eq('owner_wallet', wallet)
      .order('created_at', { ascending: false })
      .limit(MAX_IN_LIST);
    if (res.error) fail('read launchpads', res.error);
    return (res.data ?? []).map(parseLaunchpadRow);
  }

  async listOwnedJobs(wallet: string, launchpadIds: readonly string[]): Promise<JobRecord[]> {
    const ids = bounded(launchpadIds);
    if (ids.length === 0) return [];
    const res = await this.db
      .from('jobs')
      .select(`${JOB_COLUMNS}, launchpad:launchpads!inner(owner_wallet)`)
      .in('launchpad_id', ids)
      .eq('launchpad.owner_wallet', wallet)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (res.error) fail('read jobs', res.error);
    return (res.data ?? []).map(parseJobRow);
  }

  async listRefunds(wallet: string, jobIds: readonly string[]): Promise<RefundRecord[]> {
    const ids = bounded(jobIds);
    if (ids.length === 0) return [];
    const res = await this.db
      .from('payments')
      .select('job_id, lamports, refund_signature')
      .in('job_id', ids)
      .eq('payer_wallet', wallet)
      .eq('status', 'refunded');
    if (res.error) fail('read refunds', res.error);
    return (res.data ?? []).map(parseRefundRow).filter((r): r is RefundRecord => r !== null);
  }

  async getOwnedConversation(
    conversationId: string,
    wallet: string,
  ): Promise<ConversationRecord | null> {
    const res = await this.db
      .from('conversations')
      .select('id, owner_wallet, launchpad_id')
      .eq('id', conversationId)
      .eq('owner_wallet', wallet)
      .maybeSingle();
    if (res.error) fail('read conversation', res.error);
    return res.data ? parseConversationRow(res.data) : null;
  }

  async insertModificationJob(launchpadId: string, request: string): Promise<JobRecord> {
    const res = await this.db
      .from('jobs')
      .insert({
        launchpad_id: launchpadId,
        type: 'modify_launchpad',
        status: 'spec_ready',
        request,
      })
      .select(JOB_COLUMNS)
      .single();
    if (res.error) fail('insert modification job', res.error);
    return parseJobRow(res.data);
  }

  async updatePendingModificationRequest(
    jobId: string,
    launchpadId: string,
    request: string,
  ): Promise<boolean> {
    const res = await this.db
      .from('jobs')
      .update({ request })
      .eq('id', jobId)
      .eq('launchpad_id', launchpadId)
      .eq('type', 'modify_launchpad')
      .eq('status', 'spec_ready')
      .select('id');
    if (res.error) fail('update modification request', res.error);
    return (res.data ?? []).length === 1;
  }

  async deletePendingModificationJob(jobId: string, launchpadId: string): Promise<boolean> {
    const res = await this.db
      .from('jobs')
      .delete()
      .eq('id', jobId)
      .eq('launchpad_id', launchpadId)
      .eq('type', 'modify_launchpad')
      .eq('status', 'spec_ready')
      .select('id');
    if (res.error) fail('delete modification job', res.error);
    return (res.data ?? []).length === 1;
  }

  async transitionLaunchpad(
    launchpadId: string,
    wallet: string,
    from: LaunchpadStatus,
    to: LaunchpadStatus,
    lastTradeAt?: string,
  ): Promise<boolean> {
    const patch: Record<string, unknown> = { status: to };
    if (lastTradeAt !== undefined) patch.last_trade_at = lastTradeAt;
    const res = await this.db
      .from('launchpads')
      .update(patch)
      .eq('id', launchpadId)
      .eq('owner_wallet', wallet)
      .eq('status', from)
      .select('id');
    if (res.error) fail('update launchpad status', res.error);
    return (res.data ?? []).length === 1;
  }
}
