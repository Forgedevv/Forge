import {
  FlagKey,
  JobStatus,
  JobType,
  LaunchpadStatus,
  PaymentKind,
  PaymentStatus,
} from '@forge/shared';
import { z } from 'zod';
import { StoreError } from './errors';

/*
 * Persistence of the payment routes. Every write that matters for money is a CONDITIONAL update
 * (compare-and-set on the expected current state) so that retries and concurrent requests are
 * idempotent; `payments.tx_signature` is UNIQUE in the database (supabase/migrations/0001), which
 * is the exactly-once guarantee for a transaction signature.
 */

export interface JobRecord {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
}

export interface LaunchpadRecord {
  id: string;
  ownerWallet: string;
  /** `spec.ownerWallet`, which must equal `owner_wallet` (docs/SECURITY.md §10). */
  specOwnerWallet: string | null;
  includedModificationsLeft: number;
  status: LaunchpadStatus;
}

export interface JobContext {
  job: JobRecord;
  launchpad: LaunchpadRecord;
}

export interface PaymentRecord {
  id: string;
  jobId: string;
  payerWallet: string;
  kind: PaymentKind;
  usdAmount: number;
  lamports: bigint;
  /** Unix milliseconds. */
  quoteExpiresAt: number;
  txSignature: string | null;
  status: PaymentStatus;
}

export interface NewPayment {
  jobId: string;
  payerWallet: string;
  kind: PaymentKind;
  usdAmount: number;
  lamports: bigint;
  quoteExpiresAt: Date;
}

/**
 * Result of recording a signature on a payment:
 * - `confirmed`: this call set the signature (status quoted|expired -> confirmed);
 * - `not_updated`: the payment no longer accepts a signature (re-read it to know why);
 * - `signature_taken`: another payment already holds this signature (unique violation).
 */
export type ConfirmWriteResult = 'confirmed' | 'not_updated' | 'signature_taken';

/**
 * Why money that reached the cashbox could not pay for its job (docs/DECISIONS.md D20, table
 * `payment_anomalies`, supabase/migrations/0008). Recorded for a manual refund.
 */
export type PaymentAnomalyReason = 'late' | 'amount_mismatch' | 'launchpad_released' | 'duplicate';

export interface NewPaymentAnomaly {
  jobId: string;
  /** The quote the transaction was presented for (or the duplicate payment). */
  paymentId: string | null;
  /** The payer: session wallet = launchpad owner = signer of the transaction. */
  wallet: string;
  signature: string;
  /** Lamports moved to the cashbox; null when the verification result does not carry them. */
  lamports: bigint | null;
  reason: PaymentAnomalyReason;
  note: string | null;
}

/** `recorded` when this call wrote the row, `exists` when the signature was already recorded. */
export type AnomalyWriteResult = 'recorded' | 'exists';

export interface OpenQuoteQuery {
  jobId: string;
  payerWallet: string;
  kind: PaymentKind;
  /** Only quotes whose expiry is strictly after this instant. */
  expiresAfter: Date;
}

