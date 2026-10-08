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
 * Spec snapshots and token usage are stored as `system` rows of `chat_messages` with a
 * `forge:` prefix (the schema has no dedicated columns). They are never sent to the model.
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
  /** Last stored spec snapshot, or null if none. */
  draft: LaunchpadSpecDraft | null;
  /** Model spend of the conversation so far. */
  costUsd: number;
  userMessageCount: number;
  /** Most recent user/assistant messages, oldest first. */
  history: HistoryMessage[];
}

export interface NewMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ConfirmOutcome =
  | { status: 'created' | 'existing'; launchpadId: string; jobId: string }
  | { status: 'conversation_not_found' }
  | { status: 'slug_taken' }
  | { status: 'conflict' };

export interface ChatStore {
  ensureUser(wallet: string): Promise<void>;
  createConversation(wallet: string, launchpadId: string | null): Promise<string>;
  getConversation(id: string, wallet: string): Promise<ConversationRecord | null>;
  /** Spec of a launchpad owned by `wallet`, or null. */
  getLaunchpadSpec(launchpadId: string, wallet: string): Promise<LaunchpadSpecDraft | null>;
  loadState(conversationId: string, wallet: string): Promise<ConversationState>;
  appendMessages(conversationId: string, rows: NewMessage[]): Promise<void>;
  getFlag(key: 'signups_paused'): Promise<boolean>;
  /** Creates the launchpad (draft) and its `create_launchpad` job, idempotently. */
  confirmSpec(input: {
    wallet: string;
    conversationId: string;
    spec: LaunchpadSpec;
  }): Promise<ConfirmOutcome>;
}

export const SPEC_ROW_PREFIX = 'forge:spec:';
export const USAGE_ROW_PREFIX = 'forge:usage:';
const HISTORY_ROWS = 60;

const UsageRow = z.object({ costUsd: z.number().nonnegative() });
const DraftRow = z.record(z.string(), z.unknown());

export function specRow(draft: LaunchpadSpecDraft): NewMessage {
  return { role: 'system', content: SPEC_ROW_PREFIX + JSON.stringify(draft) };
}

export function usageRow(usage: UsageRecord): NewMessage {
  return { role: 'system', content: USAGE_ROW_PREFIX + JSON.stringify(usage) };
}

const IdRow = z.object({ id: z.string() });
const ConversationRow = z.object({ id: z.string(), launchpad_id: z.string().nullable() });
const MessageRow = z.object({ role: z.string(), content: z.string() });
const LaunchpadRow = z.object({ id: z.string(), spec: z.unknown() });

function fail(what: string, error: { message?: string; code?: string } | null): never {
  // Only the operation and the PostgREST code are kept: messages may echo row data.
  throw new StoreError(`${what} failed${error?.code ? ` (${error.code})` : ''}`);
}

export class SupabaseChatStore implements ChatStore {
  constructor(private readonly sb: SupabaseClient) {}

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
    const parsed = DraftRow.safeParse(LaunchpadRow.parse(data).spec);
    return parsed.success ? (parsed.data as LaunchpadSpecDraft) : null;
  }

  async loadState(conversationId: string, wallet: string): Promise<ConversationState> {
    const scoped = (columns: string, opts?: { count: 'exact'; head: true }) => {
      const select = `${columns}, conversations!inner(owner_wallet)`;
      const base = opts
        ? this.sb.from('chat_messages').select(select, opts)
        : this.sb.from('chat_messages').select(select);
      return base.eq('conversation_id', conversationId).eq('conversations.owner_wallet', wallet);
    };

    const [history, system, count] = await Promise.all([
      scoped('role, content')
        .in('role', ['user', 'assistant'])
        .order('id', { ascending: false })
        .limit(HISTORY_ROWS),
      scoped('role, content').eq('role', 'system').order('id', { ascending: true }),
      scoped('id', { count: 'exact', head: true }).eq('role', 'user'),
    ]);
    if (history.error) fail('history select', history.error);
    if (system.error) fail('state select', system.error);
    if (count.error) fail('message count', count.error);

    const messages: HistoryMessage[] = [];
    for (const raw of (history.data ?? []).slice().reverse()) {
      const row = MessageRow.parse(raw);
      if (row.role === 'user' || row.role === 'assistant') {
        messages.push({ role: row.role, content: row.content });
      }
    }

    let draft: LaunchpadSpecDraft | null = null;
    let costUsd = 0;
    for (const raw of system.data ?? []) {
      const { content } = MessageRow.parse(raw);
      try {
        if (content.startsWith(SPEC_ROW_PREFIX)) {
          const parsed = DraftRow.safeParse(JSON.parse(content.slice(SPEC_ROW_PREFIX.length)));
          if (parsed.success) draft = parsed.data as LaunchpadSpecDraft;
        } else if (content.startsWith(USAGE_ROW_PREFIX)) {
          const parsed = UsageRow.safeParse(JSON.parse(content.slice(USAGE_ROW_PREFIX.length)));
          if (parsed.success) costUsd += parsed.data.costUsd;
        }
      } catch {
        // A malformed bookkeeping row is ignored.
      }
    }

    return { draft, costUsd, userMessageCount: count.count ?? 0, history: messages };
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
      // Already confirmed (or a modification conversation): idempotent only for the same spec.
      const existing = await this.getLaunchpadSpec(conversation.launchpadId, wallet);
      if (!existing || draftKey(existing) !== draftKey(spec as LaunchpadSpecDraft)) {
        return { status: 'conflict' };
      }
      const jobId = await this.ensureCreateJob(conversation.launchpadId);
      return { status: 'existing', launchpadId: conversation.launchpadId, jobId };
    }

    await this.ensureUser(wallet);
    const launchpadId = crypto.randomUUID();
    const insert = await this.sb
      .from('launchpads')
      .insert({ id: launchpadId, owner_wallet: wallet, slug: spec.slug, spec, status: 'draft' });
    if (insert.error) {
      if (insert.error.code === '23505') return { status: 'slug_taken' };
      fail('launchpad insert', insert.error);
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
      return { status: 'conflict' };
    }

    const jobId = await this.ensureCreateJob(launchpadId);
    return { status: 'created', launchpadId, jobId };
  }

  private async ensureCreateJob(launchpadId: string): Promise<string> {
    const found = await this.sb
      .from('jobs')
      .select('id')
      .eq('launchpad_id', launchpadId)
      .eq('type', 'create_launchpad')
      .order('created_at', { ascending: true })
      .limit(1);
    if (found.error) fail('job select', found.error);
    const first = found.data?.[0];
    if (first) return IdRow.parse(first).id;

    const created = await this.sb
      .from('jobs')
      .insert({ launchpad_id: launchpadId, type: 'create_launchpad', status: 'spec_ready' })
      .select('id')
      .single();
    if (created.error) fail('job insert', created.error);
    return IdRow.parse(created.data).id;
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
