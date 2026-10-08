/// <reference types="node" />
import type { JobRow } from '@forge/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  Worker,
  type JobContext,
  type JobHandler,
  type JobOutcome,
  type WorkerOptions,
} from './worker.js';
import { FakeJobsDb } from './worker/fake-db.js';

const silent = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const instantSleep = async () => {
  await Promise.resolve();
};
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function handlerOf(fn: (job: JobRow, ctx: JobContext) => Promise<JobOutcome>) {
  return { handle: vi.fn(fn) } satisfies JobHandler;
}

const okHandler = () =>
  handlerOf(async (job) => {
    if (job.status === 'building') {
      return { patch: { preview_url: 'https://preview.example.com/x' } };
    }
    if (job.status === 'onchain_setup') return { patch: { owner_tx: 'AQAB' } };
    return {};
  });

const hangingHandler = () => handlerOf(() => new Promise<JobOutcome>(() => undefined));

function makeWorker(db: FakeJobsDb, handler: JobHandler, over: Partial<WorkerOptions> = {}) {
  const alerter = { alert: vi.fn(async () => undefined) };
  const logger = silent();
  const worker = new Worker({
    db,
    handler,
    logger,
    alerter,
    workerId: 'w1',
    sleep: instantSleep,
    now: () => db.clock,
    random: () => 0.5,
    ...over,
  });
  return { worker, alerter, logger };
}

describe('job pickup', () => {
  it('runs a paid job through building to preview_ready and releases the lock', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const { worker } = makeWorker(db, okHandler());
    expect(await worker.tick()).toBe(1);
    expect(db.get('j1')).toMatchObject({ status: 'building', locked_by: 'w1', attempts: 1 });
    await worker.idle();
    expect(db.get('j1')).toMatchObject({
      status: 'preview_ready',
      locked_by: null,
      locked_at: null,
      preview_url: 'https://preview.example.com/x',
    });
    expect(db.eventsFor('j1')).toEqual(['Starting your build', 'Preview ready']);
  });

  it('routes approved/owner_signed jobs per type', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'create', status: 'approved', type: 'create_launchpad' });
    db.addJob({ id: 'modify', status: 'approved', type: 'modify_launchpad' });
    db.addJob({ id: 'signed', status: 'owner_signed', type: 'create_launchpad' });
    const { worker } = makeWorker(db, okHandler(), { concurrency: 3 });
    expect(await worker.tick()).toBe(3);
    expect(db.get('create').status).toBe('onchain_setup');
    expect(db.get('modify').status).toBe('deploying');
    expect(db.get('signed').status).toBe('deploying');
    await worker.idle();
    expect(db.get('create')).toMatchObject({
      status: 'awaiting_owner_signature',
      owner_tx: 'AQAB',
      locked_by: null,
    });
    expect(db.get('modify')).toMatchObject({ status: 'live', locked_by: null });
    expect(db.get('signed').status).toBe('live');
  });

  it('serves post-approval jobs before new builds', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'build', status: 'paid' });
    db.addJob({ id: 'deploy', status: 'owner_signed' });
    const { worker } = makeWorker(db, okHandler(), { concurrency: 1 });
    await worker.tick();
    expect(db.get('deploy').locked_by).toBe('w1');
    expect(db.get('build').locked_by).toBeNull();
    await worker.idle();
  });

  it('two workers racing for one job: exactly one runs it', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'only' });
    const h1 = okHandler();
    const h2 = okHandler();
    const a = makeWorker(db, h1, { workerId: 'a' }).worker;
    const b = makeWorker(db, h2, { workerId: 'b' }).worker;
    const [na, nb] = await Promise.all([a.tick(), b.tick()]);
    expect(na + nb).toBe(1);
    await Promise.all([a.idle(), b.idle()]);
    expect(h1.handle.mock.calls.length + h2.handle.mock.calls.length).toBe(1);
    expect(db.get('only')).toMatchObject({ status: 'preview_ready', attempts: 1 });
  });

  it('two workers with several jobs never share a job', async () => {
    const db = new FakeJobsDb();
    for (let i = 0; i < 6; i++) db.addJob({ id: `j${i}` });
    const seen: string[] = [];
    const mk = () =>
      handlerOf(async (job) => {
        seen.push(job.id);
        return { patch: { preview_url: 'https://p.example.com' } };
      });
    const a = makeWorker(db, mk(), { workerId: 'a', concurrency: 4 }).worker;
    const b = makeWorker(db, mk(), { workerId: 'b', concurrency: 4 }).worker;
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.idle(), b.idle()]);
    expect(seen.sort()).toEqual(['j0', 'j1', 'j2', 'j3', 'j4', 'j5']);
  });

  it('respects the concurrency limit', async () => {
    const db = new FakeJobsDb();
    for (let i = 0; i < 3; i++) db.addJob({ id: `j${i}` });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler = handlerOf(async () => {
      await gate;
      return { patch: { preview_url: 'https://p.example.com' } };
    });
    const { worker } = makeWorker(db, handler, { concurrency: 2 });
    expect(await worker.tick()).toBe(2);
    expect(worker.activeJobs).toBe(2);
    expect(await worker.tick()).toBe(0);
    release();
    await worker.idle();
    expect(await worker.tick()).toBe(1);
    await worker.idle();
  });

  it('skips and alerts on a claim with an unexpected status', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.takeBuildJob = async () => ({ ...db.get('j1'), status: 'live' });
    const handler = okHandler();
    const { worker, alerter } = makeWorker(db, handler);
    await worker.tick();
    await worker.idle();
    expect(handler.handle).not.toHaveBeenCalled();
    expect(alerter.alert).toHaveBeenCalled();
  });
});

