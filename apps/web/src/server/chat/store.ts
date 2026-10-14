import type { LaunchpadSpec, LaunchpadSpecDraft } from '@forge/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { draftKey } from './spec-draft';

/*
 * Persistence of conversations. Every query runs with the service role key, so tenant
 * isolation is enforced here: each statement carries an explicit `owner_wallet = <session
 * wallet>` filter (directly, or through an inner join on `conversations`). Clients can only
 * read their own rows through RLS (supabase/migrations/0002_rls.sql); all writes are server-side.
 *
 * The current draft and the accumulated model cost of a conversation live in
 * `conversations.spec` and `conversations.cost_usd` (supabase/migrations/0005_wave3.sql).
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface ConversationRecord {
  id: string;
  launchpadId: string | null;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationState {
  /** Stored draft of the conversation, or null if none. */
  draft: LaunchpadSpecDraft | null;
  /** Model spend of the conversation so far. */
  costUsd: number;
  userMessageCount: number;
  /** Most recent user/assistant messages, oldest first. */
  history: HistoryMessage[];
}

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ConfirmOutcome =
  | { status: 'created' | 'existing'; launchpadId: string; jobId: string }
  | { status: 'conversation_not_found' }
  | { status: 'slug_taken' }
  | { status: 'too_many_drafts' }
  | { status: 'draft_released' }
  | { status: 'conflict' };

export interface ChatStore {
  ensureUser(wallet: string): Promise<void>;
  createConversation(wallet: string, launchpadId: string | null): Promise<string>;
  getConversation(id: string, wallet: string): Promise<ConversationRecord | null>;
  /** Spec of a launchpad owned by `wallet`, or null. */
  getLaunchpadSpec(launchpadId: string, wallet: string): Promise<LaunchpadSpecDraft | null>;
  loadState(conversationId: string, wallet: string): Promise<ConversationState>;
  appendMessages(conversationId: string, rows: NewMessage[]): Promise<void>;
  /** Stores the current draft of a conversation owned by `wallet`. */
  saveDraft(conversationId: string, wallet: string, draft: LaunchpadSpecDraft): Promise<void>;
  /** Adds `deltaUsd` to the conversation cost atomically; returns the new total. */
  addCost(conversationId: string, wallet: string, deltaUsd: number): Promise<number>;
  /**
   * Model spend of `wallet` over the window: the total cost of every conversation of the wallet
   * that received a message since `since` (conservative: earlier spend of those conversations is
   * counted too).
   */
  walletSpendSince(wallet: string, since: Date): Promise<number>;
  getFlag(key: 'signups_paused'): Promise<boolean>;
  /** Creates the launchpad (draft) and its `create_launchpad` job, idempotently. */
  confirmSpec(input: {
    wallet: string;
    conversationId: string;
    spec: LaunchpadSpec;
  }): Promise<ConfirmOutcome>;
}

/**
 * Slug reservation policy (anti-squatting):
 * - a wallet holds at most `maxUnpaidDrafts` unpaid drafts younger than `reservationMs`;
 * - an unpaid draft older than `reservationMs` keeps its slug only until somebody else confirms
 *   a launchpad with that slug. It is then released: renamed to `released-<id>` and disabled, so
 *   it can no longer be quoted or paid (payments/service.ts). It is never deleted (its job and
 *   conversation keep referencing it).
 * "Unpaid" = every job of the launchpad is still `spec_ready` and no payment is confirmed or
 * carries a signature. A quote that is open, or expired less than `quoteGraceMs` ago, also keeps
 * the slug (the client may still be confirming a payment it sent in time).
 * A draft whose creation was paid then refunded is therefore "paid" here: it keeps its slug and
 * does not count as an unpaid draft, so its owner can start it again with the same name
 * (POST /api/launchpads/:id/retry, launchpads/retry.ts), which reserves no new slug.
 */
export const DRAFT_POLICY = {
  maxUnpaidDrafts: 3,
  reservationMs: 24 * 60 * 60_000,
  quoteGraceMs: 60 * 60_000,
} as const;

/** While a concurrent confirmation of the same conversation finishes its claim. */
const CLAIM_POLL = { attempts: 5, delayMs: 100 } as const;
const CAS_ATTEMPTS = 8;
const HISTORY_ROWS = 60;
const SPEND_ROWS = 1000;
const UNIQUE_VIOLATION = '23505';

const DraftRow = z.record(z.string(), z.unknown());
const DbNumeric = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(e-?\d+)?$/i)]);

