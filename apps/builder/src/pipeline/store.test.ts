import { describe, expect, it } from 'vitest';
import { json, stubFetch } from '../http-mock.js';
import { PersistentCostGatewayStore } from './cost-store.js';
import {
  createSupabaseStore,
  LaunchpadStatusChangedError,
  StoreError,
  type JobCostStore,
  type LaunchpadPatch,
} from './store.js';
import { launchpadFixture, LAUNCHPAD_ID } from './test-fakes.js';

const URL = 'https://db.example.supabase.co';
const KEY = 'service-role-key-that-must-never-leak';

function store(stub: ReturnType<typeof stubFetch>) {
  return createSupabaseStore({ url: URL, serviceRoleKey: KEY, fetch: stub.fetch });
}

describe('launchpad store', () => {
  it('reads a launchpad with the service key', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json([launchpadFixture()]) },
    ]);
    const lp = await store(stub).getLaunchpad(LAUNCHPAD_ID);
    expect(lp).toMatchObject({ id: LAUNCHPAD_ID, slug: 'moonpad', status: 'draft' });
    const call = stub.calls[0]!;
    expect(call.query.get('id')).toBe(`eq.${LAUNCHPAD_ID}`);
    expect(call.headers.apikey).toBe(KEY);
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('returns null for a missing launchpad and refuses odd ids', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json([]) },
    ]);
    expect(await store(stub).getLaunchpad(LAUNCHPAD_ID)).toBeNull();
    await expect(store(stub).getLaunchpad('x,or=(1.eq.1)')).rejects.toBeInstanceOf(StoreError);
  });

  it('updates exactly one row', async () => {
    const stub = stubFetch([
      {
        method: 'PATCH',
        path: '/rest/v1/launchpads',
        handler: () => json([{ id: LAUNCHPAD_ID }]),
        times: 1,
      },
      { method: 'PATCH', path: '/rest/v1/launchpads', handler: () => json([]) },
    ]);
    await store(stub).updateLaunchpad(LAUNCHPAD_ID, { status: 'live', github_repo: 'lp-moonpad' });
    expect(stub.calls[0]!.body).toEqual({ status: 'live', github_repo: 'lp-moonpad' });
    expect(stub.calls[0]!.headers.prefer).toBe('return=representation');
    await expect(
      store(stub).updateLaunchpad(LAUNCHPAD_ID, { github_repo: 'lp-moonpad' }),
    ).rejects.toThrow(/not found/);
  });

  it('makes every status write conditional: never over a disabled launchpad', async () => {
    const stub = stubFetch([
      {
        method: 'PATCH',
        path: '/rest/v1/launchpads',
        handler: () => json([{ id: LAUNCHPAD_ID }]),
        times: 3,
      },
      { method: 'PATCH', path: '/rest/v1/launchpads', handler: () => json([]) },
    ]);
    const s = store(stub);
    await s.updateLaunchpad(LAUNCHPAD_ID, { status: 'live' });
    expect(stub.calls[0]!.query.get('status')).toBe('neq.disabled');
    await s.updateLaunchpad(LAUNCHPAD_ID, { status: 'sleeping' }, { expectStatus: ['live'] });
    expect(stub.calls[1]!.query.get('status')).toBe('in.(live)');
    // Other columns are written whatever the status.
    await s.updateLaunchpad(LAUNCHPAD_ID, { vercel_project_id: 'prj_1' });
    expect(stub.calls[2]!.query.has('status')).toBe(false);
    // No row matched: the launchpad was disabled (or moved on) in the meantime.
    await expect(s.updateLaunchpad(LAUNCHPAD_ID, { status: 'live' })).rejects.toBeInstanceOf(
      LaunchpadStatusChangedError,
    );
  });

  it('refuses to write the disabled status or to expect it', async () => {
    const stub = stubFetch([
      { method: 'PATCH', path: '/rest/v1/launchpads', handler: () => json([{ id: 'x' }]) },
    ]);
    const s = store(stub);
    await expect(
      s.updateLaunchpad(LAUNCHPAD_ID, { status: 'disabled' } as unknown as LaunchpadPatch),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      s.updateLaunchpad(
        LAUNCHPAD_ID,
        { status: 'live' },
        { expectStatus: ['disabled'] as unknown as ['live'] },
      ),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      s.updateLaunchpad(LAUNCHPAD_ID, { status: 'live' }, { expectStatus: [] }),
    ).rejects.toBeInstanceOf(StoreError);
    expect(stub.calls).toHaveLength(0);
  });

  it('never puts the key in an error', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json({ message: 'boom' }, 500) },
    ]);
    const error = await store(stub)
      .getLaunchpad(LAUNCHPAD_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('lists dormant and woken launchpads with a cutoff', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json([]) },
    ]);
    const s = store(stub);
    await s.listDormant('2026-01-01T00:00:00.000Z', 50);
    await s.listWoken('2026-01-01T00:00:00.000Z', 50);
    expect(stub.calls[0]!.query.get('status')).toBe('eq.live');
    expect(stub.calls[0]!.query.get('or')).toBe(
      '(last_trade_at.lt.2026-01-01T00:00:00.000Z,and(last_trade_at.is.null,created_at.lt.2026-01-01T00:00:00.000Z))',
    );
    expect(stub.calls[1]!.query.get('status')).toBe('eq.sleeping');
    expect(stub.calls[1]!.query.get('last_trade_at')).toBe('gte.2026-01-01T00:00:00.000Z');
    await expect(s.listDormant('yesterday', 1)).rejects.toBeInstanceOf(StoreError);
  });

  it('pages the lists with a keyset cursor on the id', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json([]) },
    ]);
    const s = store(stub);
    await s.listDormant('2026-01-01T00:00:00.000Z', 50);
    await s.listDormant('2026-01-01T00:00:00.000Z', 50, LAUNCHPAD_ID);
    await s.listWoken('2026-01-01T00:00:00.000Z', 20, LAUNCHPAD_ID);
    expect(stub.calls[0]!.query.get('order')).toBe('id.asc');
    expect(stub.calls[0]!.query.get('limit')).toBe('50');
    expect(stub.calls[0]!.query.has('id')).toBe(false);
    expect(stub.calls[1]!.query.get('id')).toBe(`gt.${LAUNCHPAD_ID}`);
    expect(stub.calls[2]!.query.get('id')).toBe(`gt.${LAUNCHPAD_ID}`);
    expect(stub.calls[2]!.query.get('limit')).toBe('20');
    await expect(
      s.listDormant('2026-01-01T00:00:00.000Z', 50, 'x,or=(1.eq.1)'),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it('counts a job that failed after approval as blocking activity', async () => {
    const stub = stubFetch([{ method: 'GET', path: '/rest/v1/jobs', handler: () => json([]) }]);
    await store(stub).hasJobActivity(LAUNCHPAD_ID, '2026-01-01T00:00:00.000Z');
    expect(stub.calls[0]!.query.get('or')).toBe(
      '(updated_at.gte.2026-01-01T00:00:00.000Z,status.in.(paid,building,preview_ready,approved,onchain_setup,awaiting_owner_signature,owner_signed,deploying),and(status.eq.failed,failed_stage.in.(onchain,deploy)))',
    );
  });

  it('detects job activity', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/jobs', handler: () => json([{ id: 'j' }]), times: 1 },
      { method: 'GET', path: '/rest/v1/jobs', handler: () => json([]) },
    ]);
    const s = store(stub);
    expect(await s.hasJobActivity(LAUNCHPAD_ID, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(await s.hasJobActivity(LAUNCHPAD_ID, '2026-01-01T00:00:00.000Z')).toBe(false);
    expect(stub.calls[0]!.query.get('or')).toContain('status.in.(paid,building');
  });

  it('reads and writes the job cost', async () => {
    const stub = stubFetch([
      { method: 'GET', path: '/rest/v1/jobs', handler: () => json([{ api_cost_usd: '1.25' }]) },
      { method: 'PATCH', path: '/rest/v1/jobs', handler: () => json([{ id: 'j' }]) },
    ]);
    const s = store(stub);
    expect(await s.getJobCost('job-1')).toBe(1.25);
    await s.setJobCost('job-1', 2.5);
    expect(stub.calls[1]!.body).toEqual({ api_cost_usd: 2.5 });
    await expect(s.setJobCost('job-1', -1)).rejects.toBeInstanceOf(StoreError);
  });
});

