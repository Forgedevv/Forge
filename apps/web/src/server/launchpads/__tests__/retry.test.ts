// @vitest-environment node
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, request, spec } from '../../jobs/__tests__/fakes';
import { StoreError, type JobPaymentRecord, type JobRecord } from '../../jobs/store';
import { launchpadQuotas } from '../quotas';
import { START_AGAIN_POLICY } from '../retry';
import { NOW, launchpadsHarness } from './helpers';

const owner = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const SIG = '5'.repeat(88);

let h: ReturnType<typeof launchpadsHarness>;

beforeEach(() => {
  h = launchpadsHarness();
});

const retry = (id: string, wallet: string | null = owner, headers: Record<string, string> = {}) =>
  h.handlers.retry(request('POST', `/api/launchpads/${id}/retry`, { wallet, headers }), ctx(id));

function creationJobs(launchpadId: string): JobRecord[] {
  return [...h.store.jobs.values()].filter(
    (j) => j.launchpadId === launchpadId && j.type === 'create_launchpad',
  );
}

function payment(jobId: string, overrides: Partial<JobPaymentRecord> = {}): JobPaymentRecord {
  const record: JobPaymentRecord = {
    jobId,
    status: 'refunded',
    txSignature: SIG,
    refundSignature: '4'.repeat(88),
    quoteExpiresAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    ...overrides,
  };
  h.store.payments.push(record);
  return record;
}

