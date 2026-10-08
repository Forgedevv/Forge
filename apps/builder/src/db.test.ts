/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseJobsDb } from './db.js';

const KEY = 'service-role-key-value-1234567890';
const URL_BASE = 'https://proj.supabase.co';

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    launchpad_id: '22222222-2222-4222-8222-222222222222',
    type: 'create_launchpad',
    status: 'building',
    attempts: 1,
    failed_stage: null,
    locked_by: 'w1',
    locked_at: '2026-01-01T12:00:00Z',
    preview_url: null,
    ...over,
  };
}

function setup(responder: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => responder(url, init));
  const db = createSupabaseJobsDb({
    url: `${URL_BASE}/`,
    serviceRoleKey: KEY,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => new Date('2026-01-01T12:30:00Z'),
  });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
    return {
      url,
      init,
      body: init.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
  };
  return { db, fetchMock, call };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createSupabaseJobsDb', () => {
  it('calls the pickup RPCs with the worker id and the service role headers', async () => {
    const { db, call } = setup(() => json([jobRow()]));
    const job = await db.takeBuildJob('w1');
    expect(job?.status).toBe('building');
    await db.takePostApprovalJob('w1');
    const a = call(0);
    expect(a.url).toBe(`${URL_BASE}/rest/v1/rpc/take_build_job`);
    expect(a.init.method).toBe('POST');
    expect(a.body).toEqual({ worker: 'w1' });
    const headers = a.init.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call(1).url).toBe(`${URL_BASE}/rest/v1/rpc/take_post_approval_job`);
  });

  it('returns null when nothing is available', async () => {
    const { db } = setup(() => json([]));
    expect(await db.takeBuildJob('w1')).toBeNull();
  });

  it('rejects malformed rows and more than one row', async () => {
    await expect(setup(() => json([{ id: 'x' }])).db.takeBuildJob('w1')).rejects.toThrow('shape');
    await expect(
      setup(() => json([jobRow(), jobRow({ id: 'b' })])).db.takeBuildJob('w1'),
    ).rejects.toThrow('more than one');
    await expect(setup(() => json({ nope: true })).db.takeBuildJob('w1')).rejects.toThrow('shape');
  });

  it('calls fail_stale_jobs with the delay', async () => {
    const { db, call } = setup(() => json([jobRow({ status: 'failed', failed_stage: 'build' })]));
    const rows = await db.failStaleJobs(45);
    expect(rows).toHaveLength(1);
    expect(call().url).toBe(`${URL_BASE}/rest/v1/rpc/fail_stale_jobs`);
    expect(call().body).toEqual({ stale_minutes: 45 });
    await expect(db.failStaleJobs(0)).rejects.toThrow();
  });

  it('completes a step with a conditional update that resets the lock', async () => {
    const { db, call } = setup(() => json([jobRow({ status: 'preview_ready' })]));
    const row = await db.completeStep('job-1', 'w1', 'building', 'preview_ready', {
      preview_url: 'https://p.example.com',
    });
    expect(row?.status).toBe('preview_ready');
    const c = call();
    expect(c.init.method).toBe('PATCH');
    expect(c.url).toBe(`${URL_BASE}/rest/v1/jobs?id=eq.job-1&locked_by=eq.w1&status=eq.building`);
    expect((c.init.headers as Record<string, string>).prefer).toBe('return=representation');
    expect(c.body).toEqual({
      preview_url: 'https://p.example.com',
      status: 'preview_ready',
      locked_by: null,
      locked_at: null,
    });
  });

  it('returns null when the conditional update matched nothing (lock lost)', async () => {
    const { db } = setup(() => json([]));
    expect(await db.completeStep('j', 'w1', 'building', 'preview_ready', {})).toBeNull();
    expect(await db.failJob('j', 'w1', 'deploying', 'deploy', 'x')).toBeNull();
    expect(await db.releaseBuild('j', 'w1', 1)).toBeNull();
    expect(await db.heartbeat('j', 'w1')).toBe(false);
  });

  it('fails a job with its stage and resets the lock', async () => {
    const { db, call } = setup(() => json([jobRow({ status: 'failed' })]));
    await db.failJob('job-1', 'w1', 'onchain_setup', 'onchain', 'boom');
    expect(call().url).toContain('status=eq.onchain_setup');
    expect(call().body).toEqual({
      status: 'failed',
      failed_stage: 'onchain',
      error: 'boom',
      locked_by: null,
      locked_at: null,
    });
  });

  it('releases a build without consuming the attempt', async () => {
    const { db, call } = setup(() => json([jobRow({ status: 'paid' })]));
    await db.releaseBuild('job-1', 'w1', 2);
    expect(call().body).toEqual({
      status: 'paid',
      attempts: 1,
      locked_by: null,
      locked_at: null,
    });
  });

  it('refreshes the heartbeat only for active statuses held by the worker', async () => {
    const { db, call } = setup(() => json([jobRow()]));
    expect(await db.heartbeat('job-1', 'w1')).toBe(true);
    expect(decodeURIComponent(call().url)).toContain(
      'status=in.(building,onchain_setup,deploying)',
    );
    expect(call().url).toContain('locked_by=eq.w1');
    expect(call().body).toEqual({ locked_at: '2026-01-01T12:30:00.000Z' });
  });

  it('appends job events', async () => {
    const { db, call } = setup(() => new Response(null, { status: 201 }));
    await db.appendEvent('job-1', 'Preview ready');
    expect(call().url).toBe(`${URL_BASE}/rest/v1/job_events`);
    expect(call().body).toEqual({ job_id: 'job-1', message: 'Preview ready' });
  });

  it('reads flags; a missing row is not paused', async () => {
    const paused = setup(() => json([{ value: true }]));
    expect(await paused.db.getFlag('deploys_paused')).toBe(true);
    expect(paused.call().url).toBe(`${URL_BASE}/rest/v1/flags?key=eq.deploys_paused&select=value`);
    expect(await setup(() => json([])).db.getFlag('deploys_paused')).toBe(false);
    await expect(
      setup(() => json([{ value: 'yes' }])).db.getFlag('deploys_paused'),
    ).rejects.toThrow();
  });

  it('never leaks the service key in errors', async () => {
    const http = setup(() => new Response('{"message":"permission denied"}', { status: 401 }));
    const err = await http.db.takeBuildJob('w1').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(KEY);

    const net = createSupabaseJobsDb({
      url: URL_BASE,
      serviceRoleKey: KEY,
      fetch: (async () => {
        throw new TypeError(`fetch failed for ${URL_BASE} with ${KEY}`);
      }) as unknown as typeof fetch,
    });
    const err2 = await net.takeBuildJob('w1').catch((e: unknown) => e as Error);
    expect((err2 as Error).message).not.toContain(KEY);
  });

  it('validates its configuration', () => {
    expect(() => createSupabaseJobsDb({ url: 'ftp://x', serviceRoleKey: KEY })).toThrow();
    expect(() => createSupabaseJobsDb({ url: URL_BASE, serviceRoleKey: '' })).toThrow();
  });
});
