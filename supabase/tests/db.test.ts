import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
// @ts-expect-error plain JS helper without types
import { loadEnv } from '../scripts/migrate.mjs';

loadEnv();
const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error('SUPABASE_DB_URL is not set (supabase/.env)');

const connect = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
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

describe('RLS isolation', () => {
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
      expect((await c.query('select key from flags')).rowCount).toBe(3);
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
        { key: 'deploys_paused', value: false },
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

describe('enum checks', () => {
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

describe('job functions', () => {
  // Jobs with a very old created_at so they sort before anything else in the dev database.
  const created: string[] = [];
  async function mkJob(status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const cols = {
      launchpad_id: ids.lpA,
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
  });
  afterAll(async () => {
    if (created.length) await admin.query('delete from jobs where id = any($1)', [created]);
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
