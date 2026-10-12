// @vitest-environment node
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJobsHandlers, type JobsHandlers } from '../handlers';
import { createOwnerTransactionService } from '../owner-transaction';
import { createJobsService } from '../service';
import { ctx, harness, request, type MemoryRoutesStore } from './fakes';

const owner = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();

let h: ReturnType<typeof harness>;
let handlers: JobsHandlers;

function setup() {
  h = harness();
  handlers = createJobsHandlers({
    jobs: createJobsService({ store: h.store, logger: h.logger }),
    ownerTransactions: createOwnerTransactionService({
      store: h.store,
      chain: h.chain,
      logger: h.logger,
    }),
    rateLimiter: h.rateLimiter,
    logger: h.logger,
  });
}

function seed(store: MemoryRoutesStore, status: Parameters<MemoryRoutesStore['addJob']>[1] = {}) {
  const launchpad = store.addLaunchpad(owner, { status: 'draft' });
  const job = store.addJob(launchpad.id, status);
  return { launchpad, job };
}

beforeEach(setup);

describe('GET /api/jobs/:id', () => {
  it('returns the job and its events to the owner, without owner_tx', async () => {
    const { job } = seed(h.store, {
      status: 'building',
      ownerTx: 'secret-ish',
      ownerTxDetails: { creator: 'stored-details' },
    });
    await h.store.addJobEvent(job.id, 'Build started.');
    const res = await handlers.getJob(
      request('GET', `/api/jobs/${job.id}`, { wallet: owner }),
      ctx(job.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      job: Record<string, unknown>;
      events: { message: string }[];
    };
    expect(body.job).toMatchObject({ id: job.id, status: 'building', type: 'create_launchpad' });
    expect(body.job).not.toHaveProperty('ownerTx');
    expect(body.job).not.toHaveProperty('ownerTxDetails');
    expect(JSON.stringify(body)).not.toContain('secret-ish');
    expect(JSON.stringify(body)).not.toContain('stored-details');
    expect(body.events.map((e) => e.message)).toEqual(['Build started.']);
  });

  it('answers 404 to another wallet, exactly like an unknown job', async () => {
    const { job } = seed(h.store);
    const res = await handlers.getJob(
      request('GET', `/api/jobs/${job.id}`, { wallet: other }),
      ctx(job.id),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Job not found.' });
  });

  it('requires a session and rejects cross-site requests and malformed ids', async () => {
    const { job } = seed(h.store);
    const anon = await handlers.getJob(request('GET', `/api/jobs/${job.id}`), ctx(job.id));
    expect(anon.status).toBe(401);
    const cross = await handlers.getJob(
      request('GET', `/api/jobs/${job.id}`, {
        wallet: owner,
        headers: { origin: 'https://evil.example' },
      }),
      ctx(job.id),
    );
    expect(cross.status).toBe(403);
    const bad = await handlers.getJob(
      request('GET', '/api/jobs/x', { wallet: owner }),
      ctx('not-a-uuid'),
    );
    expect(bad.status).toBe(404);
  });

  it('includes the refund of a refunded job', async () => {
    const { job } = seed(h.store, { status: 'refunded' });
    h.store.refunds.push({
      jobId: job.id,
      lamports: 300_000_000n,
      signature: 'refundSig',
      payerWallet: owner,
    });
    const res = await handlers.getJob(
      request('GET', `/api/jobs/${job.id}`, { wallet: owner }),
      ctx(job.id),
    );
    const body = (await res.json()) as { job: { refund: unknown } };
    expect(body.job.refund).toEqual({ lamports: '300000000', signature: 'refundSig' });
  });

  it('rate limits per wallet', async () => {
    const { job } = seed(h.store);
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await handlers.getJob(
        request('GET', `/api/jobs/${job.id}`, {
          wallet: owner,
          headers: { 'x-real-ip': `10.0.0.${i}` },
        }),
        ctx(job.id),
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /api/jobs/:id/approve', () => {
  const approve = (jobId: string, wallet: string | null = owner) =>
    handlers.approve(request('POST', `/api/jobs/${jobId}/approve`, { wallet }), ctx(jobId));

  it('moves preview_ready to approved once and records an event', async () => {
    const { job } = seed(h.store, { status: 'preview_ready', previewUrl: 'https://p.example' });
    const first = await approve(job.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'approved' });
    const again = await approve(job.id);
    expect(await again.json()).toEqual({ status: 'approved' });
    expect(h.store.status(job.id)).toBe('approved');
    expect(h.store.events.filter((e) => e.jobId === job.id)).toHaveLength(1);
  });

  it('is idempotent for a job already further along', async () => {
    const { job } = seed(h.store, { status: 'onchain_setup' });
    const res = await approve(job.id);
    expect(await res.json()).toEqual({ status: 'onchain_setup' });
    expect(h.store.events).toHaveLength(0);
  });

  it('refuses another wallet without touching the job', async () => {
    const { job } = seed(h.store, { status: 'preview_ready' });
    const res = await approve(job.id, other);
    expect(res.status).toBe(404);
    expect(h.store.status(job.id)).toBe('preview_ready');
  });

  it('refuses a job without a preview to approve', async () => {
    for (const status of ['spec_ready', 'paid', 'building', 'failed', 'refunded'] as const) {
      const { job } = seed(h.store, { status });
      const res = await approve(job.id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'INVALID_STATUS', status });
      expect(h.store.status(job.id)).toBe(status);
    }
  });

  it('refuses a disabled launchpad', async () => {
    const launchpad = h.store.addLaunchpad(owner, { status: 'disabled' });
    const job = h.store.addJob(launchpad.id, { status: 'preview_ready' });
    const res = await approve(job.id);
    expect(res.status).toBe(403);
    expect(h.store.status(job.id)).toBe('preview_ready');
  });

  it('settles a concurrent approval to the same answer', async () => {
    const { job } = seed(h.store, { status: 'preview_ready' });
    h.store.beforeTransition = (id) => {
      h.store.jobs.set(id, { ...h.store.jobs.get(id)!, status: 'approved' });
      h.store.beforeTransition = null;
    };
    const res = await approve(job.id);
    expect(await res.json()).toEqual({ status: 'approved' });
    expect(h.store.events).toHaveLength(0);
  });

  it('requires a session and a same-site origin', async () => {
    const { job } = seed(h.store, { status: 'preview_ready' });
    expect((await approve(job.id, null)).status).toBe(401);
    const cross = await handlers.approve(
      request('POST', `/api/jobs/${job.id}/approve`, {
        wallet: owner,
        headers: { origin: 'https://evil.example' },
      }),
      ctx(job.id),
    );
    expect(cross.status).toBe(403);
    expect(h.store.status(job.id)).toBe('preview_ready');
  });

  it('answers 503 without details when the store fails', async () => {
    const { job } = seed(h.store, { status: 'preview_ready' });
    h.store.getOwnedJob = () => Promise.reject(new Error('db down: postgres://user:pass@host'));
    const res = await approve(job.id);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('postgres');
    expect(JSON.stringify(h.logger.entries)).not.toContain('postgres');
  });
});