const IdRow = z.object({ id: z.string() });
const ConversationRow = z.object({ id: z.string(), launchpad_id: z.string().nullable() });
const StateRow = z.object({ spec: z.unknown().nullable(), cost_usd: DbNumeric });
const CostRow = z.object({ cost_usd: DbNumeric });
const MessageRow = z.object({ role: z.string(), content: z.string() });
const LaunchpadRow = z.object({ id: z.string(), spec: z.unknown() });
const LaunchpadStatusRow = z.object({
  id: z.string(),
  spec: z.unknown(),
  status: z.string(),
});
const HolderRow = z.object({ id: z.string(), status: z.string(), created_at: z.string() });
const JobRow = z.object({ id: z.string(), launchpad_id: z.string(), status: z.string() });
const PaymentRow = z.object({
  job_id: z.string(),
  status: z.string(),
  tx_signature: z.string().nullable(),
  quote_expires_at: z.string(),
});

function fail(what: string, error: { message?: string; code?: string } | null): never {
  // Only the operation and the PostgREST code are kept: messages may echo row data.
  throw new StoreError(`${what} failed${error?.code ? ` (${error.code})` : ''}`);
}

function parseDraft(value: unknown): LaunchpadSpecDraft | null {
  const parsed = DraftRow.safeParse(value);
  return parsed.success ? (parsed.data as LaunchpadSpecDraft) : null;
}

/** USD amounts are kept in integer micro-dollars (numeric(12, 6) in the database). */
const MICROS = 1_000_000;

function toMicros(value: number | string): number {
  return Math.round(Number(value) * MICROS);
}

export interface SupabaseChatStoreOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface DraftState {
  paid: boolean;
  openQuote: boolean;
}

export class SupabaseChatStore implements ChatStore {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly sb: SupabaseClient,
    options: SupabaseChatStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ensureUser(wallet: string): Promise<void> {
    const { error } = await this.sb
      .from('users')
      .upsert({ wallet }, { onConflict: 'wallet', ignoreDuplicates: true });
    if (error) fail('users upsert', error);
  }

  async createConversation(wallet: string, launchpadId: string | null): Promise<string> {
    await this.ensureUser(wallet);
    const { data, error } = await this.sb
      .from('conversations')
      .insert({ owner_wallet: wallet, launchpad_id: launchpadId })
      .select('id')
      .single();
    if (error) fail('conversation insert', error);
    return IdRow.parse(data).id;
  }

  async getConversation(id: string, wallet: string): Promise<ConversationRecord | null> {
    const { data, error } = await this.sb
      .from('conversations')
      .select('id, launchpad_id')
      .eq('id', id)
      .eq('owner_wallet', wallet)
      .maybeSingle();
    if (error) fail('conversation select', error);
    if (!data) return null;
    const row = ConversationRow.parse(data);
    return { id: row.id, launchpadId: row.launchpad_id };
  }

  async getLaunchpadSpec(launchpadId: string, wallet: string): Promise<LaunchpadSpecDraft | null> {
    const { data, error } = await this.sb
      .from('launchpads')
      .select('id, spec')
      .eq('id', launchpadId)
      .eq('owner_wallet', wallet)
      .maybeSingle();
    if (error) fail('launchpad select', error);
    if (!data) return null;
    return parseDraft(LaunchpadRow.parse(data).spec);
  }

  async loadState(conversationId: string, wallet: string): Promise<ConversationState> {
    const messages = (columns: string, opts?: { count: 'exact'; head: true }) => {
      const select = `${columns}, conversations!inner(owner_wallet)`;
      const base = opts
        ? this.sb.from('chat_messages').select(select, opts)
        : this.sb.from('chat_messages').select(select);
      return base.eq('conversation_id', conversationId).eq('conversations.owner_wallet', wallet);
    };

    const [conversation, history, count] = await Promise.all([
      this.sb
        .from('conversations')
        .select('spec, cost_usd')
        .eq('id', conversationId)
        .eq('owner_wallet', wallet)
        .maybeSingle(),
      messages('role, content')
        .in('role', ['user', 'assistant'])
        .order('id', { ascending: false })
        .limit(HISTORY_ROWS),
      messages('id', { count: 'exact', head: true }).eq('role', 'user'),
    ]);
    if (conversation.error) fail('state select', conversation.error);
    if (history.error) fail('history select', history.error);
    if (count.error) fail('message count', count.error);

    const rows: HistoryMessage[] = [];
    for (const raw of (history.data ?? []).slice().reverse()) {
      const row = MessageRow.parse(raw);
      if (row.role === 'user' || row.role === 'assistant') {
        rows.push({ role: row.role, content: row.content });
      }
    }

    const state = conversation.data ? StateRow.parse(conversation.data) : null;
    return {
      draft: state ? parseDraft(state.spec) : null,
      costUsd: state ? toMicros(state.cost_usd) / MICROS : 0,
      userMessageCount: count.count ?? 0,
      history: rows,
    };
  }

