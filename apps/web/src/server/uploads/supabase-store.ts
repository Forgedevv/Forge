import { isSiteHost } from '@forge/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { IMAGE_TYPES } from './contract';
import {
  UploadStoreError,
  type InsertResult,
  type LaunchpadRef,
  type SweepQuery,
  type TicketRecord,
  type UploadStore,
} from './store';

/*
 * UploadStore over Supabase with the service role key (server only; the table has RLS on and no
 * policy, so clients can neither read nor write it). Uniqueness is enforced by the table's
 * constraints; a unique violation is mapped from the constraint name.
 */

const UNIQUE_VIOLATION = '23505';
const TABLE = 'upload_tickets';

interface DbError {
  code?: string;
  message?: string;
}

function fail(operation: string, error: DbError | null): never {
  throw new UploadStoreError(operation, error?.code);
}

const LaunchpadRow = z.object({
  id: z.string(),
  slug: z.string(),
  status: z.string(),
  launchpad_coin_mint: z.string().nullable(),
  /** Shape checked when read: a malformed value is never trusted (null). */
  site_host: z.unknown().optional(),
});

const TicketRow = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  wallet: z.string(),
  nonce: z.string(),
  request_sha256: z.string(),
  mint: z.string(),
  host: z.string(),
  content_type: z.enum(IMAGE_TYPES),
  image_size: z.number().int(),
  image_sha256: z.string(),
  upload_key: z.string(),
  image_key: z.string(),
  metadata_key: z.string(),
  coin_name: z.string(),
  coin_symbol: z.string(),
  coin_description: z.string(),
  first_buy_lamports: z.string(),
  status: z.enum(['issued', 'completed', 'rejected', 'expired']),
  rejection: z.string().nullable(),
  metadata_sha256: z.string().nullable(),
  issued_at: z.string(),
  expires_at: z.string(),
  completed_at: z.string().nullable(),
  swept_at: z.string().nullable(),
});

function toDate(value: string, operation: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new UploadStoreError(operation, 'bad_date');
  return date;
}

export function parseTicketRow(row: unknown, operation = 'parse ticket'): TicketRecord {
  const parsed = TicketRow.safeParse(row);
  if (!parsed.success) throw new UploadStoreError(operation, 'bad_row');
  const r = parsed.data;
  return {
    id: r.id,
    launchpadId: r.launchpad_id,
    wallet: r.wallet,
    nonce: r.nonce,
    requestSha256: r.request_sha256,
    mint: r.mint,
    host: r.host,
    contentType: r.content_type,
    imageSize: r.image_size,
    imageSha256: r.image_sha256,
    uploadKey: r.upload_key,
    imageKey: r.image_key,
    metadataKey: r.metadata_key,
    coinName: r.coin_name,
    coinSymbol: r.coin_symbol,
    coinDescription: r.coin_description,
    firstBuyLamports: r.first_buy_lamports,
    status: r.status,
    rejection: r.rejection,
    metadataSha256: r.metadata_sha256,
    issuedAt: toDate(r.issued_at, operation),
    expiresAt: toDate(r.expires_at, operation),
    completedAt: r.completed_at === null ? null : toDate(r.completed_at, operation),
    sweptAt: r.swept_at === null ? null : toDate(r.swept_at, operation),
  };
}

export function ticketToRow(t: TicketRecord): Record<string, unknown> {
  return {
    id: t.id,
    launchpad_id: t.launchpadId,
    wallet: t.wallet,
    nonce: t.nonce,
    request_sha256: t.requestSha256,
    mint: t.mint,
    host: t.host,
    content_type: t.contentType,
    image_size: t.imageSize,
    image_sha256: t.imageSha256,
    upload_key: t.uploadKey,
    image_key: t.imageKey,
    metadata_key: t.metadataKey,
    coin_name: t.coinName,
    coin_symbol: t.coinSymbol,
    coin_description: t.coinDescription,
    first_buy_lamports: t.firstBuyLamports,
    status: t.status,
    rejection: t.rejection,
    metadata_sha256: t.metadataSha256,
    issued_at: t.issuedAt.toISOString(),
    expires_at: t.expiresAt.toISOString(),
    completed_at: t.completedAt === null ? null : t.completedAt.toISOString(),
    swept_at: t.sweptAt === null ? null : t.sweptAt.toISOString(),
  };
}

/** Which unique constraint a 23505 came from (named in migration 0006). */
export function conflictOf(error: DbError): 'nonce' | 'mint' | 'other' {
  const message = error.message ?? '';
  if (message.includes('upload_tickets_wallet_nonce_key')) return 'nonce';
  if (message.includes('upload_tickets_mint_key')) return 'mint';
  return 'other';
}

export class SupabaseUploadStore implements UploadStore {
  constructor(private readonly db: SupabaseClient) {}

  async findLaunchpad(ref: { id: string } | { slug: string }): Promise<LaunchpadRef | null> {
    const query = this.db
      .from('launchpads')
      .select('id, slug, status, launchpad_coin_mint, site_host');
    const res = await ('id' in ref ? query.eq('id', ref.id) : query.eq('slug', ref.slug))
      .limit(1)
      .maybeSingle();
    if (res.error) fail('read launchpad', res.error);
    if (!res.data) return null;
    const parsed = LaunchpadRow.safeParse(res.data);
    if (!parsed.success) throw new UploadStoreError('read launchpad', 'bad_row');
    return {
      id: parsed.data.id,
      slug: parsed.data.slug,
      status: parsed.data.status,
      coinMint: parsed.data.launchpad_coin_mint,
      siteHost: isSiteHost(parsed.data.site_host) ? parsed.data.site_host : null,
    };
  }

