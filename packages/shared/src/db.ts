import { z } from 'zod';
import type { FailedStage, JobStatus, JobType } from './jobs.js';
import { SolanaAddress, type LaunchpadSpec } from './spec.js';

/**
 * Row types of the Supabase tables (docs/INTERFACES.md §5). Column names are kept in snake_case.
 * Nullability mirrors the SQL exactly: a column without `not null` is typed `| null`, even when
 * it has a default.
 */

export const LaunchpadStatus = z.enum(['draft', 'live', 'sleeping', 'disabled']);
export type LaunchpadStatus = z.infer<typeof LaunchpadStatus>;

/** One DNS label: lowercase letters, digits and inner dashes, 1 to 63 characters. */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME_RE = new RegExp(`^(?=.{4,253}$)(?:${HOST_LABEL}\\.)+[a-z]{2,63}$`);
const VERCEL_APP_HOST_RE = new RegExp(`^${HOST_LABEL}\\.vercel\\.app$`);

/**
 * Shape of `launchpads.site_host` (migration 0011 holds the same CHECK): a lowercase DNS name
 * without scheme, port, path or trailing dot. Under `vercel.app` (Vercel's production aliases),
 * exactly one label; `vercel.app` itself is never a site host.
 */
export function isSiteHost(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'vercel.app' || !HOST_NAME_RE.test(value)) {
    return false;
  }
  return !value.endsWith('.vercel.app') || VERCEL_APP_HOST_RE.test(value);
}

/** A site host on `vercel.app` (`<one label>.vercel.app`). */
export function isVercelAppHost(value: unknown): value is string {
  return isSiteHost(value) && value.endsWith('.vercel.app');
}

/**
 * The recorded `site_host` of the launchpad `slug`, when a reader may trust it (relay origins,
 * upload `auth.host`, links to the site): exactly `<one label>.vercel.app` (an alias of the
 * launchpad's own Vercel project, checked by the builder before it records one), or exactly
 * `<slug>.<clientsDomain>`. Any other host, however well formed (another domain, the subdomain of
 * another launchpad), is ignored: null. `clientsDomain` is lowercase (readClientsDomain).
 */
export function trustedSiteHost(
  siteHost: unknown,
  slug: string,
  clientsDomain: string | null,
): string | null {
  if (!isSiteHost(siteHost)) return null;
  if (isVercelAppHost(siteHost)) return siteHost;
  return clientsDomain !== null && siteHost === `${slug}.${clientsDomain}` ? siteHost : null;
}

export const SiteHost = z.string().refine(isSiteHost, {
  error: 'Must be a lowercase host name (one label under vercel.app)',
});

export const PaymentStatus = z.enum(['quoted', 'confirmed', 'expired', 'refunded']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PaymentKind = z.enum(['creation', 'modification']);
export type PaymentKind = z.infer<typeof PaymentKind>;

export const ChatRole = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRole>;

/** Kill switches. */
export const FlagKey = z.enum([
  'deploys_paused',
  'buyback_paused',
  'signups_paused',
  'claims_paused',
  'cashbox_sweep_paused',
  'refunds_paused',
  'jupiter_claims_paused',
  'convert_paused',
]);
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
  /**
   * Exact production host of the client site (`SiteHost`), recorded by the builder from the Vercel
   * API when the site goes live: the verified `<slug>.<CLIENTS_DOMAIN>`, else a `*.vercel.app`
   * alias of the launchpad's own Vercel project. Trusted by exact match only (RPC relay origins,
   * coin uploads, site links). Null until recorded (migration 0011).
   */
  site_host: string | null;
}

/**
 * `jobs.owner_tx_details` (jsonb): the public accounts of the launch transaction stored in
 * `jobs.owner_tx`, as the signer reported them (`details` of `POST /v1/launch-coin/prepare`). The
 * builder writes it in the same update as `owner_tx`; apps/web pins these accounts when it checks
 * the stored transaction (`verifyLaunchCoinTransaction` of @forge/core) and hands them to the
 * browser (`OwnerTransactionLaunch`), instead of reading them back from the transaction.
 * `config` is the launchpad coin config. Null on rows written before migration 0009.
 */
export const JobOwnerTxDetails = z.object({
  config: SolanaAddress,
  pool: SolanaAddress,
  /** FORGE creator wallet of the launchpad: pool creator and durable nonce authority. */
  creator: SolanaAddress,
  /** Durable nonce account of the launch transaction. */
  nonceAccount: SolanaAddress,
  /** Coin metadata URI written by the pool creation (https, kept exactly as sent). */
  metadataUri: z.url({ protocol: /^https$/, error: 'Must be an https URL' }),
});
export type JobOwnerTxDetails = z.infer<typeof JobOwnerTxDetails>;

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
  /** Launch accounts of `owner_tx` (jsonb, validate with `JobOwnerTxDetails` when reading). */
  owner_tx_details: JobOwnerTxDetails | null;
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
  job_id: string;
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
  job_id: string;
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