describe('failures and attempts', () => {
  it('retries a failed build once, then stops at max attempts', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const handler = handlerOf(async () => {
      throw new Error('npm build exploded');
    });
    const { worker, alerter } = makeWorker(db, handler);

    await worker.tick();
    await worker.idle();
    expect(db.get('j1')).toMatchObject({
      status: 'failed',
      failed_stage: 'build',
      attempts: 1,
      locked_by: null,
      locked_at: null,
      error: 'npm build exploded',
    });
    expect(alerter.alert).not.toHaveBeenCalled();

    // Automatic retry: take_build_job picks failed/build jobs with attempts < 2.
    await worker.tick();
    expect(db.get('j1')).toMatchObject({ status: 'building', attempts: 2, failed_stage: null });
    await worker.idle();
    expect(db.get('j1')).toMatchObject({ status: 'failed', failed_stage: 'build', attempts: 2 });
    expect(alerter.alert).toHaveBeenCalledTimes(1);
    expect(db.eventsFor('j1')).toContain(
      'We could not build your launchpad. Your payment will be refunded.',
    );
    expect(db.eventsFor('j1')).toContain('Restarting your build (attempt 2 of 2)');

    // Never picked up again.
    expect(await worker.tick()).toBe(0);
    expect(handler.handle).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['approved', 'create_launchpad', 'onchain'],
    ['owner_signed', 'create_launchpad', 'deploy'],
    ['approved', 'modify_launchpad', 'deploy'],
  ] as const)(
    'D18: %s/%s failure is final at stage %s, alert, no retry',
    async (status, type, stage) => {
      const db = new FakeJobsDb();
      db.addJob({ id: 'j1', status, type, attempts: 1 });
      const handler = handlerOf(async () => {
        throw new Error('signer returned 500');
      });
      const { worker, alerter } = makeWorker(db, handler);
      await worker.tick();
      await worker.idle();
      expect(db.get('j1')).toMatchObject({
        status: 'failed',
        failed_stage: stage,
        locked_by: null,
        locked_at: null,
        attempts: 1,
      });
      expect(alerter.alert).toHaveBeenCalledWith(
        'high',
        `job_failed_${stage}:j1`,
        expect.stringContaining('manual handling'),
        expect.anything(),
      );
      for (let i = 0; i < 3; i++) expect(await worker.tick()).toBe(0);
      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(db.eventsFor('j1').at(-1)).toContain('handle it manually');
    },
  );

  it('does not pick up failed jobs that must not be retried automatically', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1', status: 'failed', failed_stage: 'build', attempts: 2 });
    db.addJob({ id: 'j2', status: 'failed', failed_stage: 'onchain', attempts: 1 });
    db.addJob({ id: 'j3', status: 'failed', failed_stage: 'deploy', attempts: 0 });
    const { worker } = makeWorker(db, okHandler());
    expect(await worker.tick()).toBe(0);
  });

  it('fails the step when the handler returns no preview_url / owner_tx', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'b' });
    db.addJob({ id: 'o', status: 'approved' });
    const { worker } = makeWorker(
      db,
      handlerOf(async () => ({})),
      { concurrency: 2 },
    );
    await worker.tick();
    await worker.idle();
    expect(db.get('b')).toMatchObject({ status: 'failed', failed_stage: 'build' });
    expect(db.get('o')).toMatchObject({ status: 'failed', failed_stage: 'onchain' });
  });

  it('redacts secrets from the stored error', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const handler = handlerOf(async () => {
      throw new Error(
        'push failed: Authorization: Bearer ghs_abcdefghijklmnop123456 api_key=sk-ant-abcdefghijkl',
      );
    });
    const { worker } = makeWorker(db, handler);
    await worker.tick();
    await worker.idle();
    const error = db.get('j1').error ?? '';
    expect(error).not.toContain('ghs_');
    expect(error).not.toContain('sk-ant');
    expect(error).toContain('push failed');
  });

  it('retries a transient database error when recording the result', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.failNext('completeStep', 2);
    const { worker } = makeWorker(db, okHandler());
    await worker.tick();
    await worker.idle();
    expect(db.get('j1').status).toBe('preview_ready');
  });

  it('leaves the lock to stale recovery when the result cannot be recorded', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1', status: 'approved' });
    db.failNext('completeStep', 99);
    const { worker, alerter } = makeWorker(db, okHandler(), { persistAttempts: 3 });
    await worker.tick();
    await worker.idle();
    expect(db.get('j1')).toMatchObject({ status: 'onchain_setup', locked_by: 'w1' });
    expect(alerter.alert).toHaveBeenCalled();
    // Nobody heartbeats any more: stale recovery fails it for manual handling.
    db.clock += 46 * 60_000;
    await worker.tick();
    expect(db.get('j1')).toMatchObject({ status: 'failed', failed_stage: 'onchain' });
  });

  it('keeps going when job events cannot be written', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.failNext('appendEvent', 99);
    const { worker } = makeWorker(db, okHandler());
    await worker.tick();
    await worker.idle();
    expect(db.get('j1').status).toBe('preview_ready');
  });
});

