// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readRoutesConfig, RoutesConfigError } from '../config';
import { StoreError } from '../store';
import { SupabaseRoutesStore } from '../supabase-store';

interface Result {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
  count?: number | null;
}

/** Chainable PostgREST builder double recording every call. */
function fakeDb(results: Result[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  let next = 0;
  const db = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const result = results[next++] ?? {};
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve({
                  data: result.data ?? null,
                  error: result.error ?? null,
                  count: result.count ?? null,
                }).then(resolve, reject);
            }
            return (...args: unknown[]) => {
              entry.ops.push([String(prop), args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { store: new SupabaseRoutesStore(db as unknown as SupabaseClient), calls };
}

const W = 'Wallet1111111111111111111111111111111111111';
const LP = {
  id: 'lp1',
  owner_wallet: W,
  slug: 'moonpad',
  spec: {},
  launchpad_config: null,
  launchpad_coin_config: null,
  launchpad_coin_mint: null,
  included_modifications_left: 2,
  status: 'live',
  created_at: '2026-10-10T00:00:00Z',
};
const JOB = {
  id: 'j1',
  launchpad_id: 'lp1',
  type: 'create_launchpad',
  status: 'awaiting_owner_signature',
  attempts: 1,
  failed_stage: null,
  request: null,
  preview_url: null,
  owner_tx: 'AQ==',
  error: null,
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
};

function ownerFilters(ops: [string, unknown[]][]): unknown[][] {
  return ops.filter(([op]) => op === 'eq').map(([, args]) => args);
}

describe('SupabaseRoutesStore owner filters', () => {
  it('reads a job through an inner join filtered on the owner', async () => {
    const { store, calls } = fakeDb([{ data: { ...JOB, launchpads: LP } }]);
    const owned = await store.getOwnedJob('j1', W);
    expect(owned?.job.ownerTx).toBe('AQ==');
    expect(owned?.launchpad.ownerWallet).toBe(W);
    const select = calls[0]!.ops.find(([op]) => op === 'select')![1][0] as string;
    expect(select).toContain('launchpads!inner(');
    expect(ownerFilters(calls[0]!.ops)).toEqual([
      ['id', 'j1'],
      ['launchpads.owner_wallet', W],
    ]);
  });

  // Before: owner_tx_details was never read, so the owner-transaction routes had no stored
  // launch accounts to pin.
  it('reads the launch accounts stored with the owner transaction, raw (validated by the route)', async () => {
    const details = { creator: 'c', anything: 1 };
    const { store, calls } = fakeDb([
      { data: { ...JOB, owner_tx_details: details, launchpads: LP } },
      { data: { ...JOB, launchpads: LP } },
    ]);
    expect((await store.getOwnedJob('j1', W))?.job.ownerTxDetails).toEqual(details);
    // A row written before the column existed.
    expect((await store.getOwnedJob('j1', W))?.job.ownerTxDetails).toBeNull();
    const select = calls[0]!.ops.find(([op]) => op === 'select')![1][0] as string;
    expect(select.split(/,\s*|\(/)).toContain('owner_tx_details');
  });

  it("reads a conversation's draft (conversations.spec), raw, with the owner filter", async () => {
    const draft = { theme: { logoUrl: 'https://cdn.example.com/logo.png' } };
    const { store, calls } = fakeDb([
      { data: { id: 'c1', owner_wallet: W, launchpad_id: 'lp1', spec: draft } },
    ]);
    expect(await store.getOwnedConversation('c1', W)).toEqual({
      id: 'c1',
      ownerWallet: W,
      launchpadId: 'lp1',
      draft,
    });
    const select = calls[0]!.ops.find(([op]) => op === 'select')![1][0] as string;
    expect(select.split(/,\s*/)).toContain('spec');
    expect(ownerFilters(calls[0]!.ops)).toContainEqual(['owner_wallet', W]);
  });

  it('reads the recorded image sources of a launchpad with the owner filter (migration 0014)', async () => {
    const source = 'https://cdn.example.com/moon.png';
    const { store, calls } = fakeDb([
      {
        data: {
          image_sources: { 'launchpadCoin.imageUrl': source, other: 'x', 'theme.logoUrl': 3 },
        },
      },
      { data: { image_sources: null } },
      { data: null },
      { error: { code: '42703', message: 'column launchpads.image_sources does not exist' } },
    ]);
    expect(await store.getLaunchpadImageSources('lp1', W)).toEqual({
      'launchpadCoin.imageUrl': source,
    });
    expect(await store.getLaunchpadImageSources('lp1', W)).toEqual({});
    expect(await store.getLaunchpadImageSources('lp1', W)).toEqual({});
    const failed = await store.getLaunchpadImageSources('lp1', W).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StoreError);
    expect(String((failed as Error).message)).not.toContain('does not exist');
    expect(calls[0]!.table).toBe('launchpads');
    expect(ownerFilters(calls[0]!.ops)).toEqual([
      ['id', 'lp1'],
      ['owner_wallet', W],
    ]);
  });

  it('drops a row whose launchpad belongs to someone else (defense in depth)', async () => {
    const { store } = fakeDb([{ data: { ...JOB, launchpads: { ...LP, owner_wallet: 'other' } } }]);
    expect(await store.getOwnedJob('j1', W)).toBeNull();
  });

  it('filters events, jobs, launchpads, conversations and refunds by owner', async () => {
    const { store, calls } = fakeDb([
      { data: [{ id: '3', job_id: 'j1', message: 'm', created_at: null }] },
      { data: [JOB] },
      { data: LP },
      { data: [LP] },
      { data: { id: 'c1', owner_wallet: W, launchpad_id: 'lp1' } },
      {
        data: [
          { job_id: 'j1', lamports: '5', refund_signature: 'rs' },
          { job_id: 'j2', lamports: 1, refund_signature: null },
        ],
      },
    ]);
    expect(await store.listJobEvents('j1', W)).toEqual([
      { id: 3, jobId: 'j1', message: 'm', createdAt: '' },
    ]);
    expect(await store.listOwnedJobs(W, ['lp1', 'lp1'])).toHaveLength(1);
    expect(await store.getOwnedLaunchpad('lp1', W)).not.toBeNull();
    expect(await store.listOwnedLaunchpads(W)).toHaveLength(1);
    expect(await store.getOwnedConversation('c1', W)).toEqual({
      id: 'c1',
      ownerWallet: W,
      launchpadId: 'lp1',
      draft: null,
    });
    expect(await store.listRefunds(W, ['j1', 'j2'])).toEqual([
      { jobId: 'j1', lamports: 5n, signature: 'rs' },
    ]);

    expect(ownerFilters(calls[0]!.ops)).toContainEqual(['jobs.launchpads.owner_wallet', W]);
    expect(ownerFilters(calls[1]!.ops)).toContainEqual(['launchpads.owner_wallet', W]);
    expect(calls[1]!.ops).toContainEqual(['in', ['launchpad_id', ['lp1']]]);
    expect(ownerFilters(calls[2]!.ops)).toContainEqual(['owner_wallet', W]);
    expect(ownerFilters(calls[3]!.ops)).toContainEqual(['owner_wallet', W]);
    expect(ownerFilters(calls[4]!.ops)).toContainEqual(['owner_wallet', W]);
    expect(ownerFilters(calls[5]!.ops)).toContainEqual(['payer_wallet', W]);
  });

  it('skips the query for empty id lists', async () => {
    const { store, calls } = fakeDb([]);
    expect(await store.listOwnedJobs(W, [])).toEqual([]);
    expect(await store.listRefunds(W, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('writes job status with a compare-and-set on id, launchpad and status', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'j1' }] }, { data: [] }]);
    expect(await store.transitionJob('j1', 'lp1', 'preview_ready', 'approved')).toBe(true);
    expect(calls[0]!.ops).toEqual([
      ['update', [{ status: 'approved' }]],
      ['eq', ['id', 'j1']],
      ['eq', ['launchpad_id', 'lp1']],
      ['eq', ['status', 'preview_ready']],
      ['select', ['id']],
    ]);
    expect(await store.transitionJob('j1', 'lp1', 'preview_ready', 'approved')).toBe(false);
  });

  it('only rewrites or deletes modification jobs still in spec_ready', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'j2' }] }, { data: [{ id: 'j2' }] }]);
    expect(await store.updatePendingModificationRequest('j2', 'lp1', 'new')).toBe(true);
    expect(await store.deletePendingModificationJob('j2', 'lp1')).toBe(true);
    for (const call of calls) {
      expect(ownerFilters(call.ops)).toEqual(
        expect.arrayContaining([
          ['type', 'modify_launchpad'],
          ['status', 'spec_ready'],
          ['launchpad_id', 'lp1'],
        ]),
      );
    }
  });

  it('moves a launchpad status conditionally, filtered on the owner', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'lp1' }] }]);
    expect(
      await store.transitionLaunchpad('lp1', W, 'sleeping', 'live', '2026-10-11T00:00:00.000Z'),
    ).toBe(true);
    expect(calls[0]!.ops[0]).toEqual([
      'update',
      [{ status: 'live', last_trade_at: '2026-10-11T00:00:00.000Z' }],
    ]);
    expect(ownerFilters(calls[0]!.ops)).toEqual([
      ['id', 'lp1'],
      ['owner_wallet', W],
      ['status', 'sleeping'],
    ]);
  });

  it('reads flags and fails closed on errors, carrying the code only', async () => {
    const { store } = fakeDb([
      { data: { value: true } },
      { data: null },
      { error: { code: '57014', message: 'timeout on postgres://secret' } },
    ]);
    expect(await store.getFlag('deploys_paused')).toBe(true);
    expect(await store.getFlag('deploys_paused')).toBe(false);
    const error = await store.getFlag('deploys_paused').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).dbCode).toBe('57014');
    expect((error as Error).message).not.toContain('secret');
  });

  it('reads the payments and open anomalies of jobs through the owner of their launchpad', async () => {
    const payment = {
      job_id: 'j1',
      status: 'refunded',
      tx_signature: 'tx',
      refund_signature: null,
      quote_expires_at: '2026-10-10T00:02:00Z',
    };
    const { store, calls } = fakeDb([{ data: [payment] }, { count: 2 }]);
    expect(await store.listJobPayments(W, ['j1', 'j1'])).toEqual([
      {
        jobId: 'j1',
        status: 'refunded',
        txSignature: 'tx',
        refundSignature: null,
        quoteExpiresAt: '2026-10-10T00:02:00Z',
      },
    ]);
    expect(await store.countOpenPaymentAnomalies(W, ['j1'])).toBe(2);
    expect(calls.map((c) => c.table)).toEqual(['payments', 'payment_anomalies']);
    for (const call of calls) {
      const select = call.ops.find(([op]) => op === 'select')![1][0] as string;
      expect(select).toContain('jobs!inner(launchpads!inner(owner_wallet))');
      expect(ownerFilters(call.ops)).toContainEqual(['jobs.launchpads.owner_wallet', W]);
      expect(call.ops).toContainEqual(['in', ['job_id', ['j1']]]);
    }
    expect(calls[1]!.ops).toContainEqual(['is', ['resolved_at', null]]);
    // Payments of any payer: the filter is the owner of the launchpad, never payer_wallet.
    expect(ownerFilters(calls[0]!.ops).map(([column]) => column)).not.toContain('payer_wallet');
  });

  it('fails closed when the anomalies cannot be counted, and skips empty lists', async () => {
    const { store, calls } = fakeDb([{ data: null }, { error: { code: '42P01' } }]);
    await expect(store.countOpenPaymentAnomalies(W, ['j1'])).rejects.toBeInstanceOf(StoreError);
    const error = await store.countOpenPaymentAnomalies(W, ['j1']).catch((e: unknown) => e);
    expect((error as StoreError).dbCode).toBe('42P01');
    expect(await store.listJobPayments(W, [])).toEqual([]);
    expect(await store.countOpenPaymentAnomalies(W, [])).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('inserts a creation job in spec_ready and reports a unique violation by its code', async () => {
    const row = { ...JOB, id: 'j9', status: 'spec_ready', owner_tx: null, attempts: 0 };
    const { store, calls } = fakeDb([{ data: row }, { error: { code: '23505', message: 'dup' } }]);
    expect(await store.insertCreationJob('lp1')).toMatchObject({
      id: 'j9',
      type: 'create_launchpad',
      status: 'spec_ready',
    });
    expect(calls[0]!.ops[0]).toEqual([
      'insert',
      [{ launchpad_id: 'lp1', type: 'create_launchpad', status: 'spec_ready' }],
    ]);
    const error = await store.insertCreationJob('lp1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).dbCode).toBe('23505');
  });

  // Before: ids past the 200th were dropped silently, so the payments and anomalies of older jobs
  // (a draft started again many times) were never read.
  it('reads every id of a long list, in bounded chunks, never dropping one', async () => {
    const jobIds = Array.from({ length: 450 }, (_, i) => `j${i}`);
    const { store, calls } = fakeDb([
      { data: [] },
      { data: [] },
      { data: [] },
      { count: 1 },
      { count: 0 },
      { count: 2 },
      { data: [] },
      { data: [] },
      { data: [] },
    ]);
    await store.listJobPayments(W, [...jobIds, 'j0']);
    expect(await store.countOpenPaymentAnomalies(W, jobIds)).toBe(3);
    await store.listRefunds(W, jobIds);
    expect(calls).toHaveLength(9);
    const listed = calls.map((c) => c.ops.find(([op]) => op === 'in')![1][1] as string[]);
    for (const ids of listed) expect(ids.length).toBeLessThanOrEqual(200);
    for (const group of [listed.slice(0, 3), listed.slice(3, 6), listed.slice(6, 9)]) {
      expect(group.flat().sort()).toEqual([...jobIds].sort());
    }
  });

  it('keeps the jobs of several chunks newest first', async () => {
    const launchpadIds = Array.from({ length: 201 }, (_, i) => `lp${i}`);
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;
    const { store } = fakeDb([
      { data: [{ ...JOB, id: 'old', created_at: at(1) }] },
      { data: [{ ...JOB, id: 'new', created_at: at(9) }] },
    ]);
    const jobs = await store.listOwnedJobs(W, launchpadIds);
    expect(jobs.map((j) => j.id)).toEqual(['new', 'old']);
  });

  it('fails closed instead of answering from a cut list', async () => {
    const rows = (n: number, row: Record<string, unknown>) =>
      Array.from({ length: n }, (_, i) => ({ ...row, id: `r${i}` }));
    const payment = {
      job_id: 'j1',
      status: 'expired',
      tx_signature: null,
      refund_signature: null,
      quote_expires_at: '2026-10-10T00:02:00Z',
    };
    const { store, calls } = fakeDb([
      { data: rows(1000, JOB) },
      { data: rows(1001, JOB) },
      { data: rows(1001, payment) },
      { data: rows(201, LP) },
    ]);
    expect(await store.listOwnedJobs(W, ['lp1'])).toHaveLength(1000);
    await expect(store.listOwnedJobs(W, ['lp1'])).rejects.toBeInstanceOf(StoreError);
    await expect(store.listJobPayments(W, ['j1'])).rejects.toBeInstanceOf(StoreError);
    await expect(store.listOwnedLaunchpads(W)).rejects.toBeInstanceOf(StoreError);
    // One row more than the limit is asked for, to tell a full list from a cut one.
    expect(calls[0]!.ops).toContainEqual(['limit', [1001]]);
    expect(calls[3]!.ops).toContainEqual(['limit', [201]]);
  });

  it('rejects unexpected rows', async () => {
    const { store } = fakeDb([{ data: { ...JOB, status: 'bogus', launchpads: LP } }]);
    await expect(store.getOwnedJob('j1', W)).rejects.toBeInstanceOf(StoreError);
  });
});

describe('readRoutesConfig', () => {
  const base = {
    RPC_URL: 'https://devnet.helius-rpc.com/?api-key=x',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  };

  it('defaults to devnet and requires a devnet RPC URL', () => {
    expect(readRoutesConfig(base)).toMatchObject({ cluster: 'devnet', clientsDomain: null });
    expect(() => readRoutesConfig({ ...base, RPC_URL: 'https://mainnet.helius-rpc.com' })).toThrow(
      RoutesConfigError,
    );
    expect(() => readRoutesConfig({ ...base, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(
      /test cluster/,
    );
  });

  it('names missing variables without their values', () => {
    const error = (() => {
      try {
        readRoutesConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: '' });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toBe('SUPABASE_SERVICE_ROLE_KEY is not set');
    expect(() => readRoutesConfig({ ...base, CLIENTS_DOMAIN: 'not a host' })).toThrow(
      /CLIENTS_DOMAIN/,
    );
    expect(readRoutesConfig({ ...base, CLIENTS_DOMAIN: 'Sites.Example.com' }).clientsDomain).toBe(
      'sites.example.com',
    );
  });
});