  async appendMessages(conversationId: string, rows: NewMessage[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.sb
      .from('chat_messages')
      .insert(
        rows.map((r) => ({ conversation_id: conversationId, role: r.role, content: r.content })),
      );
    if (error) fail('messages insert', error);
  }

  async saveDraft(
    conversationId: string,
    wallet: string,
    draft: LaunchpadSpecDraft,
  ): Promise<void> {
    const { error } = await this.sb
      .from('conversations')
      .update({ spec: draft })
      .eq('id', conversationId)
      .eq('owner_wallet', wallet);
    if (error) fail('draft update', error);
  }

  /**
   * Compare-and-set on `cost_usd` (PostgREST cannot express `cost_usd = cost_usd + x`): a
   * concurrent writer makes the update match no row, and the increment is retried on the fresh
   * value. The delta is rounded UP to the micro-dollar, so spend is never under-counted.
   */
  async addCost(conversationId: string, wallet: string, deltaUsd: number): Promise<number> {
    const delta = Math.ceil(deltaUsd * MICROS - 1e-6);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const read = await this.sb
        .from('conversations')
        .select('cost_usd')
        .eq('id', conversationId)
        .eq('owner_wallet', wallet)
        .maybeSingle();
      if (read.error) fail('cost select', read.error);
      if (!read.data) throw new StoreError('cost select failed (no conversation)');
      const current = CostRow.parse(read.data).cost_usd;
      const next = toMicros(current) + Math.max(0, delta);
      if (next === toMicros(current)) return next / MICROS;
      const write = await this.sb
        .from('conversations')
        .update({ cost_usd: (next / MICROS).toFixed(6) })
        .eq('id', conversationId)
        .eq('owner_wallet', wallet)
        .eq('cost_usd', current)
        .select('id');
      if (write.error) fail('cost update', write.error);
      if ((write.data ?? []).length === 1) return next / MICROS;
    }
    throw new StoreError('cost update failed (contention)');
  }

  async walletSpendSince(wallet: string, since: Date): Promise<number> {
    const { data, error } = await this.sb
      .from('conversations')
      .select('id, cost_usd, chat_messages!inner(id)')
      .eq('owner_wallet', wallet)
      .gte('chat_messages.created_at', since.toISOString())
      .limit(1, { referencedTable: 'chat_messages' })
      .limit(SPEND_ROWS);
    if (error) fail('spend select', error);
    const rows = data ?? [];
    // More active conversations than we read: treat the cap as reached (fail closed).
    if (rows.length >= SPEND_ROWS) return Number.POSITIVE_INFINITY;
    let micros = 0;
    for (const raw of rows) micros += toMicros(CostRow.parse(raw).cost_usd);
    return micros / MICROS;
  }