describe('stale locks and crashed jobs', () => {
  it('fails stale active jobs with the stage of their status and alerts', async () => {
    const db = new FakeJobsDb();
    const old = new Date(db.clock - 50 * 60_000).toISOString();
    const fresh = new Date(db.clock - 5 * 60_000).toISOString();
    db.addJob({ id: 'b', status: 'building', attempts: 2, locked_by: 'dead', locked_at: old });
    db.addJob({ id: 'o', status: 'onchain_setup', locked_by: 'dead', locked_at: old });
    db.addJob({ id: 'd', status: 'deploying', locked_by: 'dead', locked_at: old });
    db.addJob({ id: 'ok', status: 'building', locked_by: 'alive', locked_at: fresh });
    const { worker, alerter } = makeWorker(db, okHandler());
    await worker.tick();
    expect(db.get('b')).toMatchObject({ status: 'failed', failed_stage: 'build', locked_by: null });
    expect(db.get('o')).toMatchObject({
      status: 'failed',
      failed_stage: 'onchain',
      locked_at: null,
    });
    expect(db.get('d')).toMatchObject({ status: 'failed', failed_stage: 'deploy' });
    expect(db.get('ok')).toMatchObject({ status: 'building', locked_by: 'alive' });
    expect(alerter.alert).toHaveBeenCalledTimes(3);
    expect(db.eventsFor('o').at(-1)).toContain('handle it manually');
    // Money steps are not retried, nor is a build whose attempts are exhausted.
    expect(await worker.tick()).toBe(0);
  });

  it('a stale build with attempts left is retried automatically', async () => {
    const db = new FakeJobsDb();
    const old = new Date(db.clock - 60 * 60_000).toISOString();
    db.addJob({ id: 'b', status: 'building', attempts: 1, locked_by: 'dead', locked_at: old });
    const { worker } = makeWorker(db, okHandler());
    await worker.tick();
    expect(db.get('b')).toMatchObject({ status: 'building', attempts: 2, locked_by: 'w1' });
    await worker.idle();
    expect(db.get('b').status).toBe('preview_ready');
  });

  it('rate limits stale recovery', async () => {
    const db = new FakeJobsDb();
    const { worker } = makeWorker(db, okHandler());
    await worker.tick();
    await worker.tick();
    expect(db.calls.filter((c) => c === 'failStaleJobs')).toHaveLength(1);
    db.clock += 61_000;
    await worker.tick();
    expect(db.calls.filter((c) => c === 'failStaleJobs')).toHaveLength(2);
  });

  it('crash mid-job: a hung handler is cut by the hard timeout and failed', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1', status: 'owner_signed' });
    const { worker, alerter } = makeWorker(db, hangingHandler(), {
      maxJobMs: 20,
      heartbeatIntervalMs: 5,
    });
    await worker.tick();
    await worker.idle();
    expect(db.get('j1')).toMatchObject({
      status: 'failed',
      failed_stage: 'deploy',
      locked_by: null,
    });
    expect(db.get('j1').error).toContain('maximum duration');
    expect(alerter.alert).toHaveBeenCalled();
  });

  it('heartbeat keeps the lock fresh while a job runs', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const start = db.clock;
    const handler = handlerOf(async () => {
      db.clock += 10 * 60_000;
      await realSleep(60);
      return { patch: { preview_url: 'https://p.example.com' } };
    });
    const { worker } = makeWorker(db, handler, { heartbeatIntervalMs: 10 });
    await worker.tick();
    await realSleep(35);
    expect(Date.parse(db.get('j1').locked_at ?? '')).toBeGreaterThan(start);
    await worker.idle();
    expect(db.calls).toContain('heartbeat');
  });

  it('lock lost: the handler is aborted and the foreign state is not overwritten', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    let sawAbort = false;
    const handler = handlerOf(
      (_job, ctx) =>
        new Promise<JobOutcome>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const { worker } = makeWorker(db, handler, { heartbeatIntervalMs: 5 });
    await worker.tick();
    // Stale recovery by someone else.
    const job = db.get('j1');
    job.status = 'failed';
    job.failed_stage = 'build';
    job.locked_by = null;
    job.locked_at = null;
    job.error = 'stale lock: elsewhere';
    await worker.idle();
    expect(sawAbort).toBe(true);
    expect(db.get('j1')).toMatchObject({ status: 'failed', error: 'stale lock: elsewhere' });
  });
});