export interface PaymentsStore {
  getJobContext(jobId: string): Promise<JobContext | null>;
  getIncludedModificationsLeft(launchpadId: string): Promise<number | null>;
  getPayment(paymentId: string): Promise<PaymentRecord | null>;
  findPaymentBySignature(signature: string): Promise<PaymentRecord | null>;
  /** A payment of this job in status `confirmed`, if any. */
  findConfirmedPaymentForJob(jobId: string): Promise<PaymentRecord | null>;
  /** Every payment of this job in status `confirmed`, oldest first (creation order, then id). */
  listConfirmedPaymentsForJob(jobId: string): Promise<PaymentRecord[]>;
  /**
   * The oldest open paid quote of this job and payer: status `quoted`, no signature, more than 0
   * lamports, of `kind`, expiring after `expiresAfter` (creation order, then id).
   */
  findOpenQuote(query: OpenQuoteQuery): Promise<PaymentRecord | null>;
  /** Inserts an anomaly; idempotent on the signature (UNIQUE `payment_anomalies.signature`). */
  recordPaymentAnomaly(anomaly: NewPaymentAnomaly): Promise<AnomalyWriteResult>;
  /**
   * Closes the open anomaly of `signature` (at most one, UNIQUE) when it was recorded for another
   * payment than `paidPaymentId`: the transaction pays that payment, so nothing is owed back for
   * it. Sets `resolved_at` and appends `note` (rows are never deleted: the service role has no
   * delete privilege on `payment_anomalies`, migration 0008). Returns the number of rows closed.
   */
  resolvePaidAnomaly(signature: string, paidPaymentId: string, note: string): Promise<number>;
  /** Inserts a payment in status `quoted`. */
  insertQuote(payment: NewPayment): Promise<PaymentRecord>;
  /** quoted|expired + no signature -> confirmed + signature. */
  confirmPayment(paymentId: string, signature: string): Promise<ConfirmWriteResult>;
  /** quoted + 0 lamports + no signature -> confirmed (included modification). */
  confirmIncludedPayment(paymentId: string): Promise<boolean>;
  /** quoted + no signature -> expired. */
  markPaymentExpired(paymentId: string): Promise<boolean>;
  /** Conditional job transition: only applies when the job is in `from`. */
  transitionJob(jobId: string, from: JobStatus, to: JobStatus): Promise<boolean>;
  /** Compare-and-set of `launchpads.included_modifications_left`. */
  setIncludedModificationsLeft(
    launchpadId: string,
    expected: number,
    next: number,
  ): Promise<boolean>;
  getFlag(key: FlagKey): Promise<boolean>;
  /** Message shown in the job's real-time feed. */
  addJobEvent(jobId: string, message: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Row parsing (PostgREST returns bigint/numeric as number or string)
// ---------------------------------------------------------------------------------------------

const DbBigint = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);
const DbNumeric = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

export const PaymentRowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  payer_wallet: z.string(),
  kind: PaymentKind,
  usd_amount: DbNumeric,
  lamports: DbBigint,
  quote_expires_at: z.string(),
  tx_signature: z.string().nullable(),
  status: PaymentStatus,
});

export const JobRowSchema = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  type: JobType,
  status: JobStatus,
});

export const LaunchpadRowSchema = z.object({
  id: z.string(),
  owner_wallet: z.string(),
  spec: z.unknown(),
  included_modifications_left: z.number().int().nullable(),
  status: LaunchpadStatus,
});

export function parsePaymentRow(row: unknown): PaymentRecord {
  const parsed = PaymentRowSchema.safeParse(row);
  if (!parsed.success) throw new StoreError('parse payment row');
  const r = parsed.data;
  const expiresAt = Date.parse(r.quote_expires_at);
  if (!Number.isFinite(expiresAt)) throw new StoreError('parse payment row');
  return {
    id: r.id,
    jobId: r.job_id,
    payerWallet: r.payer_wallet,
    kind: r.kind,
    usdAmount: Number(r.usd_amount),
    lamports: BigInt(String(r.lamports)),
    quoteExpiresAt: expiresAt,
    txSignature: r.tx_signature,
    status: r.status,
  };
}

export function parseJobRow(row: unknown): JobRecord {
  const parsed = JobRowSchema.safeParse(row);
  if (!parsed.success) throw new StoreError('parse job row');
  const r = parsed.data;
  return { id: r.id, launchpadId: r.launchpad_id, type: r.type, status: r.status };
}

function specOwner(spec: unknown): string | null {
  if (spec && typeof spec === 'object') {
    const owner = (spec as Record<string, unknown>).ownerWallet;
    if (typeof owner === 'string') return owner;
  }
  return null;
}

export function parseLaunchpadRow(row: unknown): LaunchpadRecord {
  const parsed = LaunchpadRowSchema.safeParse(row);
  if (!parsed.success) throw new StoreError('parse launchpad row');
  const r = parsed.data;
  return {
    id: r.id,
    ownerWallet: r.owner_wallet,
    specOwnerWallet: specOwner(r.spec),
    includedModificationsLeft: r.included_modifications_left ?? 0,
    status: r.status,
  };
}
