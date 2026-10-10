// @vitest-environment node
import { LaunchpadSpec } from '@forge/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_POLICY, StoreError, SupabaseChatStore } from '../store';
import { FakeDb, type Row } from './fake-db';
import { OTHER_WALLET, validSpec, WALLET } from './helpers';

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
        'gte',
        'order',
        'limit',
        'single',
        'maybeSingle',
      ]) {
        builder[m] = chain(m);
      }
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

  it('scopes the state, message and count reads to the owner wallet', async () => {
    const { client, calls } = fakeSupabase((call) => {
      if (call.table === 'conversations') {
        return { data: { spec: { name: 'B' }, cost_usd: '0.750000' } };
      }
      if (call.ops.some((o) => o.method === 'select' && JSON.stringify(o.args).includes('head'))) {
        return { count: 3 };
      }
      return {
        data: [
          { role: 'assistant', content: 'second' },
          { role: 'user', content: 'first' },
        ],
      };
    });
    const state = await new SupabaseChatStore(client).loadState('c1', WALLET);
    expect(calls).toHaveLength(3);
    const conversation = calls.find((c) => c.table === 'conversations')!;
    expect(eqs(conversation)).toEqual(['id=c1', `owner_wallet=${WALLET}`]);
    for (const call of calls.filter((c) => c.table === 'chat_messages')) {
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

  it('scopes draft and cost writes and the daily spend read to the owner wallet', async () => {
    const { client, calls } = fakeSupabase((call) => {
      if (call.ops.some((o) => o.method === 'update')) return { data: [{ id: 'c1' }] };
      if (call.ops.some((o) => o.method === 'maybeSingle')) return { data: { cost_usd: 0 } };
      return { data: [] };
    });
    const store = new SupabaseChatStore(client);
    await store.saveDraft('c1', WALLET, { name: 'X' });
    await store.addCost('c1', WALLET, 0.01);
    await store.walletSpendSince(WALLET, new Date(0));
    for (const call of calls) expect(eqs(call)).toContain(`owner_wallet=${WALLET}`);
    const spend = calls.at(-1)!;
    expect(JSON.stringify(spend.ops)).toContain('chat_messages!inner');
    expect(spend.ops).toContainEqual({
      method: 'gte',
      args: ['chat_messages.created_at', new Date(0).toISOString()],
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

// ---------------------------------------------------------------------------------------------
// Behaviour against an in-memory database with the real unique indexes
// ---------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-10-01T12:00:00Z');
const HOUR = 60 * 60_000;
const spec = LaunchpadSpec.parse(validSpec());
const otherSpec = LaunchpadSpec.parse(validSpec({ ownerWallet: OTHER_WALLET }));

function setup() {
  const db = new FakeDb();
  let now = T0;
  db.now = () => now;
  const store = new SupabaseChatStore(db.client(), {
    now: () => now,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  return {
    db,
    store,
    advance: (ms: number) => {
      now += ms;
    },
    conversation: async (wallet = WALLET) => store.createConversation(wallet, null),
  };
}

type Ctx = ReturnType<typeof setup>;

function createJobs(db: FakeDb, launchpadId?: string): Row[] {
  return db
    .rows('jobs')
    .filter(
      (j) => j.type === 'create_launchpad' && (!launchpadId || j.launchpad_id === launchpadId),
    );
}

/** An unpaid draft of `wallet` holding `slug`, created `ageMs` ago. */
function draft(ctx: Ctx, wallet: string, slug: string, ageMs: number): { lp: Row; job: Row } {
  const lp = ctx.db.insert('launchpads', {
    owner_wallet: wallet,
    slug,
    spec: { ...validSpec({ ownerWallet: wallet, slug }) },
    status: 'draft',
    created_at: new Date(T0 - ageMs).toISOString(),
  });
  const job = ctx.db.insert('jobs', {
    launchpad_id: lp.id,
    type: 'create_launchpad',
    status: 'spec_ready',
  });
  return { lp, job };
}

describe('SupabaseChatStore conversation state', () => {
  it('reads the draft and the cost from the conversation row', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    await ctx.store.saveDraft(id, WALLET, { name: 'MoonPad' });
    await ctx.store.addCost(id, WALLET, 0.0123);
    await ctx.store.appendMessages(id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(await ctx.store.loadState(id, WALLET)).toEqual({
      draft: { name: 'MoonPad' },
      costUsd: 0.0123,
      userMessageCount: 1,
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    // Another wallet sees nothing and cannot write.
    expect(await ctx.store.loadState(id, OTHER_WALLET)).toMatchObject({ draft: null, costUsd: 0 });
    await ctx.store.saveDraft(id, OTHER_WALLET, { name: 'Hijack' });
    await expect(ctx.store.addCost(id, OTHER_WALLET, 1)).rejects.toBeInstanceOf(StoreError);
    expect(await ctx.store.loadState(id, WALLET)).toMatchObject({
      draft: { name: 'MoonPad' },
      costUsd: 0.0123,
    });
  });

  it('adds concurrent cost increments without losing any (compare-and-set)', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    const totals = await Promise.all(
      Array.from({ length: 5 }, () => ctx.store.addCost(id, WALLET, 0.001)),
    );
    expect((await ctx.store.loadState(id, WALLET)).costUsd).toBeCloseTo(0.005, 9);
    expect(Math.max(...totals)).toBeCloseTo(0.005, 9);
  });

  it('rounds each increment up to the micro-dollar', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    await ctx.store.addCost(id, WALLET, 0.0000001);
    expect((await ctx.store.loadState(id, WALLET)).costUsd).toBe(0.000001);
  });

  it('sums the daily spend over the conversations active in the window', async () => {
    const ctx = setup();
    const old = await ctx.conversation();
    await ctx.store.appendMessages(old, [{ role: 'user', content: 'a' }]);
    await ctx.store.addCost(old, WALLET, 0.4);
    ctx.advance(25 * HOUR);
    const a = await ctx.conversation();
    const b = await ctx.conversation();
    for (const id of [a, b]) {
      await ctx.store.appendMessages(id, [{ role: 'user', content: 'x' }]);
      await ctx.store.addCost(id, WALLET, 0.3);
    }
    const mine = await ctx.store.walletSpendSince(WALLET, new Date(T0 + 25 * HOUR - 24 * HOUR));
    expect(mine).toBeCloseTo(0.6, 9);
    expect(await ctx.store.walletSpendSince(OTHER_WALLET, new Date(0))).toBe(0);
  });
});

describe('SupabaseChatStore.confirmSpec', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('creates the draft launchpad, claims the conversation and creates one spec_ready job', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    const out = await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec });
    expect(out.status).toBe('created');
    if (out.status !== 'created') return;
    expect(ctx.db.rows('launchpads')).toEqual([
      expect.objectContaining({
        id: out.launchpadId,
        owner_wallet: WALLET,
        slug: 'moonpad',
        status: 'draft',
      }),
    ]);
    expect(ctx.db.rows('conversations')[0]).toMatchObject({ launchpad_id: out.launchpadId });
    expect(ctx.db.rows('jobs')).toEqual([
      expect.objectContaining({ id: out.jobId, type: 'create_launchpad', status: 'spec_ready' }),
    ]);
  });

  it('is idempotent for the same spec and refuses a different one', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    const first = await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec });
    const again = await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec });
    expect(again).toEqual({ ...first, status: 'existing' });
    const changed = LaunchpadSpec.parse(validSpec({ tradingFeeBps: 150 }));
    expect(
      await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec: changed }),
    ).toEqual({ status: 'conflict' });
    expect(createJobs(ctx.db)).toHaveLength(1);
  });

  it("returns conversation_not_found for another wallet's conversation", async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    expect(
      await ctx.store.confirmSpec({ wallet: OTHER_WALLET, conversationId: id, spec: otherSpec }),
    ).toEqual({ status: 'conversation_not_found' });
    expect(ctx.db.rows('launchpads')).toHaveLength(0);
  });

  it('double confirmation race: exactly one launchpad and one job, same ids for both', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec }),
      ),
    );
    expect(ctx.db.rows('launchpads')).toHaveLength(1);
    expect(createJobs(ctx.db)).toHaveLength(1);
    const job = createJobs(ctx.db)[0]!;
    for (const r of results) {
      expect(r).toMatchObject({ launchpadId: job.launchpad_id, jobId: job.id });
    }
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
  });

  it('job race on an attached conversation: the unique index keeps one job', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    // A confirmation that crashed after the claim, before the job: retried twice concurrently.
    const lp = ctx.db.insert('launchpads', {
      owner_wallet: WALLET,
      slug: 'moonpad',
      spec,
      status: 'draft',
    });
    ctx.db.rows('conversations')[0]!.launchpad_id = lp.id;
    const [a, b] = await Promise.all([
      ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec }),
      ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec }),
    ]);
    expect(createJobs(ctx.db, lp.id as string)).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'existing', jobId: createJobs(ctx.db)[0]!.id });
    // Both inserted: one hit 23505 and read the winner back.
    expect(ctx.db.log.filter((l) => l === 'insert jobs')).toHaveLength(2);
  });

  it('reports a slug held by a recent draft of another wallet', async () => {
    const ctx = setup();
    draft(ctx, OTHER_WALLET, 'moonpad', 2 * HOUR);
    const id = await ctx.conversation();
    expect(await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec })).toEqual({
      status: 'slug_taken',
    });
    expect(ctx.db.rows('launchpads')).toHaveLength(1);
  });

  it(`caps unpaid drafts at ${DRAFT_POLICY.maxUnpaidDrafts} per wallet`, async () => {
    const ctx = setup();
    for (let i = 0; i < DRAFT_POLICY.maxUnpaidDrafts; i++) draft(ctx, WALLET, `pad${i}`, HOUR);
    const id = await ctx.conversation();
    expect(await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec })).toEqual({
      status: 'too_many_drafts',
    });
    // Paid drafts and expired ones do not count.
    const [first] = ctx.db.rows('jobs');
    first!.status = 'paid';
    expect((await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec })).status).toBe(
      'created',
    );
    const id2 = await ctx.conversation();
    const spec2 = LaunchpadSpec.parse(validSpec({ slug: 'second' }));
    expect(
      (await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id2, spec: spec2 })).status,
    ).toBe('too_many_drafts');
    ctx.advance(DRAFT_POLICY.reservationMs);
    expect(
      (await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id2, spec: spec2 })).status,
    ).toBe('created');
  });

  it('releases the slug of an expired unpaid draft of another wallet', async () => {
    const ctx = setup();
    const squat = draft(ctx, OTHER_WALLET, 'moonpad', 25 * HOUR);
    // An old quote, expired long ago, does not hold the slug.
    ctx.db.insert('payments', {
      job_id: squat.job.id,
      status: 'quoted',
      quote_expires_at: new Date(T0 - 20 * HOUR).toISOString(),
    });
    const id = await ctx.conversation();
    const out = await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec });
    expect(out.status).toBe('created');
    const old = ctx.db.rows('launchpads').find((r) => r.id === squat.lp.id)!;
    expect(old).toMatchObject({ status: 'disabled', slug: `released-${String(squat.lp.id)}` });
    const mine = ctx.db.rows('launchpads').find((r) => r.owner_wallet === WALLET)!;
    expect(mine).toMatchObject({ slug: 'moonpad', status: 'draft' });
    // Never deleted: the old job still points at it.
    expect(createJobs(ctx.db, squat.lp.id as string)).toHaveLength(1);
  });

  it.each([
    ['younger than the reservation', 23 * HOUR, null, 'spec_ready'],
    ['paid', 25 * HOUR, null, 'paid'],
    ['with an open quote', 25 * HOUR, { status: 'quoted', expiresIn: 60_000 }, 'spec_ready'],
    [
      'with a quote expired minutes ago',
      25 * HOUR,
      { status: 'quoted', expiresIn: -60_000 },
      'spec_ready',
    ],
    [
      'with a confirmed payment',
      25 * HOUR,
      { status: 'confirmed', expiresIn: -5 * HOUR },
      'spec_ready',
    ],
  ] as const)('keeps the slug of a draft %s', async (_label, age, payment, jobStatus) => {
    const ctx = setup();
    const held = draft(ctx, OTHER_WALLET, 'moonpad', age);
    held.job.status = jobStatus;
    if (payment) {
      ctx.db.insert('payments', {
        job_id: held.job.id,
        status: payment.status,
        quote_expires_at: new Date(T0 + payment.expiresIn).toISOString(),
      });
    }
    const id = await ctx.conversation();
    expect(await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec })).toEqual({
      status: 'slug_taken',
    });
    expect(ctx.db.rows('launchpads')[0]).toMatchObject({ slug: 'moonpad', status: 'draft' });
  });

  it('puts the draft back when a quote lands during the release', async () => {
    const ctx = setup();
    const held = draft(ctx, OTHER_WALLET, 'moonpad', 25 * HOUR);
    let released = false;
    ctx.db.beforeStatement = (op, table) => {
      // Right after the release write, the owner's quote request writes its payment row.
      if (released && op === 'select' && table === 'jobs') {
        ctx.db.insert('payments', {
          job_id: held.job.id,
          status: 'quoted',
          quote_expires_at: new Date(T0 + 120_000).toISOString(),
        });
        released = false;
      }
      if (op === 'update' && table === 'launchpads') released = true;
    };
    const id = await ctx.conversation();
    expect(await ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec })).toEqual({
      status: 'slug_taken',
    });
    expect(ctx.db.rows('launchpads').find((r) => r.id === held.lp.id)).toMatchObject({
      slug: 'moonpad',
      status: 'draft',
    });
  });

  it('tells the owner of a released draft to start a new conversation', async () => {
    const ctx = setup();
    const id = await ctx.conversation(OTHER_WALLET);
    const first = await ctx.store.confirmSpec({
      wallet: OTHER_WALLET,
      conversationId: id,
      spec: otherSpec,
    });
    expect(first.status).toBe('created');
    ctx.advance(25 * HOUR);
    const mine = await ctx.conversation();
    expect(
      (await ctx.store.confirmSpec({ wallet: WALLET, conversationId: mine, spec })).status,
    ).toBe('created');
    expect(
      await ctx.store.confirmSpec({ wallet: OTHER_WALLET, conversationId: id, spec: otherSpec }),
    ).toEqual({ status: 'draft_released' });
  });

  it('rolls the launchpad back when the conversation claim fails', async () => {
    const ctx = setup();
    const id = await ctx.conversation();
    ctx.db.beforeStatement = (op, table) =>
      op === 'update' && table === 'conversations' ? { code: '40001' } : undefined;
    await expect(
      ctx.store.confirmSpec({ wallet: WALLET, conversationId: id, spec }),
    ).rejects.toBeInstanceOf(StoreError);
    expect(ctx.db.rows('launchpads')).toHaveLength(0);
    expect(ctx.db.rows('jobs')).toHaveLength(0);
  });
});