describe('deploys_paused kill switch', () => {
  it('picks nothing up while paused and resumes after the flag is cleared', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.flags.set('deploys_paused', true);
    const { worker } = makeWorker(db, okHandler(), { flagCacheMs: 30_000 });
    expect(await worker.tick()).toBe(0);
    expect(db.calls).not.toContain('takeBuildJob');
    expect(db.calls).not.toContain('takePostApprovalJob');

    db.flags.set('deploys_paused', false);
    // The cached value still applies.
    expect(await worker.tick()).toBe(0);
    db.clock += 31_000;
    expect(await worker.tick()).toBe(1);
    await worker.idle();
  });

  it('lets running jobs finish when paused mid-flight', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler = handlerOf(async () => {
      await gate;
      return { patch: { preview_url: 'https://p.example.com' } };
    });
    const { worker } = makeWorker(db, handler);
    await worker.tick();
    db.flags.set('deploys_paused', true);
    release();
    await worker.idle();
    expect(db.get('j1').status).toBe('preview_ready');
  });

  it('fails closed when the flag cannot be read', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.failNext('getFlag', 1);
    const { worker } = makeWorker(db, okHandler());
    await expect(worker.tick()).rejects.toThrow('connection reset');
    expect(db.calls).not.toContain('takeBuildJob');
    expect(await worker.tick()).toBe(1);
    await worker.idle();
  });
});