  async getFlag(key: 'signups_paused'): Promise<boolean> {
    const { data, error } = await this.sb
      .from('flags')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) fail('flag select', error);
    return (data as { value?: unknown } | null)?.value === true;
  }

  async confirmSpec(input: {
    wallet: string;
    conversationId: string;
    spec: LaunchpadSpec;
  }): Promise<ConfirmOutcome> {
    const { wallet, conversationId, spec } = input;
    const conversation = await this.getConversation(conversationId, wallet);
    if (!conversation) return { status: 'conversation_not_found' };
    if (conversation.launchpadId !== null) {
      return this.confirmExisting(conversation.launchpadId, wallet, spec);
    }

    await this.ensureUser(wallet);
    if ((await this.countReservedDrafts(wallet)) >= DRAFT_POLICY.maxUnpaidDrafts) {
      return { status: 'too_many_drafts' };
    }

    const launchpadId = crypto.randomUUID();
    let inserted = await this.insertLaunchpad(launchpadId, wallet, spec);
    if (!inserted) {
      // A double confirmation of this same conversation holds the slug: answer like it.
      const attached = await this.waitForClaim(conversationId, wallet);
      if (attached !== null) return this.confirmExisting(attached, wallet, spec);
      if (!(await this.releaseExpiredSlug(spec.slug))) return { status: 'slug_taken' };
      inserted = await this.insertLaunchpad(launchpadId, wallet, spec);
      if (!inserted) return { status: 'slug_taken' };
    }

    // Claim the conversation atomically: only one confirmation can attach a launchpad.
    const claim = await this.sb
      .from('conversations')
      .update({ launchpad_id: launchpadId })
      .eq('id', conversationId)
      .eq('owner_wallet', wallet)
      .is('launchpad_id', null)
      .select('id');
    if (claim.error || (claim.data ?? []).length === 0) {
      await this.sb.from('launchpads').delete().eq('id', launchpadId).eq('owner_wallet', wallet);
      if (claim.error) fail('conversation update', claim.error);
      const winner = await this.getConversation(conversationId, wallet);
      if (winner?.launchpadId) return this.confirmExisting(winner.launchpadId, wallet, spec);
      return { status: 'conflict' };
    }

    const jobId = await this.ensureCreateJob(launchpadId);
    return { status: 'created', launchpadId, jobId };
  }

  /** Already confirmed (or a modification conversation): idempotent only for the same spec. */
  private async confirmExisting(
    launchpadId: string,
    wallet: string,
    spec: LaunchpadSpec,
  ): Promise<ConfirmOutcome> {
    const { data, error } = await this.sb
      .from('launchpads')
      .select('id, spec, status')
      .eq('id', launchpadId)
      .eq('owner_wallet', wallet)
      .maybeSingle();
    if (error) fail('launchpad select', error);
    if (!data) return { status: 'conflict' };
    const row = LaunchpadStatusRow.parse(data);
    const existing = parseDraft(row.spec);
    if (!existing || draftKey(existing) !== draftKey(spec as LaunchpadSpecDraft)) {
      return { status: 'conflict' };
    }
    if (row.status === 'disabled') return { status: 'draft_released' };
    const jobId = await this.ensureCreateJob(launchpadId);
    return { status: 'existing', launchpadId, jobId };
  }

  /** false on a slug conflict (unique violation). */
  private async insertLaunchpad(id: string, wallet: string, spec: LaunchpadSpec): Promise<boolean> {
    const { error } = await this.sb
      .from('launchpads')
      .insert({ id, owner_wallet: wallet, slug: spec.slug, spec, status: 'draft' });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    fail('launchpad insert', error);
  }

  private async waitForClaim(conversationId: string, wallet: string): Promise<string | null> {
    for (let attempt = 0; attempt < CLAIM_POLL.attempts; attempt++) {
      const conversation = await this.getConversation(conversationId, wallet);
      if (conversation?.launchpadId) return conversation.launchpadId;
      if (attempt < CLAIM_POLL.attempts - 1) await this.sleep(CLAIM_POLL.delayMs);
    }
    return null;
  }

  /** Paid / open-quote state of each launchpad (jobs and payments read in two queries). */
  private async draftStates(launchpadIds: string[]): Promise<Map<string, DraftState>> {
    const states = new Map<string, DraftState>();
    for (const id of launchpadIds) states.set(id, { paid: false, openQuote: false });
    if (launchpadIds.length === 0) return states;

    const jobs = await this.sb
      .from('jobs')
      .select('id, launchpad_id, status')
      .in('launchpad_id', launchpadIds);
    if (jobs.error) fail('jobs select', jobs.error);
    const launchpadOfJob = new Map<string, string>();
    for (const raw of jobs.data ?? []) {
      const job = JobRow.parse(raw);
      launchpadOfJob.set(job.id, job.launchpad_id);
      const state = states.get(job.launchpad_id);
      if (state && job.status !== 'spec_ready') state.paid = true;
    }
    if (launchpadOfJob.size === 0) return states;

    const payments = await this.sb
      .from('payments')
      .select('job_id, status, tx_signature, quote_expires_at')
      .in('job_id', [...launchpadOfJob.keys()]);
    if (payments.error) fail('payments select', payments.error);
    const graceStart = this.now() - DRAFT_POLICY.quoteGraceMs;
    for (const raw of payments.data ?? []) {
      const payment = PaymentRow.parse(raw);
      const state = states.get(launchpadOfJob.get(payment.job_id) ?? '');
      if (!state) continue;
      if (payment.status === 'confirmed' || payment.tx_signature !== null) state.paid = true;
      if (payment.status === 'quoted' && Date.parse(payment.quote_expires_at) > graceStart) {
        state.openQuote = true;
      }
    }
    return states;
  }

  /** Unpaid drafts of `wallet` still inside their reservation window. */
  private async countReservedDrafts(wallet: string): Promise<number> {
    const since = new Date(this.now() - DRAFT_POLICY.reservationMs).toISOString();
    const { data, error } = await this.sb
      .from('launchpads')
      .select('id')
      .eq('owner_wallet', wallet)
      .eq('status', 'draft')
      .gte('created_at', since);
    if (error) fail('drafts select', error);
    const ids = (data ?? []).map((raw) => IdRow.parse(raw).id);
    const states = await this.draftStates(ids);
    let unpaid = 0;
    for (const state of states.values()) if (!state.paid) unpaid++;
    return unpaid;
  }

  /**
   * Frees `slug` when it is held by an expired unpaid draft (DRAFT_POLICY). Write first, then
   * re-check the payments: a quote created concurrently writes its row before re-reading the
   * launchpad (payments/service.ts), so one side always sees the other. Seeing a fresh quote here
   * puts the draft back.
   */
  private async releaseExpiredSlug(slug: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from('launchpads')
      .select('id, status, created_at')
      .eq('slug', slug)
      .maybeSingle();
    if (error) fail('slug select', error);
    if (!data) return true; // Freed meanwhile: the caller simply retries the insert.
    const holder = HolderRow.parse(data);
    const expired = Date.parse(holder.created_at) <= this.now() - DRAFT_POLICY.reservationMs;
    if (holder.status !== 'draft' || !expired) return false;
    const before = (await this.draftStates([holder.id])).get(holder.id);
    if (!before || before.paid || before.openQuote) return false;

    const releasedSlug = `released-${holder.id}`;
    const release = await this.sb
      .from('launchpads')
      .update({ slug: releasedSlug, status: 'disabled' })
      .eq('id', holder.id)
      .eq('status', 'draft')
      .eq('slug', slug)
      .select('id');
    if (release.error) fail('slug release', release.error);
    if ((release.data ?? []).length === 0) return false;

    const after = (await this.draftStates([holder.id])).get(holder.id);
    if (after && !after.paid && !after.openQuote) {
      console.info(`[spec] released the slug of expired draft ${holder.id}`);
      return true;
    }
    const revert = await this.sb
      .from('launchpads')
      .update({ slug, status: 'draft' })
      .eq('id', holder.id)
      .eq('slug', releasedSlug)
      .select('id');
    if (revert.error || (revert.data ?? []).length === 0) {
      console.error(`[spec] could not restore draft ${holder.id} after a racing quote`);
    }
    return false;
  }

  /**
   * The launchpad's creation job, created when it has none. At most one creation job that is not
   * refunded per launchpad, guaranteed by the unique partial index
   * `jobs_one_open_create_per_launchpad_idx` (migration 0010): a concurrent insert fails with
   * 23505 and the winner's row is read back. A refunded creation is only ever started again by
   * POST /api/launchpads/:id/retry, never here.
   */
  private async ensureCreateJob(launchpadId: string): Promise<string> {
    const existing = await this.findCreateJob(launchpadId);
    if (existing) return existing;
    const created = await this.sb
      .from('jobs')
      .insert({ launchpad_id: launchpadId, type: 'create_launchpad', status: 'spec_ready' })
      .select('id')
      .single();
    if (!created.error) return IdRow.parse(created.data).id;
    if (created.error.code !== UNIQUE_VIOLATION) fail('job insert', created.error);
    const winner = await this.findCreateJob(launchpadId);
    if (!winner) throw new StoreError('job insert failed (conflict without a row)');
    return winner;
  }

  /** The newest creation job: a launchpad started again also keeps its refunded attempts. */
  private async findCreateJob(launchpadId: string): Promise<string | null> {
    const found = await this.sb
      .from('jobs')
      .select('id')
      .eq('launchpad_id', launchpadId)
      .eq('type', 'create_launchpad')
      .order('created_at', { ascending: false })
      .limit(1);
    if (found.error) fail('job select', found.error);
    const first = found.data?.[0];
    return first ? IdRow.parse(first).id : null;
  }
}

let cached: ChatStore | null = null;

/** Store backed by the service role key (server only). */
export function getDefaultStore(): ChatStore {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new StoreError('Supabase is not configured');
  cached = new SupabaseChatStore(
    createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
  );
  return cached;
}
