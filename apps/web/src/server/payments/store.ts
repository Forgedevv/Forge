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

export interface PaymentsStore {
  getJobContext(jobId: string): Promise<JobContext | null>;
  getIncludedModificationsLeft(launchpadId: string): Promise<number | null>;
  getPayment(paymentId: string): Promise<PaymentRecord | null>;
  findPaymentBySignature(signature: string): Promise<PaymentRecord | null>;
  /** A payment of this job in status `confirmed`, if any. */
  findConfirmedPaymentForJob(jobId: string): Promise<PaymentRecord | null>;
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
