import { FailedStage, JobStatus, JobType, LaunchpadStatus, type FlagKey } from '@forge/shared';
import { z } from 'zod';

/*
 * Storage seam of the job and launchpad routes. Every read is scoped to the session wallet
 * (`owner_wallet`, directly or through the launchpad of a job): the routes run with the service
 * role, which bypasses Row Level Security, so the owner filter is part of each query. Writes are
 * single conditional updates (compare-and-set on the current status), atomic in Postgres.
 */

export interface JobRecord {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  failedStage: FailedStage | null;
  request: string | null;
  previewUrl: string | null;
  /** Partially signed launch transaction (base64). Never sent to the browser except by GET owner-transaction. */
  ownerTx: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchpadRecord {
  id: string;
  ownerWallet: string;
  slug: string;
  /** Stored LaunchpadSpec (jsonb), parsed by the caller when needed. */
  spec: unknown;
  launchpadConfig: string | null;
  launchpadCoinConfig: string | null;
  launchpadCoinMint: string | null;
  includedModificationsLeft: number;
  status: LaunchpadStatus;
  createdAt: string;
}

export interface JobEventRecord {
  id: number;
  jobId: string;
  message: string;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  ownerWallet: string;
  launchpadId: string | null;
}

export interface RefundRecord {
  jobId: string;
  lamports: bigint;
  signature: string;
}

export interface OwnedJob {
  job: JobRecord;
  launchpad: LaunchpadRecord;
}

export interface RoutesStore {
  /** The job and its launchpad, only when the launchpad belongs to `wallet`. */
  getOwnedJob(jobId: string, wallet: string): Promise<OwnedJob | null>;
  /** Events of a job of `wallet`, oldest first. */
  listJobEvents(jobId: string, wallet: string): Promise<JobEventRecord[]>;
  /** Conditional status change; false when the job was not in `from`. */
  transitionJob(
    jobId: string,
    launchpadId: string,
    from: JobStatus,
    to: JobStatus,
  ): Promise<boolean>;
  addJobEvent(jobId: string, message: string): Promise<void>;
  /** Kill switch value; throws when it cannot be read (callers fail closed). */
  getFlag(key: FlagKey): Promise<boolean>;
  getOwnedLaunchpad(launchpadId: string, wallet: string): Promise<LaunchpadRecord | null>;
  /** Launchpads of `wallet`, newest first. */
  listOwnedLaunchpads(wallet: string): Promise<LaunchpadRecord[]>;
  /** Jobs of the given launchpads, restricted to those of `wallet`. */
  listOwnedJobs(wallet: string, launchpadIds: readonly string[]): Promise<JobRecord[]>;
  /** Refunded payments of the given jobs, paid by `wallet`. */
  listRefunds(wallet: string, jobIds: readonly string[]): Promise<RefundRecord[]>;
  getOwnedConversation(conversationId: string, wallet: string): Promise<ConversationRecord | null>;
  /** New `modify_launchpad` job in `spec_ready`. */
  insertModificationJob(launchpadId: string, request: string): Promise<JobRecord>;
  /** Rewrites the request of a modification job still in `spec_ready`. */
  updatePendingModificationRequest(
    jobId: string,
    launchpadId: string,
    request: string,
  ): Promise<boolean>;
  /** Deletes a modification job still in `spec_ready` (lost insertion race). */
  deletePendingModificationJob(jobId: string, launchpadId: string): Promise<boolean>;
  /**
   * Conditional launchpad status change for a launchpad of `wallet`. `lastTradeAt` resets the
   * dormancy clock.
   */
  transitionLaunchpad(
    launchpadId: string,
    wallet: string,
    from: LaunchpadStatus,
    to: LaunchpadStatus,
    lastTradeAt?: string,
  ): Promise<boolean>;
}

/** Database error with its Postgres/PostgREST code (never the message, which may echo values). */
export class StoreError extends Error {
  readonly dbCode: string | undefined;