describe('polling loop', () => {
  /** Runs the loop with an instant sleep, until `n` sleeps happened; returns the delays. */
  async function runLoopFor(n: number, db: FakeJobsDb, over: Partial<WorkerOptions>) {
    const delays: number[] = [];
    let reached!: () => void;
    const enough = new Promise<void>((r) => (reached = r));
    const made = makeWorker(db, okHandler(), {
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= n) {
          reached();
          await realSleep(2_000);
        }
        await Promise.resolve();
      },
      ...over,
    });
    made.worker.start();
    await enough;
    await made.worker.stop();
    return { delays, ...made };
  }

  it('backs off exponentially on database errors, then polls with jitter', async () => {
    const db = new FakeJobsDb();
    db.failNext('getFlag', 3);
    const { delays } = await runLoopFor(4, db, {
      random: () => 1,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      pollIntervalMs: 1_000,
      pollJitterRatio: 0.2,
    });
    // random() = 1: equal-jitter backoff is the full delay; poll delay is interval * 1.2.
    expect(delays).toEqual([100, 200, 400, 1200]);
  });

  it('caps the backoff', async () => {
    const db = new FakeJobsDb();
    db.failNext('getFlag', 99);
    const { delays } = await runLoopFor(6, db, {
      random: () => 1,
      backoffBaseMs: 100,
      backoffMaxMs: 500,
    });
    expect(delays).toEqual([100, 200, 400, 500, 500, 500]);
  });

  it('spreads the poll delay by the jitter ratio', async () => {
    const low = await runLoopFor(1, new FakeJobsDb(), {
      random: () => 0,
      pollIntervalMs: 1_000,
      pollJitterRatio: 0.2,
    });
    const high = await runLoopFor(1, new FakeJobsDb(), {
      random: () => 1,
      pollIntervalMs: 1_000,
      pollJitterRatio: 0.2,
    });
    expect([low.delays[0], high.delays[0]]).toEqual([800, 1200]);
  });

  it('alerts after repeated database errors', async () => {
    const db = new FakeJobsDb();
    db.failNext('getFlag', 99);
    const { alerter } = await runLoopFor(6, db, {});
    expect(alerter.alert).toHaveBeenCalledWith(
      'high',
      'builder_db_errors',
      expect.any(String),
      expect.anything(),
    );
  });

  it('an idle loop wakes up on stop() even with a long poll interval', async () => {
    const db = new FakeJobsDb();
    const { worker } = makeWorker(db, okHandler(), { sleep: realSleep, pollIntervalMs: 60_000 });
    worker.start();
    await realSleep(10);
    const t = Date.now();
    await worker.stop();
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it('processes jobs end to end through the loop', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    db.addJob({ id: 'j2', status: 'owner_signed' });
    const { worker } = makeWorker(db, okHandler(), {
      sleep: (ms) => realSleep(Math.min(ms, 5)),
      concurrency: 2,
    });
    worker.start();
    for (let i = 0; i < 100 && db.get('j2').status !== 'live'; i++) await realSleep(5);
    await worker.stop();
    expect(db.get('j1').status).toBe('preview_ready');
    expect(db.get('j2').status).toBe('live');
  });
});

describe('graceful shutdown', () => {
  it('lets a running job finish within the grace period', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const handler = handlerOf(async () => {
      await realSleep(20);
      return { patch: { preview_url: 'https://p.example.com' } };
    });
    const { worker } = makeWorker(db, handler, { sleep: realSleep, shutdownGraceMs: 2_000 });
    await worker.tick();
    await worker.stop();
    expect(db.get('j1').status).toBe('preview_ready');
  });

  it('releases a running build to the queue without consuming an attempt', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const handler = handlerOf(
      (_job, ctx) =>
        new Promise<JobOutcome>((_res, rej) =>
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    );
    const { worker } = makeWorker(db, handler, { sleep: realSleep, shutdownGraceMs: 10 });
    await worker.tick();
    expect(db.get('j1').attempts).toBe(1);
    await worker.stop();
    expect(db.get('j1')).toMatchObject({
      status: 'paid',
      attempts: 0,
      locked_by: null,
      locked_at: null,
    });
    // Another worker picks it up as a first attempt.
    const other = makeWorker(db, okHandler(), { workerId: 'w2' }).worker;
    await other.tick();
    await other.idle();
    expect(db.get('j1')).toMatchObject({ status: 'preview_ready', attempts: 1 });
  });

  it('D18: a money step cut by shutdown is failed for manual handling, never released', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1', status: 'approved' });
    const { worker, alerter } = makeWorker(db, hangingHandler(), {
      sleep: realSleep,
      shutdownGraceMs: 10,
    });
    await worker.tick();
    await worker.stop();
    expect(db.get('j1')).toMatchObject({
      status: 'failed',
      failed_stage: 'onchain',
      locked_by: null,
    });
    expect(alerter.alert).toHaveBeenCalled();
    expect(db.calls).not.toContain('releaseBuild');
    // Not picked up again by anyone.
    const other = makeWorker(db, okHandler(), { workerId: 'w9' }).worker;
    expect(await other.tick()).toBe(0);
  });

  it('does not claim anything after stop()', async () => {
    const db = new FakeJobsDb();
    db.addJob({ id: 'j1' });
    const { worker } = makeWorker(db, okHandler());
    await worker.stop();
    expect(await worker.tick()).toBe(0);
    expect(db.get('j1').status).toBe('paid');
  });
});

describe('options', () => {
  it('rejects a heartbeat period that is not far below the stale delay', () => {
    expect(() =>
      makeWorker(new FakeJobsDb(), okHandler(), { heartbeatIntervalMs: 20 * 60_000 }),
    ).toThrow();
  });

  it('rejects a bad concurrency', () => {
    expect(() => makeWorker(new FakeJobsDb(), okHandler(), { concurrency: 0 })).toThrow();
  });
});