describe('gateway cost store', () => {
  function memoryDb(initial = 0) {
    const writes: number[] = [];
    let reads = 0;
    let value = initial;
    let failWrites = false;
    const db: JobCostStore = {
      getJobCost: async () => {
        reads += 1;
        return value;
      },
      setJobCost: async (_id, usd) => {
        await new Promise((r) => setTimeout(r, 1));
        if (failWrites) throw new Error('db down');
        writes.push(usd);
        value = usd;
      },
    };
    return {
      db,
      writes,
      reads: () => reads,
      failWrites: () => {
        failWrites = true;
      },
    };
  }

  it('persists the job cost, serialized, starting from the stored total', async () => {
    const m = memoryDb(3);
    const s = new PersistentCostGatewayStore(m.db);
    const totals = await Promise.all([
      s.addJobCost('j', 1),
      s.addJobCost('j', 2),
      s.addJobCost('j', 0.5),
    ]);
    expect(totals).toEqual([4, 6, 6.5]);
    expect(m.writes).toEqual([4, 6, 6.5]);
    expect(await s.getJobCost('j')).toBe(6.5);
    expect(m.reads()).toBe(1);
  });

  it('keeps enforcing the budget when the cost cannot be written', async () => {
    const m = memoryDb(0);
    m.failWrites();
    const warnings: string[] = [];
    const s = new PersistentCostGatewayStore(m.db, { warn: (_o, msg) => warnings.push(msg ?? '') });
    expect(await s.addJobCost('j', 14)).toBe(14);
    expect(await s.getJobCost('j')).toBe(14);
    expect(warnings).toEqual(['could not record the job API cost']);
  });

  it('keeps tokens and daily totals in memory', async () => {
    const s = new PersistentCostGatewayStore(memoryDb().db);
    await s.saveToken({ tokenHash: 'h', jobId: 'j', budgetUsd: 15, expiresAt: 1, revoked: false });
    await s.revokeJobTokens('j');
    expect((await s.getToken('h'))?.revoked).toBe(true);
    expect(await s.addDailyCost('2026-01-01', 2)).toBe(2);
    expect(await s.markDailyAlert('2026-01-01')).toBe(true);
    expect(await s.markDailyAlert('2026-01-01')).toBe(false);
  });
});