/** A draft whose creation failed twice and was refunded (the devnet case). */
function refundedDraft() {
  const lp = h.store.addLaunchpad(owner, { status: 'draft', slug: 'moonpad' });
  const refunded = h.store.addJob(lp.id, {
    status: 'refunded',
    failedStage: 'build',
    attempts: 2,
  });
  payment(refunded.id);
  return { lp, refunded };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /api/launchpads/:id/retry', () => {
  it('starts a refunded draft again: a new creation job awaiting payment, same launchpad', async () => {
    const { lp, refunded } = refundedDraft();
    const res = await retry(lp.id);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).not.toBe(refunded.id);
    expect(h.store.jobs.get(jobId)).toMatchObject({
      launchpadId: lp.id,
      type: 'create_launchpad',
      status: 'spec_ready',
      attempts: 0,
    });
    // The refunded job and the launchpad (slug, spec) are left as they were.
    expect(h.store.jobs.get(refunded.id)!.status).toBe('refunded');
    expect(h.store.launchpads.get(lp.id)).toMatchObject({ status: 'draft', slug: 'moonpad' });
    expect(h.store.events).toEqual([expect.objectContaining({ jobId })]);
    expect(h.logger.events()).toContain('retry.created');
  });

  it('is idempotent: the job still awaiting payment is returned again', async () => {
    const { lp } = refundedDraft();
    const first = (await (await retry(lp.id)).json()) as { jobId: string };
    const again = await retry(lp.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ jobId: first.jobId });
    expect(creationJobs(lp.id)).toHaveLength(2);
    expect(h.store.events).toHaveLength(1);
  });

  it('returns the first creation job when it was simply never paid', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'draft' });
    const unpaid = h.store.addJob(lp.id);
    const res = await retry(lp.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: unpaid.id });
    expect(creationJobs(lp.id)).toHaveLength(1);
  });

  it("is reserved to the owner's session and same-site requests", async () => {
    const { lp } = refundedDraft();
    expect((await retry(lp.id, other)).status).toBe(404);
    expect((await retry(lp.id, null)).status).toBe(401);
    const crossSite = await retry(lp.id, owner, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);
    expect((await retry('not-a-uuid')).status).toBe(404);
    expect(creationJobs(lp.id)).toHaveLength(1);
  });

  it('applies the private beta to the session, like every signed-in route', async () => {
    const { lp } = refundedDraft();
    vi.stubEnv('FORGE_BETA_MODE', 'on');
    vi.stubEnv('FORGE_BETA_ALLOWLIST', other);
    try {
      const res = await retry(lp.id);
      expect(res.status).toBe(403);
      expect(await body(res)).toMatchObject({ code: 'BETA_NOT_INVITED' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(creationJobs(lp.id)).toHaveLength(1);
  });

  it('only starts again a draft: never a live, sleeping or disabled launchpad', async () => {
    for (const status of ['live', 'sleeping'] as const) {
      const lp = h.store.addLaunchpad(owner, { status });
      h.store.addJob(lp.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
      h.store.addJob(lp.id, { status: 'live' });
      const res = await retry(lp.id);
      expect(res.status).toBe(409);
      expect(await body(res)).toMatchObject({ code: 'INVALID_STATUS', status });
      expect(creationJobs(lp.id)).toHaveLength(2);
    }
    const disabled = h.store.addLaunchpad(owner, { status: 'disabled' });
    h.store.addJob(disabled.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
    const res = await retry(disabled.id);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'LAUNCHPAD_DISABLED' });
    expect(creationJobs(disabled.id)).toHaveLength(1);
  });

  it('refuses a draft that never had a creation job', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'draft' });
    const res = await retry(lp.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'INVALID_STATUS' });
    expect(creationJobs(lp.id)).toHaveLength(0);
  });

  it('never starts again while the creation is in progress', async () => {
    for (const status of ['paid', 'building', 'preview_ready', 'onchain_setup'] as const) {
      const lp = h.store.addLaunchpad(owner, { status: 'draft' });
      h.store.addJob(lp.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
      const busy = h.store.addJob(lp.id, { status });
      const res = await retry(lp.id);
      expect(res.status).toBe(409);
      expect(await body(res)).toMatchObject({ code: 'CREATION_IN_PROGRESS', jobId: busy.id });
      expect(creationJobs(lp.id)).toHaveLength(2);
    }
  });

  it('never allows a second payment while the refund is pending', async () => {
    // Build failed once: the builder retries it by itself.
    const retrying = h.store.addLaunchpad(owner, { status: 'draft' });
    const first = h.store.addJob(retrying.id, {
      status: 'failed',
      failedStage: 'build',
      attempts: 1,
    });
    let res = await retry(retrying.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'CREATION_IN_PROGRESS', jobId: first.id });

    // Both attempts failed: the signer has not refunded the payment yet.
    const exhausted = h.store.addLaunchpad(owner, { status: 'draft' });
    const failed = h.store.addJob(exhausted.id, {
      status: 'failed',
      failedStage: 'build',
      attempts: 2,
    });
    payment(failed.id, { status: 'confirmed', refundSignature: null });
    res = await retry(exhausted.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'REFUND_PENDING', jobId: failed.id });

    // A failure after approval is handled by the team (never refunded automatically, D18).
    const manual = h.store.addLaunchpad(owner, { status: 'draft' });
    const onchain = h.store.addJob(manual.id, { status: 'failed', failedStage: 'onchain' });
    res = await retry(manual.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'NEEDS_SUPPORT', jobId: onchain.id });
    expect(String((await retry(manual.id).then(body)).message)).toMatch(/support/i);

    for (const lp of [retrying, exhausted, manual]) expect(creationJobs(lp.id)).toHaveLength(1);
  });

  it('leaves to the team a draft whose on-chain setup already started', async () => {
    // A failure after approval refunded by hand: configs (or the coin) may exist (D18).
    for (const field of ['launchpadConfig', 'launchpadCoinConfig', 'launchpadCoinMint'] as const) {
      const lp = h.store.addLaunchpad(owner, {
        status: 'draft',
        [field]: Keypair.generate().publicKey.toBase58(),
      });
      h.store.addJob(lp.id, { status: 'refunded', failedStage: 'onchain' });
      const res = await retry(lp.id);
      expect(res.status, field).toBe(409);
      const answer = await body(res);
      expect(answer.code, field).toBe('NEEDS_SUPPORT');
      expect(String(answer.message), field).toMatch(/support/i);
      expect(creationJobs(lp.id), field).toHaveLength(1);
    }
  });

  it('checks the money of the refunded attempts before a new payment', async () => {
    const cases: [string, Partial<JobPaymentRecord> | 'anomaly', string][] = [
      // The job says refunded but the payment is still confirmed (refund in flight or lost).
      ['confirmed', { status: 'confirmed' }, 'REFUND_PENDING'],
      [
        'refund in flight',
        { status: 'confirmed', refundSignature: '3'.repeat(88) },
        'REFUND_PENDING',
      ],
      // Money held for a manual refund (late or duplicate payment, migration 0008).
      ['open anomaly', 'anomaly', 'REFUND_PENDING'],
      // A payment sent for the old job and never settled.
      ['sent quote', { status: 'quoted', refundSignature: null }, 'PAYMENT_PENDING'],
      // A quote that may still be paid (or confirmed) in its grace window.
      [
        'open quote',
        {
          status: 'quoted',
          txSignature: null,
          refundSignature: null,
          quoteExpiresAt: new Date(NOW - 5 * 60_000).toISOString(),
        },
        'PAYMENT_PENDING',
      ],
    ];
    for (const [name, change, code] of cases) {
      const { lp, refunded } = refundedDraft();
      if (change === 'anomaly') h.store.anomalies.push({ jobId: refunded.id, resolved: false });
      else payment(refunded.id, change);
      const res = await retry(lp.id);
      expect(res.status, name).toBe(409);
      expect((await body(res)).code, name).toBe(code);
      expect(creationJobs(lp.id), name).toHaveLength(1);
      h.store.launchpads.delete(lp.id);
    }

    // Settled: an expired quote long past its window, a resolved anomaly.
    const { lp, refunded } = refundedDraft();
    payment(refunded.id, { status: 'expired', txSignature: null, refundSignature: null });
    payment(refunded.id, { status: 'quoted', txSignature: null, refundSignature: null });
    h.store.anomalies.push({ jobId: refunded.id, resolved: true });
    expect((await retry(lp.id)).status).toBe(201);
  });

  it('looks at every refunded attempt, not only the last one', async () => {
    const { lp, refunded } = refundedDraft();
    const older = h.store.addJob(lp.id, {
      status: 'refunded',
      failedStage: 'build',
      attempts: 2,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    payment(older.id, { status: 'confirmed' });
    const res = await retry(lp.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'REFUND_PENDING' });
    expect(refunded.status).toBe('refunded');
  });

  it('respects the kill switch and the $FORGE gate, failing closed', async () => {
    const { lp } = refundedDraft();
    h.store.flags.set('signups_paused', true);
    let res = await retry(lp.id);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'SIGNUPS_PAUSED' });
    h.store.flags.set('signups_paused', false);
    h.store.failFlags = true;
    expect((await retry(lp.id)).status).toBe(503);
    h.store.failFlags = false;

    h.gate.result = { enabled: true, ok: false };
    res = await retry(lp.id);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'GATING_REQUIRED' });
    h.gate.result = new Error('rpc down');
    expect((await retry(lp.id)).status).toBe(503);
    expect(creationJobs(lp.id)).toHaveLength(1);

    h.gate.result = { enabled: true, ok: true };
    expect((await retry(lp.id)).status).toBe(201);
  });

  it('refuses a stored blueprint that no longer passes the confirmation checks', async () => {
    const reserved = h.store.addLaunchpad(owner, {
      status: 'draft',
      slug: 'admin',
      spec: spec(owner, { slug: 'admin' }),
    });
    h.store.addJob(reserved.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
    let res = await retry(reserved.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'INVALID_SPEC' });

    // The row and its spec disagree on the subdomain or on the owner.
    const mismatch = h.store.addLaunchpad(owner, { status: 'draft', slug: 'other-slug' });
    h.store.addJob(mismatch.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
    res = await retry(mismatch.id);
    expect(res.status).toBe(409);
    const foreign = h.store.addLaunchpad(owner, { status: 'draft', spec: spec(other) });
    h.store.addJob(foreign.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
    expect((await retry(foreign.id)).status).toBe(409);
    for (const lp of [reserved, mismatch, foreign]) expect(creationJobs(lp.id)).toHaveLength(1);
  });

  it('answers a concurrent "start again" (database unique index) with the winning job', async () => {
    const { lp } = refundedDraft();
    let rival: string | null = null;
    h.store.beforeCreationInsert = (launchpadId) => {
      h.store.beforeCreationInsert = null;
      rival = h.store.addJob(launchpadId).id;
    };
    const res = await retry(lp.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: rival });
    expect(creationJobs(lp.id).filter((j) => j.status !== 'refunded')).toHaveLength(1);
  });

  it('maps a lost race to CREATION_IN_PROGRESS when the winner is already paid', async () => {
    const { lp } = refundedDraft();
    h.store.beforeCreationInsert = (launchpadId) => {
      h.store.beforeCreationInsert = null;
      h.store.addJob(launchpadId, { status: 'paid' });
    };
    const res = await retry(lp.id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: 'CREATION_IN_PROGRESS' });
  });

  it('does not hide other database errors', async () => {
    const { lp } = refundedDraft();
    h.store.beforeCreationInsert = () => {
      throw new StoreError('insert creation job', '23503');
    };
    const res = await retry(lp.id);
    expect(res.status).toBe(503);
    expect(await body(res)).toMatchObject({ code: 'SERVER_ERROR' });
  });

  // Before: nothing ended the cycle, so a blueprint that always fails got free builds forever
  // (each refunded) and its job ids piled up.
  it('stops at the limit of refunded creations and sends the owner to support', async () => {
    const { lp } = refundedDraft();
    for (let i = 1; i < START_AGAIN_POLICY.maxRefundedCreations; i++) {
      const res = await retry(lp.id);
      expect(res.status).toBe(201);
      const { jobId } = (await res.json()) as { jobId: string };
      // That attempt failed twice too and was refunded.
      Object.assign(h.store.jobs.get(jobId)!, {
        status: 'refunded',
        failedStage: 'build',
        attempts: 2,
      });
      payment(jobId);
    }
    expect(creationJobs(lp.id)).toHaveLength(START_AGAIN_POLICY.maxRefundedCreations);
    const res = await retry(lp.id);
    expect(res.status).toBe(409);
    const answer = await body(res);
    expect(answer.code).toBe('NEEDS_SUPPORT');
    expect(String(answer.message)).toMatch(/contact support/i);
    expect(creationJobs(lp.id)).toHaveLength(START_AGAIN_POLICY.maxRefundedCreations);
    expect(h.logger.events()).toContain('retry.refused');
  });

  it('rate limits per wallet', async () => {
    const { lp } = refundedDraft();
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) last = await retry(lp.id, owner, { 'x-real-ip': `10.0.2.${i}` });
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).not.toBeNull();
  });
});

