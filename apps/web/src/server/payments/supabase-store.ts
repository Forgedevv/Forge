import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FlagKey, JobStatus } from '@forge/shared';
import { StoreError } from './errors';
import {
  parseJobRow,
  parseLaunchpadRow,
  parsePaymentRow,
  type AnomalyWriteResult,
  type ConfirmWriteResult,
  type JobContext,
  type NewPayment,
  type NewPaymentAnomaly,
  type OpenQuoteQuery,
  type PaymentRecord,
  type PaymentsStore,
} from './store';

/*
 * PaymentsStore over Supabase with the service role key (server only, bypasses RLS). Each
 * money-relevant write is a single conditional UPDATE, atomic in Postgres.
 */

const UNIQUE_VIOLATION = '23505';
/** `payment_anomalies.note` is at most 1000 characters (migration 0008). */
const MAX_ANOMALY_NOTE = 1000;

interface DbError {
  code?: string;
}

function fail(operation: string, error: DbError | null): never {
  throw new StoreError(operation, error?.code);
}

export function createServiceSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class SupabasePaymentsStore implements PaymentsStore {
  constructor(private readonly db: SupabaseClient) {}

  async getJobContext(jobId: string): Promise<JobContext | null> {
    const jobRes = await this.db
      .from('jobs')
      .select('id, launchpad_id, type, status')
      .eq('id', jobId)
      .maybeSingle();
    if (jobRes.error) fail('read job', jobRes.error);
    if (!jobRes.data) return null;
    const job = parseJobRow(jobRes.data);
    const lpRes = await this.db
      .from('launchpads')
      .select('id, owner_wallet, spec, included_modifications_left, status')
      .eq('id', job.launchpadId)
      .maybeSingle();
    if (lpRes.error) fail('read launchpad', lpRes.error);
    if (!lpRes.data) return null;
    return { job, launchpad: parseLaunchpadRow(lpRes.data) };
  }

  async getIncludedModificationsLeft(launchpadId: string): Promise<number | null> {
    const res = await this.db
      .from('launchpads')
      .select('included_modifications_left')
      .eq('id', launchpadId)
      .maybeSingle();
    if (res.error) fail('read included modifications', res.error);
    if (!res.data) return null;
    const value = (res.data as { included_modifications_left: unknown })
      .included_modifications_left;
    return typeof value === 'number' ? value : 0;
  }

  async getPayment(paymentId: string): Promise<PaymentRecord | null> {
    const res = await this.db.from('payments').select('*').eq('id', paymentId).maybeSingle();
    if (res.error) fail('read payment', res.error);
    return res.data ? parsePaymentRow(res.data) : null;
  }

  async findPaymentBySignature(signature: string): Promise<PaymentRecord | null> {
    const res = await this.db
      .from('payments')
      .select('*')
      .eq('tx_signature', signature)
      .maybeSingle();
    if (res.error) fail('find payment by signature', res.error);
    return res.data ? parsePaymentRow(res.data) : null;
  }

  async findConfirmedPaymentForJob(jobId: string): Promise<PaymentRecord | null> {
    const res = await this.db
      .from('payments')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: true })
      .limit(1);
    if (res.error) fail('find confirmed payment', res.error);
    const row = (res.data ?? [])[0];
    return row ? parsePaymentRow(row) : null;
  }

  async listConfirmedPaymentsForJob(jobId: string): Promise<PaymentRecord[]> {
    const res = await this.db
      .from('payments')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(50);
    if (res.error) fail('list confirmed payments', res.error);
    return (res.data ?? []).map(parsePaymentRow);
  }

  async findOpenQuote(query: OpenQuoteQuery): Promise<PaymentRecord | null> {
    const res = await this.db
      .from('payments')
      .select('*')
      .eq('job_id', query.jobId)
      .eq('payer_wallet', query.payerWallet)
      .eq('kind', query.kind)
      .eq('status', 'quoted')
      .is('tx_signature', null)
      .gt('lamports', 0)
      .gt('quote_expires_at', query.expiresAfter.toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1);
    if (res.error) fail('find open quote', res.error);
    const row = (res.data ?? [])[0];
    return row ? parsePaymentRow(row) : null;
  }

  async recordPaymentAnomaly(anomaly: NewPaymentAnomaly): Promise<AnomalyWriteResult> {
    const res = await this.db.from('payment_anomalies').insert({
      job_id: anomaly.jobId,
      payment_id: anomaly.paymentId,
      wallet: anomaly.wallet,
      signature: anomaly.signature,
      // bigint as a decimal string (see insertQuote).
      lamports: anomaly.lamports === null ? null : anomaly.lamports.toString(),
      reason: anomaly.reason,
      note: anomaly.note,
    });
    if (res.error) {
      if (res.error.code === UNIQUE_VIOLATION) return 'exists';
      fail('record payment anomaly', res.error);
    }
    return 'recorded';
  }

  async resolvePaidAnomaly(
    signature: string,
    paidPaymentId: string,
    note: string,
  ): Promise<number> {
    const read = await this.db
      .from('payment_anomalies')
      .select('id, payment_id, note')
      .eq('signature', signature)
      .is('resolved_at', null)
      .maybeSingle();
    if (read.error) fail('read payment anomaly', read.error);
    const row = read.data as { id?: unknown; payment_id?: unknown; note?: unknown } | null;
    if (!row || typeof row.id !== 'string' || row.payment_id === paidPaymentId) return 0;
    const previous = typeof row.note === 'string' && row.note.length > 0 ? `${row.note}; ` : '';
    const res = await this.db
      .from('payment_anomalies')
      .update({
        resolved_at: new Date().toISOString(),
        note: `${previous}${note}`.slice(0, MAX_ANOMALY_NOTE),
      })
      .eq('id', row.id)
      .is('resolved_at', null)
      .select('id');
    if (res.error) fail('resolve payment anomaly', res.error);
    return (res.data ?? []).length;
  }

  async insertQuote(payment: NewPayment): Promise<PaymentRecord> {
    const res = await this.db
      .from('payments')
      .insert({
        job_id: payment.jobId,
        payer_wallet: payment.payerWallet,
        kind: payment.kind,
        usd_amount: payment.usdAmount,
        // bigint as a decimal string: JSON has no bigint and PostgREST casts it exactly.
        lamports: payment.lamports.toString(),
        quote_expires_at: payment.quoteExpiresAt.toISOString(),
        status: 'quoted',
      })
      .select('*')
      .single();
    if (res.error || !res.data) fail('insert quote', res.error);
    return parsePaymentRow(res.data);
  }

  async confirmPayment(paymentId: string, signature: string): Promise<ConfirmWriteResult> {
    const res = await this.db
      .from('payments')
      .update({ status: 'confirmed', tx_signature: signature })
      .eq('id', paymentId)
      .in('status', ['quoted', 'expired'])
      .is('tx_signature', null)
      .select('id');
    if (res.error) {
      if (res.error.code === UNIQUE_VIOLATION) return 'signature_taken';
      fail('confirm payment', res.error);
    }
    return (res.data ?? []).length === 1 ? 'confirmed' : 'not_updated';
  }

  async confirmIncludedPayment(paymentId: string): Promise<boolean> {
    const res = await this.db
      .from('payments')
      .update({ status: 'confirmed' })
      .eq('id', paymentId)
      .eq('status', 'quoted')
      .eq('lamports', 0)
      .is('tx_signature', null)
      .select('id');
    if (res.error) fail('confirm included payment', res.error);
    return (res.data ?? []).length === 1;
  }

  async markPaymentExpired(paymentId: string): Promise<boolean> {
    const res = await this.db
      .from('payments')
      .update({ status: 'expired' })
      .eq('id', paymentId)
      .eq('status', 'quoted')
      .is('tx_signature', null)
      .select('id');
    if (res.error) fail('expire payment', res.error);
    return (res.data ?? []).length === 1;
  }

  async transitionJob(jobId: string, from: JobStatus, to: JobStatus): Promise<boolean> {
    const res = await this.db
      .from('jobs')
      .update({ status: to })
      .eq('id', jobId)
      .eq('status', from)
      .select('id');
    if (res.error) fail('transition job', res.error);
    return (res.data ?? []).length === 1;
  }

  async setIncludedModificationsLeft(
    launchpadId: string,
    expected: number,
    next: number,
  ): Promise<boolean> {
    if (next < 0) return false;
    const res = await this.db
      .from('launchpads')
      .update({ included_modifications_left: next })
      .eq('id', launchpadId)
      .eq('included_modifications_left', expected)
      .select('id');
    if (res.error) fail('update included modifications', res.error);
    return (res.data ?? []).length === 1;
  }

  async getFlag(key: FlagKey): Promise<boolean> {
    const res = await this.db.from('flags').select('value').eq('key', key).maybeSingle();
    if (res.error) fail('read flag', res.error);
    return (res.data as { value?: unknown } | null)?.value === true;
  }

  async addJobEvent(jobId: string, message: string): Promise<void> {
    const res = await this.db.from('job_events').insert({ job_id: jobId, message });
    if (res.error) fail('insert job event', res.error);
  }
}