  async findTicketById(id: string): Promise<TicketRecord | null> {
    const res = await this.db.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (res.error) fail('read ticket', res.error);
    return res.data ? parseTicketRow(res.data, 'read ticket') : null;
  }

  async findTicketByNonce(wallet: string, nonce: string): Promise<TicketRecord | null> {
    const res = await this.db
      .from(TABLE)
      .select('*')
      .eq('wallet', wallet)
      .eq('nonce', nonce)
      .maybeSingle();
    if (res.error) fail('read ticket by nonce', res.error);
    return res.data ? parseTicketRow(res.data, 'read ticket by nonce') : null;
  }

  async isMintTaken(mint: string): Promise<boolean> {
    const tickets = await this.db.from(TABLE).select('id').eq('mint', mint).limit(1);
    if (tickets.error) fail('read mint', tickets.error);
    if ((tickets.data ?? []).length > 0) return true;
    const launchpads = await this.db
      .from('launchpads')
      .select('id')
      .eq('launchpad_coin_mint', mint)
      .limit(1);
    if (launchpads.error) fail('read launchpad mint', launchpads.error);
    return (launchpads.data ?? []).length > 0;
  }

  async recentIssues(
    filter: { wallet: string } | { launchpadId: string },
    since: Date,
    limit: number,
  ): Promise<Date[]> {
    const query = this.db.from(TABLE).select('issued_at');
    const res = await (
      'wallet' in filter
        ? query.eq('wallet', filter.wallet)
        : query.eq('launchpad_id', filter.launchpadId)
    )
      .gte('issued_at', since.toISOString())
      .order('issued_at', { ascending: true })
      .limit(limit);
    if (res.error) fail('read recent tickets', res.error);
    return (res.data ?? []).map((row) => {
      const value = (row as { issued_at?: unknown }).issued_at;
      if (typeof value !== 'string') throw new UploadStoreError('read recent tickets', 'bad_row');
      return toDate(value, 'read recent tickets');
    });
  }

  async insertTicket(ticket: TicketRecord): Promise<InsertResult> {
    const res = await this.db.from(TABLE).insert(ticketToRow(ticket));
    if (!res.error) return { ok: true };
    if (res.error.code === UNIQUE_VIOLATION) return { ok: false, conflict: conflictOf(res.error) };
    fail('insert ticket', res.error);
  }

  async markCompleted(id: string, metadataSha256: string, at: Date): Promise<TicketRecord | null> {
    const res = await this.db
      .from(TABLE)
      .update({
        status: 'completed',
        metadata_sha256: metadataSha256,
        completed_at: at.toISOString(),
      })
      .eq('id', id)
      .eq('status', 'issued')
      .select('*');
    if (res.error) fail('complete ticket', res.error);
    const row = res.data?.[0];
    return row ? parseTicketRow(row, 'complete ticket') : this.findTicketById(id);
  }

  async markRejected(id: string, rejection: string): Promise<TicketRecord | null> {
    const res = await this.db
      .from(TABLE)
      .update({ status: 'rejected', rejection })
      .eq('id', id)
      .eq('status', 'issued')
      .select('*');
    if (res.error) fail('reject ticket', res.error);
    const row = res.data?.[0];
    return row ? parseTicketRow(row, 'reject ticket') : this.findTicketById(id);
  }

  async markExpired(id: string): Promise<TicketRecord | null> {
    const res = await this.db
      .from(TABLE)
      .update({ status: 'expired' })
      .eq('id', id)
      .eq('status', 'issued')
      .select('*');
    if (res.error) fail('expire ticket', res.error);
    const row = res.data?.[0];
    return row ? parseTicketRow(row, 'expire ticket') : this.findTicketById(id);
  }

  async listSweepable(query: SweepQuery): Promise<TicketRecord[]> {
    // Two indexed range reads (partial index on unswept tickets), merged oldest first.
    const stale = await this.db
      .from(TABLE)
      .select('*')
      .is('swept_at', null)
      .eq('status', 'issued')
      .lt('issued_at', query.issuedBefore.toISOString())
      .order('issued_at', { ascending: true })
      .limit(query.limit);
    if (stale.error) fail('list stale tickets', stale.error);
    const finished = await this.db
      .from(TABLE)
      .select('*')
      .is('swept_at', null)
      .neq('status', 'issued')
      .lt('expires_at', query.urlExpiredBefore.toISOString())
      .order('issued_at', { ascending: true })
      .limit(query.limit);
    if (finished.error) fail('list finished tickets', finished.error);
    return [...(stale.data ?? []), ...(finished.data ?? [])]
      .map((row) => parseTicketRow(row, 'list sweepable tickets'))
      .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
      .slice(0, query.limit);
  }

  async markSwept(id: string, at: Date): Promise<void> {
    const res = await this.db.from(TABLE).update({ swept_at: at.toISOString() }).eq('id', id);
    if (res.error) fail('mark ticket swept', res.error);
  }
}

export function createServiceUploadStore(url: string, serviceRoleKey: string): SupabaseUploadStore {
  return new SupabaseUploadStore(
    createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