describe('launchpad summaries around "start again"', () => {
  async function summary(id: string) {
    const res = await h.handlers.list(request('GET', '/api/launchpads', { wallet: owner }));
    const list = (await res.json()) as { launchpads: Record<string, unknown>[] };
    return list.launchpads.find((l) => l.id === id)!;
  }

  it('offers to start again a refunded draft, then points to the new job', async () => {
    const { lp } = refundedDraft();
    expect(await summary(lp.id)).toMatchObject({
      status: 'draft',
      activeJobId: null,
      activeJobStatus: null,
      canStartAgain: true,
      startAgainBlocked: null,
    });
    const { jobId } = (await (await retry(lp.id)).json()) as { jobId: string };
    expect(await summary(lp.id)).toMatchObject({
      activeJobId: jobId,
      activeJobStatus: 'spec_ready',
      canStartAgain: false,
      startAgainBlocked: null,
    });
  });

  async function detail(id: string) {
    const res = await h.handlers.detail(
      request('GET', `/api/launchpads/${id}`, { wallet: owner }),
      ctx(id),
    );
    return (await res.json()) as Record<string, unknown>;
  }

  // Before: the summary judged the jobs only, so "start again" was offered for a draft whose
  // refund was still pending (or whose payment was still open), then refused by the route.
  it('offers "start again" exactly when the route accepts it, and says why not', async () => {
    const cases: [string, () => string, string | null, number, string | null][] = [
      ['settled', () => refundedDraft().lp.id, null, 201, null],
      [
        'payment still confirmed',
        () => {
          const { lp, refunded } = refundedDraft();
          payment(refunded.id, { status: 'confirmed' });
          return lp.id;
        },
        'refund_pending',
        409,
        'REFUND_PENDING',
      ],
      [
        'open anomaly',
        () => {
          const { lp, refunded } = refundedDraft();
          h.store.anomalies.push({ jobId: refunded.id, resolved: false });
          return lp.id;
        },
        'refund_pending',
        409,
        'REFUND_PENDING',
      ],
      [
        'sent quote',
        () => {
          const { lp, refunded } = refundedDraft();
          payment(refunded.id, { status: 'quoted', refundSignature: null });
          return lp.id;
        },
        'payment_pending',
        409,
        'PAYMENT_PENDING',
      ],
      [
        'open quote',
        () => {
          const { lp, refunded } = refundedDraft();
          payment(refunded.id, {
            status: 'quoted',
            txSignature: null,
            refundSignature: null,
            quoteExpiresAt: new Date(NOW - 60_000).toISOString(),
          });
          return lp.id;
        },
        'payment_pending',
        409,
        'PAYMENT_PENDING',
      ],
      [
        'blueprint no longer valid',
        () => {
          const lp = h.store.addLaunchpad(owner, { status: 'draft', slug: 'other-slug' });
          h.store.addJob(lp.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
          return lp.id;
        },
        'invalid_spec',
        409,
        'INVALID_SPEC',
      ],
      [
        'on-chain setup recorded',
        () => {
          const lp = h.store.addLaunchpad(owner, {
            status: 'draft',
            launchpadConfig: Keypair.generate().publicKey.toBase58(),
          });
          h.store.addJob(lp.id, { status: 'refunded', failedStage: 'onchain' });
          return lp.id;
        },
        'needs_support',
        409,
        'NEEDS_SUPPORT',
      ],
      [
        'limit of refunded creations',
        () => {
          const { lp } = refundedDraft();
          for (let i = 1; i < START_AGAIN_POLICY.maxRefundedCreations; i++) {
            const older = h.store.addJob(lp.id, {
              status: 'refunded',
              failedStage: 'build',
              attempts: 2,
            });
            payment(older.id);
          }
          return lp.id;
        },
        'needs_support',
        409,
        'NEEDS_SUPPORT',
      ],
      [
        // An open job: its tracker explains, the summary adds nothing.
        'build failed twice, refund pending',
        () => {
          const lp = h.store.addLaunchpad(owner, { status: 'draft' });
          h.store.addJob(lp.id, { status: 'failed', failedStage: 'build', attempts: 2 });
          return lp.id;
        },
        null,
        409,
        'REFUND_PENDING',
      ],
      [
        'creation in progress',
        () => {
          const { lp } = refundedDraft();
          h.store.addJob(lp.id, { status: 'building', attempts: 1 });
          return lp.id;
        },
        null,
        409,
        'CREATION_IN_PROGRESS',
      ],
    ];
    for (const [name, setup, blocked, status, code] of cases) {
      const id = setup();
      const expected = { canStartAgain: status === 201, startAgainBlocked: blocked };
      expect(await summary(id), name).toMatchObject(expected);
      expect(await detail(id), name).toMatchObject(expected);
      const res = await retry(id);
      expect(res.status, name).toBe(status);
      if (code) expect((await body(res)).code, name).toBe(code);
    }
  });

  it('offers nothing when the payments cannot be read, and still answers', async () => {
    const { lp } = refundedDraft();
    h.store.listJobPayments = async () => {
      throw new StoreError('read job payments', '57014');
    };
    const res = await h.handlers.list(request('GET', '/api/launchpads', { wallet: owner }));
    expect(res.status).toBe(200);
    const list = (await res.json()) as { launchpads: Record<string, unknown>[] };
    expect(list.launchpads.find((l) => l.id === lp.id)).toMatchObject({
      canStartAgain: false,
      startAgainBlocked: null,
    });
    expect(h.logger.events()).toContain('start_again.check_failed');
  });

  it('never offers it while a refund is pending, for a live launchpad or a fresh draft', async () => {
    const pending = h.store.addLaunchpad(owner, { status: 'draft' });
    const failed = h.store.addJob(pending.id, {
      status: 'failed',
      failedStage: 'build',
      attempts: 2,
    });
    expect(await summary(pending.id)).toMatchObject({
      activeJobId: failed.id,
      activeJobStatus: 'failed',
      canStartAgain: false,
    });
    const live = h.store.addLaunchpad(owner, { status: 'live', slug: 'live-one' });
    h.store.addJob(live.id, { status: 'refunded', failedStage: 'build', attempts: 2 });
    h.store.addJob(live.id, { status: 'live' });
    expect(await summary(live.id)).toMatchObject({ canStartAgain: false, activeJobId: null });
    const fresh = h.store.addLaunchpad(owner, { status: 'draft', slug: 'fresh' });
    expect(await summary(fresh.id)).toMatchObject({ canStartAgain: false });
    const configured = h.store.addLaunchpad(owner, {
      status: 'draft',
      slug: 'configured',
      launchpadConfig: Keypair.generate().publicKey.toBase58(),
    });
    h.store.addJob(configured.id, { status: 'refunded', failedStage: 'onchain' });
    expect(await summary(configured.id)).toMatchObject({ canStartAgain: false });
  });

  it('judges the creation of a started-again launchpad by its newest creation job', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'live' });
    const live = h.store.addJob(lp.id, { status: 'live' });
    // Listed newest first by the database; an older refunded attempt comes after it here.
    h.store.addJob(lp.id, {
      status: 'refunded',
      failedStage: 'build',
      attempts: 2,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const jobs = [...h.store.jobs.values()].filter((j) => j.launchpadId === lp.id).reverse();
    expect(jobs[0]!.id).not.toBe(live.id);
    expect(launchpadQuotas(lp, jobs)).toMatchObject({
      canRequestModification: true,
      blockedReason: null,
    });
  });
});