  constructor(operation: string, dbCode?: string) {
    super(`database operation failed: ${operation}${dbCode ? ` (${dbCode})` : ''}`);
    this.name = 'StoreError';
    this.dbCode = dbCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------------------------

export const JOB_COLUMNS =
  'id, launchpad_id, type, status, attempts, failed_stage, request, preview_url, owner_tx, error, created_at, updated_at';

export const LAUNCHPAD_COLUMNS =
  'id, owner_wallet, slug, spec, launchpad_config, launchpad_coin_config, launchpad_coin_mint, included_modifications_left, status, created_at';

const Timestamp = z.string().nullable().optional();

const JobRowSchema = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  type: JobType,
  status: JobStatus,
  attempts: z.number().int().nullable().optional(),
  failed_stage: FailedStage.nullable().optional(),
  request: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
  owner_tx: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: Timestamp,
  updated_at: Timestamp,
});

const LaunchpadRowSchema = z.object({
  id: z.string(),
  owner_wallet: z.string(),
  slug: z.string(),
  spec: z.unknown(),
  launchpad_config: z.string().nullable().optional(),
  launchpad_coin_config: z.string().nullable().optional(),
  launchpad_coin_mint: z.string().nullable().optional(),
  included_modifications_left: z.number().int().nullable().optional(),
  status: LaunchpadStatus,
  created_at: Timestamp,
});

const JobEventRowSchema = z.object({
  id: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
  job_id: z.string(),
  message: z.string(),
  created_at: Timestamp,
});

const ConversationRowSchema = z.object({
  id: z.string(),
  owner_wallet: z.string(),
  launchpad_id: z.string().nullable().optional(),
});

const RefundRowSchema = z.object({
  job_id: z.string(),
  lamports: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  refund_signature: z.string().nullable().optional(),
});

function parse<T>(schema: z.ZodType<T>, row: unknown, what: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new StoreError(`unexpected ${what} row`);
  return parsed.data;
}

export function parseJobRow(row: unknown): JobRecord {
  const r = parse(JobRowSchema, row, 'job');
  const createdAt = r.created_at ?? '';
  return {
    id: r.id,
    launchpadId: r.launchpad_id,
    type: r.type,
    status: r.status,
    attempts: r.attempts ?? 0,
    failedStage: r.failed_stage ?? null,
    request: r.request ?? null,
    previewUrl: r.preview_url ?? null,
    ownerTx: r.owner_tx ?? null,
    error: r.error ?? null,
    createdAt,
    updatedAt: r.updated_at ?? createdAt,
  };
}

export function parseLaunchpadRow(row: unknown): LaunchpadRecord {
  const r = parse(LaunchpadRowSchema, row, 'launchpad');
  return {
    id: r.id,
    ownerWallet: r.owner_wallet,
    slug: r.slug,
    spec: r.spec,
    launchpadConfig: r.launchpad_config ?? null,
    launchpadCoinConfig: r.launchpad_coin_config ?? null,
    launchpadCoinMint: r.launchpad_coin_mint ?? null,
    includedModificationsLeft: r.included_modifications_left ?? 0,
    status: r.status,
    createdAt: r.created_at ?? '',
  };
}

export function parseJobEventRow(row: unknown): JobEventRecord {
  const r = parse(JobEventRowSchema, row, 'job event');
  return { id: Number(r.id), jobId: r.job_id, message: r.message, createdAt: r.created_at ?? '' };
}

export function parseConversationRow(row: unknown): ConversationRecord {
  const r = parse(ConversationRowSchema, row, 'conversation');
  return { id: r.id, ownerWallet: r.owner_wallet, launchpadId: r.launchpad_id ?? null };
}

/** Null for a refunded payment whose refund signature is not recorded yet. */
export function parseRefundRow(row: unknown): RefundRecord | null {
  const r = parse(RefundRowSchema, row, 'payment');
  if (!r.refund_signature) return null;
  return { jobId: r.job_id, lamports: BigInt(String(r.lamports)), signature: r.refund_signature };
}
