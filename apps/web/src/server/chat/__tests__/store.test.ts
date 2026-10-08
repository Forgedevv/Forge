// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { StoreError, SupabaseChatStore } from '../store';
import { OTHER_WALLET, validSpec, WALLET } from './helpers';
import { LaunchpadSpec } from '@forge/shared';

interface Op {
  method: string;
  args: unknown[];
}
interface Call {
  table: string;
  ops: Op[];
}
type Result = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
  count?: number | null;
};

/** Records every query and answers with scripted results (matched in order of execution). */
function fakeSupabase(answer: (call: Call) => Result) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      const builder: Record<string, unknown> = {};
      const chain =
        (method: string) =>
        (...args: unknown[]) => {
          call.ops.push({ method, args });
          return builder;
        };
      for (const m of [
        'select',
        'insert',
        'update',
        'upsert',
        'delete',
        'eq',
        'is',
        'in',
        'order',
        'limit',
        'like',
      ]) {
        builder[m] = chain(m);
      }
      builder.single = chain('single');
      builder.maybeSingle = chain('maybeSingle');
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        calls.push(call);
        const r = answer(call);
        return Promise.resolve({ data: null, error: null, count: null, ...r }).then(
          resolve,
          reject,
        );
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const eqs = (call: Call) =>
  call.ops.filter((o) => o.method === 'eq').map((o) => `${String(o.args[0])}=${String(o.args[1])}`);

describe('SupabaseChatStore tenant isolation', () => {
  it('filters conversations by owner wallet', async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const store = new SupabaseChatStore(client);
    expect(await store.getConversation('c1', OTHER_WALLET)).toBeNull();
    expect(eqs(calls[0]!)).toEqual(['id=c1', `owner_wallet=${OTHER_WALLET}`]);
  });

  it('filters launchpads by owner wallet', async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    await new SupabaseChatStore(client).getLaunchpadSpec('lp', WALLET);
    expect(eqs(calls[0]!)).toContain(`owner_wallet=${WALLET}`);
  });

  it('scopes every message read through an inner join on the owner wallet', async () => {
    const { client, calls } = fakeSupabase((call) => {
      const roleFilter = call.ops.find(
        (o) => o.method === 'in' || (o.method === 'eq' && o.args[0] === 'role'),
      );
      if (call.ops.some((o) => o.method === 'select' && JSON.stringify(o.args).includes('head'))) {
        return { count: 3 };
      }
      if (roleFilter?.method === 'in') {
        return {
          data: [
            { role: 'assistant', content: 'second' },
            { role: 'user', content: 'first' },
          ],
        };
      }
      return {
        data: [
          { role: 'system', content: 'forge:spec:{"name":"A"}' },
          {
            role: 'system',
            content: 'forge:usage:{"inputTokens":1,"outputTokens":2,"costUsd":0.25}',
          },
          { role: 'system', content: 'forge:spec:{"name":"B"}' },
          { role: 'system', content: 'forge:usage:{"costUsd":0.5}' },
          { role: 'system', content: 'forge:usage:not json' },
        ],
      };
    });
    const state = await new SupabaseChatStore(client).loadState('c1', WALLET);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.table).toBe('chat_messages');
      expect(JSON.stringify(call.ops.find((o) => o.method === 'select'))).toContain(
        'conversations!inner(owner_wallet)',
      );
      expect(eqs(call)).toContain('conversation_id=c1');
      expect(eqs(call)).toContain(`conversations.owner_wallet=${WALLET}`);
    }
    expect(state).toEqual({
      draft: { name: 'B' },
      costUsd: 0.75,
      userMessageCount: 3,
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
    });
  });

  it('wraps database errors without leaking the message', async () => {
    const { client } = fakeSupabase(() => ({
      error: { code: '42P01', message: 'relation x secret' },
    }));
    const err = await new SupabaseChatStore(client)
      .getConversation('c', WALLET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as Error).message).toContain('42P01');
    expect((err as Error).message).not.toContain('secret');
  });

  it('creates the user row before the conversation', async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.table === 'conversations' ? { data: { id: 'new-id' } } : {},
    );
    const id = await new SupabaseChatStore(client).createConversation(WALLET, null);
    expect(id).toBe('new-id');
    expect(calls.map((c) => c.table)).toEqual(['users', 'conversations']);
    expect(calls[0]!.ops[0]).toEqual({
      method: 'upsert',
      args: [{ wallet: WALLET }, { onConflict: 'wallet', ignoreDuplicates: true }],
    });
    expect(calls[1]!.ops[0]).toEqual({
      method: 'insert',
      args: [{ owner_wallet: WALLET, launchpad_id: null }],
    });
  });
});

