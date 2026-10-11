// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readRoutesConfig, RoutesConfigError } from '../config';
import { StoreError } from '../store';
import { SupabaseRoutesStore } from '../supabase-store';

interface Result {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
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
                Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(
                  resolve,
                  reject,
                );
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
    const { store, calls } = fakeDb([{ data: { ...JOB, launchpad: LP } }]);
    const owned = await store.getOwnedJob('j1', W);
    expect(owned?.job.ownerTx).toBe('AQ==');
    expect(owned?.launchpad.ownerWallet).toBe(W);
    const select = calls[0]!.ops.find(([op]) => op === 'select')![1][0] as string;
    expect(select).toContain('launchpad:launchpads!inner(');
    expect(ownerFilters(calls[0]!.ops)).toEqual([
      ['id', 'j1'],
      ['launchpad.owner_wallet', W],
    ]);
  });

  it('drops a row whose launchpad belongs to someone else (defense in depth)', async () => {
    const { store } = fakeDb([{ data: { ...JOB, launchpad: { ...LP, owner_wallet: 'other' } } }]);
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
    });
    expect(await store.listRefunds(W, ['j1', 'j2'])).toEqual([
      { jobId: 'j1', lamports: 5n, signature: 'rs' },
    ]);

    expect(ownerFilters(calls[0]!.ops)).toContainEqual(['job.launchpad.owner_wallet', W]);
    expect(ownerFilters(calls[1]!.ops)).toContainEqual(['launchpad.owner_wallet', W]);
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

  it('rejects unexpected rows', async () => {
    const { store } = fakeDb([{ data: { ...JOB, status: 'bogus', launchpad: LP } }]);
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
