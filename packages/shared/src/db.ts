import { z } from 'zod';
import type { FailedStage, JobStatus, JobType } from './jobs.js';
import type { LaunchpadSpec } from './spec.js';

/**
 * Row types of the Supabase tables (docs/INTERFACES.md §5). Column names are kept in snake_case.
 * Nullability mirrors the SQL exactly: a column without `not null` is typed `| null`, even when
 * it has a default.
 */

export const LaunchpadStatus = z.enum(['draft', 'live', 'sleeping', 'disabled']);
export type LaunchpadStatus = z.infer<typeof LaunchpadStatus>;

export const PaymentStatus = z.enum(['quoted', 'confirmed', 'expired', 'refunded']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PaymentKind = z.enum(['creation', 'modification']);
export type PaymentKind = z.infer<typeof PaymentKind>;

export const ChatRole = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRole>;

/** Kill switches. */
export const FlagKey = z.enum(['deploys_paused', 'buyback_paused', 'signups_paused']);
export type FlagKey = z.infer<typeof FlagKey>;

/** ISO 8601 timestamp as returned by PostgREST for `timestamptz`. */
export type Timestamptz = string;
/**
 * Postgres `bigint` / `numeric`: PostgREST may return a JSON number or a string. Convert with
 * `BigInt(String(value))` for lamports, never with floating point math.
 */
export type DbBigint = number | string;
export type DbNumeric = number | string;

export interface UserRow {
  wallet: string;
  created_at: Timestamptz | null;
}

export interface LaunchpadRow {
  id: string;
  owner_wallet: string;
  slug: string;
  spec: LaunchpadSpec;
  github_repo: string | null;
  vercel_project_id: string | null;
  /** Meteora config address. */
  launchpad_config: string | null;
  launchpad_coin_config: string | null;
  launchpad_coin_mint: string | null;
  /** Identifier of the creator wallet inside the signer (never the key). */
  creator_wallet_ref: string | null;
  included_modifications_left: number | null;
  status: LaunchpadStatus;
  last_trade_at: Timestamptz | null;
  created_at: Timestamptz | null;
}

export interface JobRow {
  id: string;
  launchpad_id: string;
  type: JobType;
  status: JobStatus;
  /** Build attempts only. */
  attempts: number;
  /** Set when status = 'failed'. */
  failed_stage: FailedStage | null;
  /** Client request (modifications). */
  request: string | null;
  preview_url: string | null;
  /** Partially signed launch transaction (base64) with a durable nonce. */
  owner_tx: string | null;
  error: string | null;
  api_cost_usd: DbNumeric | null;
  /** Id of the worker holding the job. */
  locked_by: string | null;
  locked_at: Timestamptz | null;
  created_at: Timestamptz | null;
  updated_at: Timestamptz | null;
}

export interface PaymentRow {
  id: string;
  job_id: string | null;
  /** = launchpads.owner_wallet */
  payer_wallet: string;
  kind: PaymentKind;
  usd_amount: DbNumeric;
  lamports: DbBigint;
  quote_expires_at: Timestamptz;
  tx_signature: string | null;
  status: PaymentStatus;
  refund_signature: string | null;
  created_at: Timestamptz | null;
}

export interface ConversationRow {
  id: string;
  owner_wallet: string;
  /** Null while designing, set when the spec is confirmed. */
  launchpad_id: string | null;
  created_at: Timestamptz | null;
}

export interface ChatMessageRow {
  id: number;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: Timestamptz | null;
}

export interface JobEventRow {
  id: number;
  job_id: string | null;
  /** Shown in the chat in real time. */
  message: string;
  created_at: Timestamptz | null;
}

export interface FlagRow {
  key: FlagKey;
  value: boolean;
}

/** Table name -> row type. */
export interface Tables {
  users: UserRow;
  launchpads: LaunchpadRow;
  jobs: JobRow;
  payments: PaymentRow;
  conversations: ConversationRow;
  chat_messages: ChatMessageRow;
  job_events: JobEventRow;
  flags: FlagRow;
}
export type TableName = keyof Tables;