describe('SupabaseChatStore.confirmSpec', () => {
  const spec = LaunchpadSpec.parse(validSpec());

  it('creates the launchpad, claims the conversation, then creates the job', async () => {
    const { client, calls } = fakeSupabase((call) => {
      if (call.table === 'conversations' && call.ops.some((o) => o.method === 'maybeSingle')) {
        return { data: { id: 'c1', launchpad_id: null } };
      }
      if (call.table === 'conversations' && call.ops.some((o) => o.method === 'update')) {
        return { data: [{ id: 'c1' }] };
      }
      if (
        call.table === 'jobs' &&
        call.ops.some((o) => o.method === 'select' && !call.ops.some((p) => p.method === 'insert'))
      ) {
        return { data: [] };
      }
      if (call.table === 'jobs') return { data: { id: 'job-1' } };
      return {};
    });
    const out = await new SupabaseChatStore(client).confirmSpec({
      wallet: WALLET,
      conversationId: 'c1',
      spec,
    });
    expect(out).toMatchObject({ status: 'created', jobId: 'job-1' });
    const insert = calls.find((c) => c.table === 'launchpads')!;
    expect(insert.ops[0]).toMatchObject({
      method: 'insert',
      args: [{ owner_wallet: WALLET, slug: 'moonpad', status: 'draft', spec }],
    });
    const claim = calls.find(
      (c) => c.table === 'conversations' && c.ops.some((o) => o.method === 'update'),
    )!;
    expect(eqs(claim)).toEqual(['id=c1', `owner_wallet=${WALLET}`]);
    expect(claim.ops.some((o) => o.method === 'is' && o.args[0] === 'launchpad_id')).toBe(true);
    const job = calls.filter((c) => c.table === 'jobs').at(-1)!;
    expect(job.ops[0]).toMatchObject({
      method: 'insert',
      args: [{ type: 'create_launchpad', status: 'spec_ready' }],
    });
  });

  it("returns conversation_not_found for another wallet's conversation", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null }));
    const out = await new SupabaseChatStore(client).confirmSpec({
      wallet: OTHER_WALLET,
      conversationId: 'c1',
      spec,
    });
    expect(out).toEqual({ status: 'conversation_not_found' });
    expect(calls.map((c) => c.table)).toEqual(['conversations']);
  });

  it('reports a taken slug', async () => {
    const { client } = fakeSupabase((call) => {
      if (call.table === 'conversations') return { data: { id: 'c1', launchpad_id: null } };
      if (call.table === 'launchpads') return { error: { code: '23505' } };
      return {};
    });
    expect(
      await new SupabaseChatStore(client).confirmSpec({
        wallet: WALLET,
        conversationId: 'c1',
        spec,
      }),
    ).toEqual({
      status: 'slug_taken',
    });
  });

  it('rolls the launchpad back when another confirmation claimed the conversation first', async () => {
    const { client, calls } = fakeSupabase((call) => {
      if (call.table === 'conversations' && call.ops.some((o) => o.method === 'maybeSingle')) {
        return { data: { id: 'c1', launchpad_id: null } };
      }
      if (call.table === 'conversations') return { data: [] };
      return {};
    });
    const out = await new SupabaseChatStore(client).confirmSpec({
      wallet: WALLET,
      conversationId: 'c1',
      spec,
    });
    expect(out).toEqual({ status: 'conflict' });
    const del = calls.find((c) => c.ops[0]?.method === 'delete')!;
    expect(del.table).toBe('launchpads');
    expect(eqs(del)).toContain(`owner_wallet=${WALLET}`);
    expect(calls.some((c) => c.table === 'jobs')).toBe(false);
  });

  it('is idempotent: the same spec on an already confirmed conversation returns the same ids', async () => {
    const { client, calls } = fakeSupabase((call) => {
      if (call.table === 'conversations') return { data: { id: 'c1', launchpad_id: 'lp-1' } };
      if (call.table === 'launchpads') return { data: { id: 'lp-1', spec } };
      if (call.table === 'jobs') return { data: [{ id: 'job-1' }] };
      return {};
    });
    const out = await new SupabaseChatStore(client).confirmSpec({
      wallet: WALLET,
      conversationId: 'c1',
      spec,
    });
    expect(out).toEqual({ status: 'existing', launchpadId: 'lp-1', jobId: 'job-1' });
    expect(calls.some((c) => c.ops.some((o) => o.method === 'insert'))).toBe(false);
  });

  it('refuses a different spec on an already confirmed conversation', async () => {
    const { client } = fakeSupabase((call) => {
      if (call.table === 'conversations') return { data: { id: 'c1', launchpad_id: 'lp-1' } };
      if (call.table === 'launchpads')
        return { data: { id: 'lp-1', spec: { ...spec, tradingFeeBps: 50 } } };
      return {};
    });
    const out = await new SupabaseChatStore(client).confirmSpec({
      wallet: WALLET,
      conversationId: 'c1',
      spec,
    });
    expect(out).toEqual({ status: 'conflict' });
  });
});
