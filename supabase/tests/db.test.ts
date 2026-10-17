import { randomUUID } from 'node:crypto';
import { isSiteHost } from '@forge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadMigrate } from './migrate-module.js';

const url = process.env.SUPABASE_DB_URL;
const describeDb = url ? describe : describe.skip;
// Same TLS policy as the migration script (SUPABASE_DB_CA_FILE), warned about once.
const pgConfig = url ? (await loadMigrate()).connectionConfig(url) : null;

const connect = async (): Promise<pg.Client> => {
  if (!url || !pgConfig) {
    throw new Error('SUPABASE_DB_URL is required for database integration tests.');
  }
  const c = new pg.Client(pgConfig);
  await c.connect();
  return c;
};

const run = randomUUID().slice(0, 8);
const A = `walletA_${run}`;
const B = `walletB_${run}`;

interface Ids {
  lpA: string;
  lpB: string;
  jobA: string;
  jobB: string;
  payA: string;
  payB: string;
  convA: string;
  convB: string;
}
let ids: Ids;
let admin: pg.Client;

/** Run fn in a transaction impersonating a role/wallet, always rolled back. */
async function as<T>(
  role: 'anon' | 'authenticated',
  wallet: string | null,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = await connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    if (wallet) {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role, aud: 'authenticated', sub: wallet, wallet }),
      ]);
    }
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

async function q1(c: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  const r = await c.query(sql, params);
  return r.rows[0].id as string;
}

beforeAll(async () => {
  if (!url) return;
  admin = await connect();
  await admin.query('insert into users (wallet) values ($1), ($2)', [A, B]);
  const mk = async (wallet: string, tag: string) => {
    const lp = await q1(
      admin,
      `insert into launchpads (owner_wallet, slug, spec) values ($1, $2, '{}') returning id`,
      [wallet, `t-${tag}-${run}`],
    );
    const job = await q1(
      admin,
      `insert into jobs (launchpad_id, type, status) values ($1, 'create_launchpad', 'spec_ready') returning id`,
      [lp],
    );
    const pay = await q1(
      admin,
      `insert into payments (job_id, payer_wallet, kind, usd_amount, lamports, quote_expires_at)
       values ($1, $2, 'creation', 10, 1000, now()) returning id`,
      [job, wallet],
    );
    await admin.query(`insert into job_events (job_id, message) values ($1, $2)`, [
      job,
      `ev-${tag}`,
    ]);
    const conv = await q1(
      admin,
      `insert into conversations (owner_wallet) values ($1) returning id`,
      [wallet],
    );
    await admin.query(
      `insert into chat_messages (conversation_id, role, content) values ($1, 'user', $2)`,
      [conv, `msg-${tag}`],
    );
    return { lp, job, pay, conv };
  };
  const a = await mk(A, 'a');
  const b = await mk(B, 'b');
  ids = {
    lpA: a.lp,
    lpB: b.lp,
    jobA: a.job,
    jobB: b.job,
    payA: a.pay,
    payB: b.pay,
    convA: a.conv,
    convB: b.conv,
  };
});

afterAll(async () => {
  if (!admin) return;
  const lps = [ids?.lpA, ids?.lpB].filter(Boolean);
  await admin.query(
    'delete from chat_messages where conversation_id in (select id from conversations where owner_wallet in ($1, $2))',
    [A, B],
  );
  await admin.query('delete from conversations where owner_wallet in ($1, $2)', [A, B]);
  await admin.query(
    'delete from job_events where job_id in (select id from jobs where launchpad_id = any($1))',
    [lps],
  );
  await admin.query(
    'delete from payments where job_id in (select id from jobs where launchpad_id = any($1))',
    [lps],
  );
  await admin.query('delete from jobs where launchpad_id = any($1)', [lps]);
  await admin.query('delete from launchpads where id = any($1)', [lps]);
  await admin.query('delete from users where wallet in ($1, $2)', [A, B]);
  await admin.end();
});

