/**
 * What the signing routes read from and write to Supabase (docs/INTERFACES.md §5, §7).
 *
 * The routes never trust the request body beyond the job id: the job, the launchpad (and its
 * spec) and the payments are re-read here, with the service role key. The only writes are the
 * on-chain addresses the signer is the source of (configs, creator wallet ref, coin mint), as
 * compare-and-set updates: a column is only written when it is still null (or holds the value
 * being replaced), never blindly overwritten.
 */
import { z } from 'zod';
import { JobStatus, JobType, LaunchpadStatus, PaymentKind, PaymentStatus } from '@forge/shared';
import { JobError, eq, parseLamports, type PostgrestClient } from '../jobs/shared.js';

export interface RouteJob {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
}

export interface RouteLaunchpad {
  id: string;
  ownerWallet: string;
  slug: string;
  /** Raw `spec` column: parsed (and re-validated) by the route through @forge/core. */
  spec: unknown;
  status: LaunchpadStatus;
  launchpadConfig: string | null;
  launchpadCoinConfig: string | null;
  launchpadCoinMint: string | null;
  creatorWalletRef: string | null;
}

export interface RoutePayment {
  id: string;
  jobId: string;
  kind: PaymentKind;
  status: PaymentStatus;
  payerWallet: string;
  /** Dollar price of the quote (`usd_amount`): must be the shared price of the kind. */
  usdAmount: number;
  lamports: bigint;
  /** Signature of the client's payment transaction (set when the web confirmed it). */
  txSignature: string | null;
  /** Set by the refunds job once a refund was sent (whatever the status says). */
  refundSignature: string | null;
}

/** Launchpad columns written by the signer. */
export const LAUNCHPAD_ADDRESS_COLUMNS = [
  'launchpad_config',
  'launchpad_coin_config',
  'launchpad_coin_mint',
  'creator_wallet_ref',
] as const;
export type LaunchpadAddressColumn = (typeof LAUNCHPAD_ADDRESS_COLUMNS)[number];

export interface RouteStore {
  getJob(jobId: string): Promise<RouteJob | null>;
  getLaunchpad(launchpadId: string): Promise<RouteLaunchpad | null>;
  listPayments(jobId: string): Promise<RoutePayment[]>;
  /**
   * Compare-and-set on the launchpad row: sets `values` only if every column of `expected` holds
   * exactly that value (`null` = the column is null). True when the row was updated.
   */
  setLaunchpadColumns(
    launchpadId: string,
    values: Partial<Record<LaunchpadAddressColumn, string>>,
    expected: Partial<Record<LaunchpadAddressColumn, string | null>>,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------
// Supabase (PostgREST) implementation

const JobRowSchema = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  type: JobType,
  status: JobStatus,
});

const LaunchpadRowSchema = z.object({
  id: z.string(),
  owner_wallet: z.string(),
  slug: z.string(),
  spec: z.unknown(),
  status: LaunchpadStatus,
  launchpad_config: z.string().nullable(),
  launchpad_coin_config: z.string().nullable(),
  launchpad_coin_mint: z.string().nullable(),
  creator_wallet_ref: z.string().nullable(),
});

/** PostgREST serializes `numeric` as a JSON number or, through `::text`, as a decimal string. */
const DbNumeric = z.union([z.number().finite(), z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/)]);

const PaymentRowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  kind: PaymentKind,
  status: PaymentStatus,
  payer_wallet: z.string(),
  usd_amount: DbNumeric,
  lamports: z.union([z.string(), z.number()]),
  tx_signature: z.string().nullable(),
  refund_signature: z.string().nullable(),
});

function one<T>(schema: z.ZodType<T>, rows: unknown[], what: string): T | null {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw new JobError('DB_RESPONSE', `unexpected ${what} rows`);
  if (parsed.data.length > 1) throw new JobError('DB_RESPONSE', `more than one ${what} row`);
  return parsed.data[0] ?? null;
}

/** PostgREST filter for a compare-and-set expectation. */
function expectation(value: string | null): string {
  return value === null ? 'is.null' : eq(value);
}

export function createPostgrestRouteStore(db: PostgrestClient): RouteStore {
  return {
    async getJob(jobId) {
      const row = one(
        JobRowSchema,
        await db.select('jobs', { select: 'id,launchpad_id,type,status', id: eq(jobId) }),
        'job',
      );
      return row
        ? { id: row.id, launchpadId: row.launchpad_id, type: row.type, status: row.status }
        : null;
    },

    async getLaunchpad(launchpadId) {
      const row = one(
        LaunchpadRowSchema,
        await db.select('launchpads', {
          select:
            'id,owner_wallet,slug,spec,status,launchpad_config,launchpad_coin_config,launchpad_coin_mint,creator_wallet_ref',
          id: eq(launchpadId),
        }),
        'launchpad',
      );
      return row
        ? {
            id: row.id,
            ownerWallet: row.owner_wallet,
            slug: row.slug,
            spec: row.spec,
            status: row.status,
            launchpadConfig: row.launchpad_config,
            launchpadCoinConfig: row.launchpad_coin_config,
            launchpadCoinMint: row.launchpad_coin_mint,
            creatorWalletRef: row.creator_wallet_ref,
          }
        : null;
    },

    async listPayments(jobId) {
      const rows = await db.select('payments', {
        select:
          'id,job_id,kind,status,payer_wallet,usd_amount,lamports::text,tx_signature,refund_signature',
        job_id: eq(jobId),
        order: 'created_at.asc,id.asc',
      });
      const parsed = z.array(PaymentRowSchema).safeParse(rows);
      if (!parsed.success) throw new JobError('DB_RESPONSE', 'unexpected payment rows');
      return parsed.data.map((r) => ({
        id: r.id,
        jobId: r.job_id,
        kind: r.kind,
        status: r.status,
        payerWallet: r.payer_wallet,
        usdAmount: Number(r.usd_amount),
        lamports: parseLamports(r.lamports),
        txSignature: r.tx_signature,
        refundSignature: r.refund_signature,
      }));
    },

    async setLaunchpadColumns(launchpadId, values, expected) {
      const patch: Record<string, string> = {};
      for (const [column, value] of Object.entries(values)) {
        if (!(LAUNCHPAD_ADDRESS_COLUMNS as readonly string[]).includes(column)) {
          throw new JobError('DB', 'column not writable by the signer');
        }
        if (value !== undefined) patch[column] = value;
      }
      if (Object.keys(patch).length === 0) throw new JobError('DB', 'empty launchpad update');
      const filters: Record<string, string> = { id: eq(launchpadId) };
      for (const [column, value] of Object.entries(expected)) {
        if (!(LAUNCHPAD_ADDRESS_COLUMNS as readonly string[]).includes(column)) {
          throw new JobError('DB', 'unexpected compare-and-set column');
        }
        if (value !== undefined) filters[column] = expectation(value);
      }
      const rows = await db.update('launchpads', filters, patch);
      if (rows.length > 1) throw new JobError('DB_RESPONSE', 'updated more than one launchpad');
      return rows.length === 1;
    },
  };
}