describeDb('RLS isolation', () => {
  const tables: [string, (i: Ids, w: 'A' | 'B') => string][] = [
    ['launchpads', (i, w) => (w === 'A' ? i.lpA : i.lpB)],
    ['jobs', (i, w) => (w === 'A' ? i.jobA : i.jobB)],
    ['payments', (i, w) => (w === 'A' ? i.payA : i.payB)],
    ['conversations', (i, w) => (w === 'A' ? i.convA : i.convB)],
  ];

  for (const [table, pick] of tables) {
    it(`${table}: A sees own row and not B's`, async () => {
      await as('authenticated', A, async (c) => {
        const rows = (
          await c.query(`select id from ${table} where id in ($1, $2)`, [
            pick(ids, 'A'),
            pick(ids, 'B'),
          ])
        ).rows;
        expect(rows.map((r) => r.id)).toEqual([pick(ids, 'A')]);
      });
    });
  }

  it('users: only own row', async () => {
    await as('authenticated', A, async (c) => {
      const rows = (await c.query('select wallet from users where wallet in ($1, $2)', [A, B]))
        .rows;
      expect(rows.map((r) => r.wallet)).toEqual([A]);
    });
  });

  it('job_events and chat_messages follow the parent owner', async () => {
    await as('authenticated', A, async (c) => {
      const ev = await c.query('select message from job_events where job_id in ($1, $2)', [
        ids.jobA,
        ids.jobB,
      ]);
      expect(ev.rows.map((r) => r.message)).toEqual(['ev-a']);
      const msg = await c.query(
        'select content from chat_messages where conversation_id in ($1, $2)',
        [ids.convA, ids.convB],
      );
      expect(msg.rows.map((r) => r.content)).toEqual(['msg-a']);
    });
    await as('authenticated', B, async (c) => {
      const ev = await c.query('select message from job_events where job_id in ($1, $2)', [
        ids.jobA,
        ids.jobB,
      ]);
      expect(ev.rows.map((r) => r.message)).toEqual(['ev-b']);
    });
  });

  it('authenticated without wallet claim sees nothing', async () => {
    await as('authenticated', null, async (c) => {
      for (const t of [
        'users',
        'launchpads',
        'jobs',
        'payments',
        'conversations',
        'chat_messages',
        'job_events',
      ]) {
        expect((await c.query(`select 1 from ${t}`)).rowCount).toBe(0);
      }
    });
  });

  it('anon sees only flags', async () => {
    await as('anon', null, async (c) => {
      expect((await c.query('select key from flags')).rowCount).toBe(8);
      for (const t of [
        'users',
        'launchpads',
        'jobs',
        'payments',
        'conversations',
        'chat_messages',
        'job_events',
      ]) {
        await c.query('savepoint s');
        await expect(c.query(`select 1 from ${t}`)).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('flags are readable by authenticated and default to false', async () => {
    await as('authenticated', A, async (c) => {
      const rows = (await c.query('select key, value from flags order by key')).rows;
      expect(rows).toEqual([
        { key: 'buyback_paused', value: false },
        { key: 'cashbox_sweep_paused', value: false },
        { key: 'claims_paused', value: false },
        { key: 'convert_paused', value: false },
        { key: 'deploys_paused', value: false },
        { key: 'jupiter_claims_paused', value: false },
        { key: 'refunds_paused', value: false },
        { key: 'revenue_paused', value: false },
        { key: 'signups_paused', value: false },
      ]);
    });
  });

  it('clients cannot insert, update or delete', async () => {
    const attempts: string[] = [
      `insert into users (wallet) values ('x')`,
      `insert into launchpads (owner_wallet, slug, spec) values ('${A}', 'x', '{}')`,
      `update launchpads set slug = 'hacked' where owner_wallet = '${A}'`,
      `update jobs set status = 'paid' where id = '${ids.jobA}'`,
      `delete from jobs where id = '${ids.jobA}'`,
      `update payments set status = 'confirmed' where id = '${ids.payA}'`,
      `insert into job_events (job_id, message) values ('${ids.jobA}', 'x')`,
      `insert into chat_messages (conversation_id, role, content) values ('${ids.convA}', 'user', 'x')`,
      `insert into conversations (owner_wallet) values ('${A}')`,
      `update flags set value = true`,
    ];
    for (const sql of attempts) {
      await as('authenticated', A, async (c) => {
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied|row-level security/);
      });
    }
    await as('anon', null, async (c) => {
      await expect(c.query(`update flags set value = true`)).rejects.toThrow(/permission denied/);
    });
  });

  it('clients cannot call the job functions', async () => {
    await as('authenticated', A, async (c) => {
      await expect(c.query(`select * from take_build_job('w')`)).rejects.toThrow(
        /permission denied/,
      );
    });
    await as('anon', null, async (c) => {
      await expect(c.query(`select * from fail_stale_jobs(1)`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describeDb('enum checks', () => {
  const bad: [string, string, unknown[]][] = [
    [
      'launchpads.status',
      `insert into launchpads (owner_wallet, slug, spec, status) values ($1, 'bad-${run}', '{}', 'nope')`,
      [A],
    ],
    [
      'jobs.type',
      `insert into jobs (launchpad_id, type, status) values ($1, 'nope', 'paid')`,
      [() => ids.lpA],
    ],
    [
      'jobs.status',
      `insert into jobs (launchpad_id, type, status) values ($1, 'create_launchpad', 'nope')`,
      [() => ids.lpA],
    ],
    [
      'jobs.failed_stage',
      `insert into jobs (launchpad_id, type, status, failed_stage) values ($1, 'create_launchpad', 'failed', 'nope')`,
      [() => ids.lpA],
    ],
    [
      'payments.kind',
      `insert into payments (job_id, payer_wallet, kind, usd_amount, lamports, quote_expires_at) values ($1, 'x', 'nope', 1, 1, now())`,
      [() => ids.jobA],
    ],
    [
      'payments.status',
      `insert into payments (job_id, payer_wallet, kind, usd_amount, lamports, quote_expires_at, status) values ($1, 'x', 'creation', 1, 1, now(), 'nope')`,
      [() => ids.jobA],
    ],
    [
      'chat_messages.role',
      `insert into chat_messages (conversation_id, role, content) values ($1, 'nope', 'x')`,
      [() => ids.convA],
    ],
    ['flags.key', `insert into flags (key, value) values ('nope', true)`, []],
  ];
  for (const [name, sql, params] of bad) {
    it(`rejects bad ${name}`, async () => {
      const c = await connect();
      try {
        await c.query('begin');
        const p = params.map((x) => (typeof x === 'function' ? (x as () => unknown)() : x));
        await expect(c.query(sql, p)).rejects.toThrow(/violates check constraint/);
      } finally {
        await c.query('rollback').catch(() => undefined);
        await c.end();
      }
    });
  }

  it('applies not-null defaults', async () => {
    const r = (
      await admin.query(
        'select attempts, api_cost_usd, locked_at, updated_at from jobs where id = $1',
        [ids.jobA],
      )
    ).rows[0];
    expect(r.attempts).toBe(0);
    expect(r.api_cost_usd).toBe('0');
    expect(r.locked_at).toBeNull();
    expect(r.updated_at).not.toBeNull();
    const lp = (
      await admin.query(
        'select status, included_modifications_left from launchpads where id = $1',
        [ids.lpA],
      )
    ).rows[0];
    expect(lp).toEqual({ status: 'draft', included_modifications_left: 2 });
  });

  it('updated_at trigger bumps on update', async () => {
    const c = await connect();
    try {
      await c.query('begin');
      await c.query(`update jobs set updated_at = '2000-01-01' where id = $1`, [ids.jobA]);
      const r = await c.query(`update jobs set request = 'x' where id = $1 returning updated_at`, [
        ids.jobA,
      ]);
      expect(new Date(r.rows[0].updated_at).getFullYear()).toBeGreaterThan(2000);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  });
});

describeDb('job functions', () => {
  // Jobs with a very old created_at so they sort before anything else in the dev database.
  const created: string[] = [];
  const createdLaunchpads: string[] = [];
  // A launchpad has at most one creation job (0005_wave3.sql), so each job gets its own launchpad.
  async function mkJob(status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const launchpadId = await q1(
      admin,
      `insert into launchpads (owner_wallet, slug, spec) values ($1, $2, '{}') returning id`,
      [A, `t-job-${createdLaunchpads.length}-${run}`],
    );
    createdLaunchpads.push(launchpadId);
    const cols = {
      launchpad_id: launchpadId,
      type: 'create_launchpad',
      status,
      created_at: '1999-01-01',
      ...extra,
    };
    const keys = Object.keys(cols);
    const id = await q1(
      admin,
      `insert into jobs (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
      Object.values(cols),
    );
    created.push(id);
    return id;
  }
  beforeAll(() => {
    created.length = 0;
    createdLaunchpads.length = 0;
  });
  afterAll(async () => {
    if (created.length) await admin.query('delete from jobs where id = any($1)', [created]);
    if (createdLaunchpads.length) {
      await admin.query('delete from launchpads where id = any($1)', [createdLaunchpads]);
    }
  });

  it('take_build_job never returns the same job twice under concurrency', async () => {
    const j1 = await mkJob('paid', { created_at: '1999-01-01' });
    const j2 = await mkJob('paid', { created_at: '1999-01-02' });
    const c1 = await connect();
    const c2 = await connect();
    try {
      await c1.query('begin');
      await c2.query('begin');
      const [r1, r2] = await Promise.all([
        c1.query(`select * from take_build_job('w1')`),
        c2.query(`select * from take_build_job('w2')`),
      ]);
      expect(r1.rows).toHaveLength(1);
      expect(r2.rows).toHaveLength(1);
      expect(r1.rows[0].id).not.toBe(r2.rows[0].id);
      expect([r1.rows[0].id, r2.rows[0].id].sort()).toEqual([j1, j2].sort());
      expect(r1.rows[0]).toMatchObject({ status: 'building', locked_by: 'w1', attempts: 1 });
    } finally {
      await c1.query('rollback').catch(() => undefined);
      await c2.query('rollback').catch(() => undefined);
      await c1.end();
      await c2.end();
    }
  });

  it('take_build_job retries failed build with attempts < 2 only', async () => {
    const retry = await mkJob('failed', { failed_stage: 'build', attempts: 1, error: 'boom' });
    const exhausted = await mkJob('failed', { failed_stage: 'build', attempts: 2 });
    const onchain = await mkJob('failed', { failed_stage: 'onchain', attempts: 1 });
    const c = await connect();
    try {
      await c.query('begin');
      const seen: string[] = [];
      for (let i = 0; i < 50; i++) {
        const r = await c.query(`select * from take_build_job('w')`);
        if (!r.rows[0]) break;
        seen.push(r.rows[0].id);
        if (r.rows[0].id === retry) {
          expect(r.rows[0]).toMatchObject({
            status: 'building',
            attempts: 2,
            failed_stage: null,
            error: null,
          });
        }
      }
      expect(seen).toContain(retry);
      expect(seen).not.toContain(exhausted);
      expect(seen).not.toContain(onchain);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  });

  it('take_post_approval_job routes by status and type and is exclusive', async () => {
    const create = await mkJob('approved', { created_at: '1999-02-01' });
    const modify = await mkJob('approved', { type: 'modify_launchpad', created_at: '1999-02-02' });
    const signed = await mkJob('owner_signed', { created_at: '1999-02-03' });
    const c1 = await connect();
    const c2 = await connect();
    try {
      await c1.query('begin');
      await c2.query('begin');
      const got = new Map<string, string>();
      const ids1: string[] = [];
      for (let i = 0; i < 200 && got.size < 3; i++) {
        const c = i % 2 === 0 ? c1 : c2;
        const r = await c.query(`select * from take_post_approval_job($1)`, [
          i % 2 === 0 ? 'w1' : 'w2',
        ]);
        if (!r.rows[0]) break;
        ids1.push(r.rows[0].id);
        if ([create, modify, signed].includes(r.rows[0].id))
          got.set(r.rows[0].id, r.rows[0].status);
      }
      expect(new Set(ids1).size).toBe(ids1.length);
      expect(got.get(create)).toBe('onchain_setup');
      expect(got.get(modify)).toBe('deploying');
      expect(got.get(signed)).toBe('deploying');
    } finally {
      await c1.query('rollback').catch(() => undefined);
      await c2.query('rollback').catch(() => undefined);
      await c1.end();
      await c2.end();
    }
  });

  it('fail_stale_jobs sets the right failed_stage and resets the lock', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const fresh = new Date().toISOString();
    const b = await mkJob('building', { locked_by: 'w', locked_at: old });
    const o = await mkJob('onchain_setup', { locked_by: 'w', locked_at: old });
    const d = await mkJob('deploying', { locked_by: 'w', locked_at: old });
    const f = await mkJob('building', { locked_by: 'w', locked_at: fresh });
    const p = await mkJob('preview_ready', { locked_by: null, locked_at: null });
    const c = await connect();
    try {
      await c.query('begin');
      const r = await c.query(`select * from fail_stale_jobs(30)`);
      const byId = new Map(r.rows.map((x) => [x.id, x]));
      expect(byId.get(b)).toMatchObject({
        status: 'failed',
        failed_stage: 'build',
        locked_by: null,
        locked_at: null,
      });
      expect(byId.get(o)).toMatchObject({
        status: 'failed',
        failed_stage: 'onchain',
        locked_by: null,
        locked_at: null,
      });
      expect(byId.get(d)).toMatchObject({
        status: 'failed',
        failed_stage: 'deploy',
        locked_by: null,
        locked_at: null,
      });
      expect(byId.has(f)).toBe(false);
      expect(byId.has(p)).toBe(false);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  });
});

describeDb('upload_tickets (0006)', () => {
  // Skipped (not failed) on a database where migration 0006 is not applied yet.
  let present = false;
  beforeAll(async () => {
    const r = await admin.query(`select to_regclass('public.upload_tickets') is not null as ok`);
    present = r.rows[0].ok === true;
  });

  let seq = 0;
  /** A valid ticket row; `over` replaces columns. */
  function ticket(over: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    const n = String(seq).padStart(4, '1');
    // Base58 has no 0: the mint (and the hex nonce) stay valid whatever the counter.
    const mint = `So1111111111111111111111111111111111111${n.replace(/0/g, 'z')}`;
    return {
      id: `t${run}${n}`.padEnd(22, 'x').slice(0, 22),
      launchpad_id: ids.lpA,
      wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      nonce: `${run}${n}`.padEnd(32, '0').replace(/[^0-9a-f]/g, 'a'),
      request_sha256: 'a'.repeat(64),
      mint,
      host: 'moonpad.forge-sites.app',
      content_type: 'image/png',
      image_size: 1024,
      image_sha256: 'b'.repeat(64),
      upload_key: `pending/moonpad/${mint}.png`,
      image_key: `launchpads/moonpad/images/${mint}.png`,
      metadata_key: `launchpads/moonpad/metadata/${mint}.json`,
      coin_name: 'Moon Coin',
      coin_symbol: 'MOON',
      coin_description: '',
      first_buy_lamports: '0',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      ...over,
    };
  }

  async function insert(c: pg.Client, row: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(row);
    await c.query(
      `insert into upload_tickets (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }

  /** Runs fn as the service owner in a transaction that is always rolled back. */
  async function inTx(fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = await connect();
    try {
      await c.query('begin');
      await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  }

  async function rejects(c: pg.Client, row: Record<string, unknown>, pattern: RegExp) {
    await c.query('savepoint s');
    await expect(insert(c, row)).rejects.toThrow(pattern);
    await c.query('rollback to savepoint s');
  }

  it('accepts a valid ticket and every status, including expired', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      for (const status of ['issued', 'rejected', 'expired']) await insert(c, ticket({ status }));
      await insert(
        c,
        ticket({
          status: 'completed',
          metadata_sha256: 'c'.repeat(64),
          completed_at: new Date().toISOString(),
          swept_at: new Date().toISOString(),
        }),
      );
      await rejects(c, ticket({ status: 'nope' }), /violates check constraint/);
      // A completed ticket must carry its metadata hash and completion time.
      await rejects(c, ticket({ status: 'completed' }), /upload_tickets_completed_check/);
    });
  });

  it('enforces single use of (wallet, nonce) and of the mint', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      const first = ticket();
      await insert(c, first);
      await rejects(
        c,
        ticket({ wallet: first.wallet, nonce: first.nonce }),
        /upload_tickets_wallet_nonce_key/,
      );
      await rejects(c, ticket({ mint: first.mint }), /upload_tickets_mint_key/);
    });
  });

  it('keeps presigned PUTs on staging keys and checks the declared image', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      await rejects(
        c,
        ticket({ upload_key: 'launchpads/moonpad/images/x.png' }),
        /upload_tickets_upload_key_check/,
      );
      await rejects(c, ticket({ image_size: 2097153 }), /upload_tickets_image_size_check/);
      await rejects(c, ticket({ content_type: 'image/svg+xml' }), /violates check constraint/);
      await rejects(c, ticket({ id: 'short' }), /upload_tickets_id_check/);
    });
  });

  it('has the sweep index on unswept tickets', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(
      `select indexdef from pg_indexes where tablename = 'upload_tickets' and indexname = 'upload_tickets_unswept_idx'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/WHERE \(swept_at IS NULL\)/);
  });

  it('is invisible to anon and authenticated clients', async (ctx) => {
    if (!present) ctx.skip();
    for (const role of ['anon', 'authenticated'] as const) {
      await as(role, role === 'authenticated' ? A : null, async (c) => {
        await c.query('savepoint s');
        await expect(c.query('select 1 from upload_tickets')).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint s');
        await expect(insert(c, ticket())).rejects.toThrow(/permission denied/);
      });
    }
  });
});

describeDb('payment_anomalies (0008)', () => {
  // Skipped (not failed) on a database where migration 0008 is not applied yet.
  let present = false;
  beforeAll(async () => {
    const r = await admin.query(`select to_regclass('public.payment_anomalies') is not null as ok`);
    present = r.rows[0].ok === true;
  });

  let seq = 0;
  /** A valid anomaly row for wallet A's payment; `over` replaces columns. */
  function anomaly(over: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    // 88 base58 characters (no 0, O, I or l), unique per row.
    const signature = `${run}${seq}`.replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'z').padEnd(88, '5');
    return {
      job_id: ids.jobA,
      payment_id: ids.payA,
      wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      signature,
      lamports: '220000000',
      reason: 'late',
      ...over,
    };
  }

  async function insert(c: pg.Client, row: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(row);
    await c.query(
      `insert into payment_anomalies (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }

  /** Runs fn as the service owner in a transaction that is always rolled back. */
  async function inTx(fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = await connect();
    try {
      await c.query('begin');
      await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  }

  async function rejects(c: pg.Client, row: Record<string, unknown>, pattern: RegExp) {
    await c.query('savepoint s');
    await expect(insert(c, row)).rejects.toThrow(pattern);
    await c.query('rollback to savepoint s');
  }

  it('accepts every reason, an unknown amount and no payment, with defaults', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      for (const reason of ['late', 'amount_mismatch', 'launchpad_released', 'duplicate']) {
        await insert(c, anomaly({ reason }));
      }
      await insert(c, anomaly({ reason: 'amount_mismatch', lamports: null, payment_id: null }));
      const r = await c.query(
        `select count(*)::int as n, bool_and(detected_at is not null and resolved_at is null) as open
         from payment_anomalies where job_id = $1`,
        [ids.jobA],
      );
      expect(r.rows[0]).toEqual({ n: 5, open: true });
    });
  });

  it('records a signature once and checks every column', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      const first = anomaly();
      await insert(c, first);
      await rejects(
        c,
        anomaly({ signature: first.signature, reason: 'duplicate' }),
        /payment_anomalies_signature_key/,
      );
      await rejects(c, anomaly({ reason: 'overpaid' }), /payment_anomalies_reason_check/);
      await rejects(c, anomaly({ lamports: '0' }), /payment_anomalies_lamports_check/);
      await rejects(
        c,
        anomaly({ signature: 'not-a-signature' }),
        /payment_anomalies_signature_check/,
      );
      await rejects(c, anomaly({ wallet: 'x' }), /payment_anomalies_wallet_check/);
      await rejects(c, anomaly({ note: 'n'.repeat(1001) }), /payment_anomalies_note_check/);
      await rejects(c, anomaly({ job_id: randomUUID() }), /foreign key/);
      await rejects(c, anomaly({ reason: null }), /null value/);
    });
  });

  it('has the index of open anomalies', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(
      `select indexdef from pg_indexes where tablename = 'payment_anomalies' and indexname = 'payment_anomalies_open_idx'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/WHERE \(resolved_at IS NULL\)/);
  });

  it('is invisible to anon and authenticated clients, owner included', async (ctx) => {
    if (!present) ctx.skip();
    for (const role of ['anon', 'authenticated'] as const) {
      await as(role, role === 'authenticated' ? A : null, async (c) => {
        await c.query('savepoint s');
        await expect(c.query('select 1 from payment_anomalies')).rejects.toThrow(
          /permission denied/,
        );
        await c.query('rollback to savepoint s');
        await expect(insert(c, anomaly())).rejects.toThrow(/permission denied/);
      });
    }
    const rls = await admin.query(
      `select relrowsecurity from pg_class where oid = 'public.payment_anomalies'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});

describeDb('jobs.owner_tx_details (0009)', () => {
  // Skipped (not failed) on a database where migration 0009 is not applied yet.
  let present = false;
  beforeAll(async () => {
    const r = await admin.query(
      `select count(*)::int as n from information_schema.columns
       where table_schema = 'public' and table_name = 'jobs' and column_name = 'owner_tx_details'`,
    );
    present = r.rows[0].n === 1;
  });

  const address = (seed: string) => `${seed}${'1'.repeat(43)}`.slice(0, 44);
  const details = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    config: address('Cfg'),
    pool: address('Poo'),
    creator: address('Crt'),
    nonceAccount: address('Nnc'),
    metadataUri: 'https://forge.app/api/coin-meta/moonpad',
    ...over,
  });

  /** Runs fn as the service owner in a transaction that is always rolled back. */
  async function inTx(fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = await connect();
    try {
      await c.query('begin');
      await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  }

  async function write(c: pg.Client, ownerTx: string | null, value: unknown): Promise<void> {
    await c.query('update jobs set owner_tx = $2, owner_tx_details = $3 where id = $1', [
      ids.jobA,
      ownerTx,
      value === null ? null : JSON.stringify(value),
    ]);
  }

  async function rejects(c: pg.Client, ownerTx: string | null, value: unknown) {
    await c.query('savepoint s');
    await expect(write(c, ownerTx, value)).rejects.toThrow(/jobs_owner_tx_details_check/);
    await c.query('rollback to savepoint s');
  }

  it('is nullable and stores the launch accounts with their transaction', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(`select owner_tx_details from jobs where id = $1`, [ids.jobA]);
    expect(r.rows[0].owner_tx_details).toBeNull();
    await inTx(async (c) => {
      await write(c, 'AQAB', details());
      const row = await c.query(`select owner_tx, owner_tx_details from jobs where id = $1`, [
        ids.jobA,
      ]);
      expect(row.rows[0]).toEqual({ owner_tx: 'AQAB', owner_tx_details: details() });
      // A transaction stored without details (rows written before 0009) stays valid.
      await write(c, 'AQAB', null);
      // Clearing both together (rebuild of an unsigned launch transaction) is allowed.
      await write(c, null, null);
    });
  });

  it('refuses details without a transaction or of the wrong shape', async (ctx) => {
    if (!present) ctx.skip();
    await inTx(async (c) => {
      await rejects(c, null, details());
      await rejects(c, 'AQAB', [details()]);
      await rejects(c, 'AQAB', 'details');
      for (const key of ['config', 'pool', 'creator', 'nonceAccount', 'metadataUri']) {
        const missing = details();
        delete missing[key];
        await rejects(c, 'AQAB', missing);
      }
      await rejects(c, 'AQAB', details({ creator: 'not-an-address' }));
      await rejects(c, 'AQAB', details({ nonceAccount: 12345 }));
      await rejects(c, 'AQAB', details({ pool: '0'.repeat(44) }));
      await rejects(c, 'AQAB', details({ metadataUri: 'http://forge.app/api/coin-meta/moonpad' }));
      await rejects(c, 'AQAB', details({ metadataUri: 'https://forge.app/a b' }));
      await rejects(c, 'AQAB', details({ note: 'x'.repeat(1024) }));
      // Once stored, owner_tx cannot be cleared alone.
      await write(c, 'AQAB', details());
      await c.query('savepoint s');
      await expect(
        c.query('update jobs set owner_tx = null where id = $1', [ids.jobA]),
      ).rejects.toThrow(/jobs_owner_tx_details_check/);
      await c.query('rollback to savepoint s');
    });
  });

  it('has exactly the privileges of owner_tx: clients read, only the service role writes', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(
      `select role, privilege,
         has_column_privilege(role, 'public.jobs', 'owner_tx', privilege) as owner_tx,
         has_column_privilege(role, 'public.jobs', 'owner_tx_details', privilege) as details
       from unnest(array['anon', 'authenticated', 'service_role']) as role,
            unnest(array['SELECT', 'INSERT', 'UPDATE']) as privilege`,
    );
    for (const row of r.rows) {
      expect(row.details, `${row.role} ${row.privilege}`).toBe(row.owner_tx);
    }
    const allowed = (role: string, privilege: string) =>
      r.rows.find((x) => x.role === role && x.privilege === privilege)?.details;
    expect(allowed('anon', 'SELECT')).toBe(false);
    expect(allowed('authenticated', 'SELECT')).toBe(true);
    expect(allowed('authenticated', 'INSERT')).toBe(false);
    expect(allowed('authenticated', 'UPDATE')).toBe(false);
    expect(allowed('service_role', 'UPDATE')).toBe(true);
  });

  it('is visible to the owner only and never writable by clients', async (ctx) => {
    if (!present) ctx.skip();
    await admin.query('update jobs set owner_tx = $2, owner_tx_details = $3 where id = $1', [
      ids.jobB,
      'AQAB',
      JSON.stringify(details()),
    ]);
    try {
      await as('authenticated', B, async (c) => {
        const rows = await c.query('select owner_tx_details from jobs where id = $1', [ids.jobB]);
        expect(rows.rows).toEqual([{ owner_tx_details: details() }]);
      });
      await as('authenticated', A, async (c) => {
        const rows = await c.query('select owner_tx_details from jobs where id = $1', [ids.jobB]);
        expect(rows.rows).toEqual([]);
        await expect(
          c.query(`update jobs set owner_tx_details = '{}' where id = $1`, [ids.jobA]),
        ).rejects.toThrow(/permission denied/);
      });
      await as('anon', null, async (c) => {
        await expect(c.query('select owner_tx_details from jobs')).rejects.toThrow(
          /permission denied/,
        );
      });
      // The service role writes it (the builder's completion of the on-chain step).
      const c = await connect();
      try {
        await c.query('begin');
        await c.query('set local role service_role');
        const updated = await c.query(
          'update jobs set owner_tx = $2, owner_tx_details = $3 where id = $1 returning id',
          [ids.jobA, 'AQAB', JSON.stringify(details())],
        );
        expect(updated.rowCount).toBe(1);
      } finally {
        await c.query('rollback').catch(() => undefined);
        await c.end();
      }
    } finally {
      await admin.query('update jobs set owner_tx = null, owner_tx_details = null where id = $1', [
        ids.jobB,
      ]);
    }
  });
});

/** Runs fn as the service owner in a transaction that is always rolled back. */
async function inRolledBackTx(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = await connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

/** The Postgres error code of `query`, or null when it succeeds (inside a savepoint). */
async function errorCode(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  await c.query('savepoint probe');
  try {
    await c.query(sql, params);
    await c.query('release savepoint probe');
    return null;
  } catch (error) {
    await c.query('rollback to savepoint probe');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describeDb('jobs: one open creation job per launchpad (0010)', () => {
  // Skipped (not failed) on a database where migration 0010 is not applied yet.
  let present = false;
  beforeAll(async () => {
    const r = await admin.query(
      `select count(*)::int as n from pg_indexes
       where schemaname = 'public' and indexname = 'jobs_one_open_create_per_launchpad_idx'`,
    );
    present = r.rows[0].n === 1;
  });

  let seq = 0;
  async function launchpad(c: pg.Client): Promise<string> {
    seq += 1;
    return q1(
      c,
      `insert into launchpads (owner_wallet, slug, spec) values ($1, $2, '{}') returning id`,
      [A, `t-0010-${seq}-${run}`],
    );
  }

  const insertJob = (launchpadId: string, status: string, type = 'create_launchpad') =>
    [
      `insert into jobs (launchpad_id, type, status) values ($1, $2, $3)`,
      [launchpadId, type, status],
    ] as const;

  async function job(c: pg.Client, launchpadId: string, status: string, type?: string) {
    const [sql, params] = insertJob(launchpadId, status, type);
    return q1(c, `${sql} returning id`, [...params]);
  }

  it('replaces the index of 0005 with a partial unique index on open creation jobs', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'jobs'
         and indexname in ('jobs_one_open_create_per_launchpad_idx', 'jobs_one_create_per_launchpad_idx')`,
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(['jobs_one_open_create_per_launchpad_idx']);
    const def = r.rows[0].indexdef as string;
    expect(def).toMatch(/^CREATE UNIQUE INDEX /);
    expect(def).toMatch(/\(launchpad_id\)/);
    expect(def).toMatch(/type = 'create_launchpad'/);
    expect(def).toMatch(/status <> 'refunded'/);
  });

  it('refuses a second creation job while one is open, whatever its status (23505)', async (ctx) => {
    if (!present) ctx.skip();
    await inRolledBackTx(async (c) => {
      for (const open of ['spec_ready', 'paid', 'building', 'failed', 'live']) {
        const lp = await launchpad(c);
        await job(c, lp, open);
        for (const next of ['spec_ready', 'paid', 'refunded']) {
          const [sql, params] = insertJob(lp, next);
          const code = await errorCode(c, sql, [...params]);
          // A refunded row steps aside; any other second creation job collides.
          expect(code, `${open} then ${next}`).toBe(next === 'refunded' ? null : '23505');
        }
        // Modification jobs are not concerned by this index (one open modification at a time is
        // the separate jobs_one_open_modification_idx).
        await job(c, lp, 'spec_ready', 'modify_launchpad');
      }
    });
  });

  it('accepts a new creation job once every earlier one is refunded', async (ctx) => {
    if (!present) ctx.skip();
    await inRolledBackTx(async (c) => {
      const lp = await launchpad(c);
      const first = await job(c, lp, 'spec_ready');
      await c.query(`update jobs set status = 'refunded' where id = $1`, [first]);
      await job(c, lp, 'refunded');
      const again = await job(c, lp, 'spec_ready');
      const r = await c.query(
        `select count(*)::int as n from jobs
         where launchpad_id = $1 and type = 'create_launchpad' and status <> 'refunded'`,
        [lp],
      );
      expect(r.rows[0].n).toBe(1);
      expect(again).not.toBe(first);
    });
  });

  it('never moves a refunded job back while a newer one is open', async (ctx) => {
    if (!present) ctx.skip();
    await inRolledBackTx(async (c) => {
      const lp = await launchpad(c);
      const old = await job(c, lp, 'refunded');
      const current = await job(c, lp, 'spec_ready');
      for (const status of ['failed', 'spec_ready', 'paid', 'live']) {
        const code = await errorCode(c, `update jobs set status = $2 where id = $1`, [old, status]);
        expect(code, status).toBe('23505');
      }
      // Once the newer one is refunded too, the index no longer stands in the way.
      await c.query(`update jobs set status = 'refunded' where id = $1`, [current]);
      expect(
        await errorCode(c, `update jobs set status = 'failed' where id = $1`, [old]),
      ).toBeNull();
    });
  });
});

describeDb('launchpads.site_host (0011)', () => {
  // Skipped (not failed) on a database where migration 0011 is not applied yet.
  let present = false;
  beforeAll(async () => {
    const r = await admin.query(
      `select count(*)::int as n from information_schema.columns
       where table_schema = 'public' and table_name = 'launchpads' and column_name = 'site_host'`,
    );
    present = r.rows[0].n === 1;
  });

  // Every shape the reviews worried about, both sides of each limit.
  const label63 = 'a'.repeat(63);
  const host253 = `${label63}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  const shapes = [
    'lp-moonpad.vercel.app',
    'lp-moonpad-forge-team.vercel.app',
    `${label63}.vercel.app`,
    `${'a'.repeat(64)}.vercel.app`,
    'moonpad.forge-sites.app',
    'a.b.example.com',
    `${label63}.example.com`,
    `${'a'.repeat(64)}.example.com`,
    host253,
    `${host253.slice(0, -4)}d.com`,
    'x.co',
    'a.b.vercel.app',
    'x.lp-moonpad.vercel.app',
    'vercel.app',
    'LP-moonpad.vercel.app',
    'Moonpad.forge-sites.app',
    'lp-moonpad.vercel.app.',
    'lp-moonpad.vercel.app:443',
    'lp-moonpad.vercel.app/',
    'lp-moonpad.vercel.app\n',
    '\nlp-moonpad.vercel.app',
    'https://lp-moonpad.vercel.app',
    'lp moonpad.vercel.app',
    '-lp.vercel.app',
    'lp-.vercel.app',
    'lp_moonpad.vercel.app',
    'localhost',
    '127.0.0.1',
    'moonpad.app1',
    '',
  ];

  async function accepted(c: pg.Client, host: string): Promise<boolean> {
    const code = await errorCode(c, `update launchpads set site_host = $2 where id = $1`, [
      ids.lpA,
      host,
    ]);
    if (code !== null && code !== '23514') throw new Error(`unexpected error ${code}`);
    return code === null;
  }

  it('accepts exactly the hosts that isSiteHost accepts (packages/shared)', async (ctx) => {
    if (!present) ctx.skip();
    // Both sides of the parity hold valid and invalid cases.
    expect(shapes.filter((h) => isSiteHost(h)).length).toBeGreaterThan(5);
    expect(shapes.filter((h) => !isSiteHost(h)).length).toBeGreaterThan(15);
    await inRolledBackTx(async (c) => {
      for (const host of shapes) {
        expect(await accepted(c, host), JSON.stringify(host)).toBe(isSiteHost(host));
      }
      // Null: no host recorded yet.
      await c.query(`update launchpads set site_host = null where id = $1`, [ids.lpA]);
    });
  });

  it('names its check constraint', async (ctx) => {
    if (!present) ctx.skip();
    await inRolledBackTx(async (c) => {
      await expect(
        c.query(`update launchpads set site_host = 'vercel.app' where id = $1`, [ids.lpA]),
      ).rejects.toThrow(/launchpads_site_host_check/);
    });
  });

  it('records one host for one launchpad only, and any number of launchpads without one', async (ctx) => {
    if (!present) ctx.skip();
    const host = `lp-unique-${run}.vercel.app`;
    await inRolledBackTx(async (c) => {
      await c.query(`update launchpads set site_host = $2 where id = $1`, [ids.lpA, host]);
      await expect(
        c.query(`update launchpads set site_host = $2 where id = $1`, [ids.lpB, host]),
      ).rejects.toThrow(/launchpads_site_host_key/);
    });
    await inRolledBackTx(async (c) => {
      for (const id of [ids.lpA, ids.lpB]) {
        await c.query(`update launchpads set site_host = null where id = $1`, [id]);
      }
      const r = await c.query(
        `select count(*)::int as n from launchpads where id = any($1) and site_host is null`,
        [[ids.lpA, ids.lpB]],
      );
      expect(r.rows[0].n).toBe(2);
    });
  });

  it('has exactly the privileges of slug: clients read, only the service role writes', async (ctx) => {
    if (!present) ctx.skip();
    const r = await admin.query(
      `select role, privilege,
         has_column_privilege(role, 'public.launchpads', 'slug', privilege) as slug,
         has_column_privilege(role, 'public.launchpads', 'site_host', privilege) as site_host
       from unnest(array['anon', 'authenticated', 'service_role']) as role,
            unnest(array['SELECT', 'INSERT', 'UPDATE']) as privilege`,
    );
    for (const row of r.rows) {
      expect(row.site_host, `${row.role} ${row.privilege}`).toBe(row.slug);
    }
    const allowed = (role: string, privilege: string) =>
      r.rows.find((x) => x.role === role && x.privilege === privilege)?.site_host;
    expect(allowed('anon', 'SELECT')).toBe(false);
    expect(allowed('authenticated', 'SELECT')).toBe(true);
    expect(allowed('authenticated', 'INSERT')).toBe(false);
    expect(allowed('authenticated', 'UPDATE')).toBe(false);
    expect(allowed('service_role', 'UPDATE')).toBe(true);
  });

  it('is read by the owner only (RLS) and never written by clients', async (ctx) => {
    if (!present) ctx.skip();
    const host = `lp-b-${run}.vercel.app`;
    await admin.query(`update launchpads set site_host = $2 where id = $1`, [ids.lpB, host]);
    try {
      await as('authenticated', B, async (c) => {
        const rows = await c.query('select site_host from launchpads where id = $1', [ids.lpB]);
        expect(rows.rows).toEqual([{ site_host: host }]);
      });
      await as('authenticated', A, async (c) => {
        const rows = await c.query('select site_host from launchpads where id = $1', [ids.lpB]);
        expect(rows.rows).toEqual([]);
        await expect(
          c.query(`update launchpads set site_host = 'lp-evil.vercel.app' where id = $1`, [
            ids.lpA,
          ]),
        ).rejects.toThrow(/permission denied/);
      });
      await as('anon', null, async (c) => {
        await expect(c.query('select site_host from launchpads')).rejects.toThrow(
          /permission denied/,
        );
      });
      // The service role writes it (the builder's deploy step).
      const c = await connect();
      try {
        await c.query('begin');
        await c.query('set local role service_role');
        const updated = await c.query(
          'update launchpads set site_host = $2 where id = $1 returning id',
          [ids.lpA, `lp-a-${run}.vercel.app`],
        );
        expect(updated.rowCount).toBe(1);
      } finally {
        await c.query('rollback').catch(() => undefined);
        await c.end();
      }
    } finally {
      await admin.query('update launchpads set site_host = null where id = $1', [ids.lpB]);
    }
  });
});
