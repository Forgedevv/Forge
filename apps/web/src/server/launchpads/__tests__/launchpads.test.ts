// @vitest-environment node
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ctx, request, spec } from '../../jobs/__tests__/fakes';
import { parseLaunchpadRow, StoreError } from '../../jobs/store';
import { LAUNCHPAD_QUOTAS } from '../quotas';
import { coin } from './fake-chain';
import { NOW, launchpadsHarness } from './helpers';

const owner = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();

let h: ReturnType<typeof launchpadsHarness>;

beforeEach(() => {
  h = launchpadsHarness();
});

function liveLaunchpad(overrides: Parameters<typeof h.store.addLaunchpad>[1] = {}) {
  const lp = h.store.addLaunchpad(owner, { status: 'live', ...overrides });
  h.store.addJob(lp.id, { status: 'live', type: 'create_launchpad' });
  return lp;
}

describe('GET /api/launchpads', () => {
  it("lists only the owner's launchpads with on-chain figures and quotas", async () => {
    const launchpadConfig = Keypair.generate().publicKey;
    const coinConfig = Keypair.generate().publicKey;
    const lp = liveLaunchpad({
      launchpadConfig: launchpadConfig.toBase58(),
      launchpadCoinConfig: coinConfig.toBase58(),
      launchpadCoinMint: 'MintAddress1111111111111111111111111111111',
    });
    const modification = h.store.addJob(lp.id, { type: 'modify_launchpad', status: 'building' });
    h.store.addLaunchpad(other, { slug: 'theirs' });
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [
      coin(launchpadConfig, 1_000n),
      coin(launchpadConfig, 2_000n),
    ]);
    h.claimsChain.coins.set(coinConfig.toBase58(), [coin(coinConfig, 30_000n)]);

    const res = await h.handlers.list(request('GET', '/api/launchpads', { wallet: owner }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      launchpads: Record<string, unknown>[];
      quotas: unknown;
    };
    expect(body.launchpads).toHaveLength(1);
    expect(body.launchpads[0]).toEqual({
      id: lp.id,
      name: 'MoonPad',
      slug: 'moonpad',
      siteUrl: 'https://moonpad.sites.example.com',
      status: 'live',
      coin: {
        name: 'Moon',
        symbol: 'MOON',
        mint: 'MintAddress1111111111111111111111111111111',
        imageUrl: 'https://example.com/moon.png',
      },
      coinsCount: 2,
      claimablePartnerFeesLamports: '33000',
      includedModificationsLeft: 2,
      activeJobId: modification.id,
      activeJobStatus: 'building',
      canStartAgain: false,
      startAgainBlocked: null,
      onchainAvailable: true,
    });
    expect(body.quotas).toEqual({
      launchpads: { count: 1, max: LAUNCHPAD_QUOTAS.maxLaunchpadsPerWallet },
      canCreateLaunchpad: true,
    });
  });

  it('still answers when the chain cannot be read, flagging the figures', async () => {
    const config = Keypair.generate().publicKey;
    liveLaunchpad({ launchpadConfig: config.toBase58() });
    h.claimsChain.failList = new Error('boom https://rpc?api-key=SECRET');
    const res = await h.handlers.list(request('GET', '/api/launchpads', { wallet: owner }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { launchpads: Record<string, unknown>[] };
    expect(body.launchpads[0]).toMatchObject({
      coinsCount: 0,
      claimablePartnerFeesLamports: '0',
      onchainAvailable: false,
    });
    expect(JSON.stringify(h.logger.entries)).not.toContain('SECRET');
  });

  it('requires a session and gives no site URL without CLIENTS_DOMAIN', async () => {
    expect((await h.handlers.list(request('GET', '/api/launchpads'))).status).toBe(401);
    const bare = launchpadsHarness({ clientsDomain: null });
    bare.store.addLaunchpad(owner);
    const body = (await (
      await bare.handlers.list(request('GET', '/api/launchpads', { wallet: owner }))
    ).json()) as { launchpads: { siteUrl: unknown }[] };
    expect(body.launchpads[0]!.siteUrl).toBeNull();
  });

  it('links to the recorded site host first (live and sleeping only)', async () => {
    const list = async (harness: ReturnType<typeof launchpadsHarness>) =>
      (
        (await (
          await harness.handlers.list(request('GET', '/api/launchpads', { wallet: owner }))
        ).json()) as { launchpads: { slug: string; siteUrl: unknown }[] }
      ).launchpads;
    liveLaunchpad({ slug: 'moonpad', siteHost: 'lp-moonpad.vercel.app' });
    h.store.addLaunchpad(owner, {
      slug: 'sleepy-pad',
      status: 'sleeping',
      siteHost: 'lp-sleepy-pad.vercel.app',
    });
    h.store.addLaunchpad(owner, {
      slug: 'cut-pad',
      status: 'disabled',
      siteHost: 'lp-cut-pad.vercel.app',
    });
    h.store.addLaunchpad(owner, { slug: 'new-pad', status: 'draft', siteHost: null });
    const bySlug = Object.fromEntries((await list(h)).map((l) => [l.slug, l.siteUrl]));
    expect(bySlug).toEqual({
      moonpad: 'https://lp-moonpad.vercel.app',
      'sleepy-pad': 'https://lp-sleepy-pad.vercel.app',
      'cut-pad': null,
      'new-pad': null,
    });
    // Without CLIENTS_DOMAIN (devnet beta) the recorded host is still the link.
    const bare = launchpadsHarness({ clientsDomain: null });
    bare.store.addLaunchpad(owner, { siteHost: 'lp-moonpad.vercel.app' });
    expect((await list(bare))[0]!.siteUrl).toBe('https://lp-moonpad.vercel.app');
  });

  it('reads site_host from the row, shape checked (a malformed value is never linked)', () => {
    const row = {
      id: 'l1',
      owner_wallet: owner,
      slug: 'moonpad',
      spec: {},
      status: 'live',
      created_at: '2026-10-10T00:00:00Z',
    };
    expect(parseLaunchpadRow({ ...row, site_host: 'lp-moonpad.vercel.app' }).siteHost).toBe(
      'lp-moonpad.vercel.app',
    );
    for (const bad of [null, undefined, 'https://lp-moonpad.vercel.app', 'a.b.vercel.app', 7]) {
      expect(parseLaunchpadRow({ ...row, site_host: bad }).siteHost).toBeNull();
    }
  });
});

describe('GET /api/launchpads/:id', () => {
  it('returns the detail with versions, jobs, refunds and quotas to the owner only', async () => {
    const lp = liveLaunchpad({ includedModificationsLeft: 1 });
    const v2 = h.store.addJob(lp.id, {
      type: 'modify_launchpad',
      status: 'live',
      request: 'Bigger logo',
      previewUrl: 'https://p2.example',
    });
    const refunded = h.store.addJob(lp.id, { type: 'modify_launchpad', status: 'refunded' });
    h.store.refunds.push({
      jobId: refunded.id,
      lamports: 40n,
      signature: 'rs',
      payerWallet: owner,
    });

    const res = await h.handlers.detail(
      request('GET', `/api/launchpads/${lp.id}`, { wallet: owner }),
      ctx(lp.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: { jobId: string; request: string | null }[];
      jobs: { id: string; refund?: unknown }[];
      quotas: Record<string, unknown>;
      spec: { name: string };
    };
    expect(body.spec.name).toBe('MoonPad');
    expect(body.versions[0]).toMatchObject({ jobId: v2.id, request: 'Bigger logo' });
    expect(body.versions).toHaveLength(2);
    expect(body.jobs.find((j) => j.id === refunded.id)?.refund).toEqual({
      lamports: '40',
      signature: 'rs',
    });
    expect(body.quotas).toEqual({
      includedModificationsLeft: 1,
      modificationPriceUsd: 5.5,
      openModificationJobId: null,
      canRequestModification: true,
      blockedReason: null,
    });
    expect(JSON.stringify(body)).not.toContain('ownerTx');

    const theirs = await h.handlers.detail(
      request('GET', `/api/launchpads/${lp.id}`, { wallet: other }),
      ctx(lp.id),
    );
    expect(theirs.status).toBe(404);
  });
});

describe('POST /api/launchpads/:id/modifications', () => {
  function seed() {
    const lp = liveLaunchpad();
    const conversation = h.store.addConversation(owner, lp.id);
    return { lp, conversation };
  }

  const modify = (id: string, body: unknown, wallet: string | null = owner) =>
    h.handlers.requestModification(
      request('POST', `/api/launchpads/${id}/modifications`, { wallet, body }),
      ctx(id),
    );

  function modificationJobs(launchpadId: string) {
    return [...h.store.jobs.values()].filter(
      (j) => j.launchpadId === launchpadId && j.type === 'modify_launchpad',
    );
  }

  it('creates one modify_launchpad job in spec_ready', async () => {
    const { lp, conversation } = seed();
    const res = await modify(lp.id, { conversationId: conversation.id, request: ' Make it blue ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string; includedModificationsLeft: number };
    expect(body.includedModificationsLeft).toBe(2);
    const job = h.store.jobs.get(body.jobId)!;
    expect(job).toMatchObject({
      type: 'modify_launchpad',
      status: 'spec_ready',
      request: 'Make it blue',
    });
    expect(h.store.events.map((e) => e.message)).toEqual(['Modification requested.']);
  });

  it('is idempotent and rewrites a request still awaiting payment', async () => {
    const { lp, conversation } = seed();
    const first = (await (
      await modify(lp.id, { conversationId: conversation.id, request: 'Make it blue' })
    ).json()) as { jobId: string };
    const replay = await modify(lp.id, {
      conversationId: conversation.id,
      request: 'Make it blue',
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { jobId: string }).jobId).toBe(first.jobId);
    const changed = await modify(lp.id, {
      conversationId: conversation.id,
      request: 'Make it red',
    });
    expect(((await changed.json()) as { jobId: string }).jobId).toBe(first.jobId);
    expect(modificationJobs(lp.id)).toHaveLength(1);
    expect(h.store.jobs.get(first.jobId)!.request).toBe('Make it red');
  });

  it('refuses a second modification while one is paid or building', async () => {
    const { lp, conversation } = seed();
    const busy = h.store.addJob(lp.id, { type: 'modify_launchpad', status: 'building' });
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Again' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'MODIFICATION_IN_PROGRESS', jobId: busy.id });
    expect(modificationJobs(lp.id)).toHaveLength(1);
  });

  it('keeps a single job when two requests insert concurrently', async () => {
    const { lp, conversation } = seed();
    let rival: string | null = null;
    h.store.afterInsert = () => {
      h.store.afterInsert = null;
      rival = h.store.addJob(lp.id, {
        type: 'modify_launchpad',
        request: 'Rival',
        createdAt: '2000-01-01T00:00:00.000Z',
      }).id;
    };
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Mine' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jobId: string }).jobId).toBe(rival);
    expect(modificationJobs(lp.id).map((j) => j.id)).toEqual([rival]);
  });

  it('answers a database unique violation (one open modification) like a lost race', async () => {
    const { lp, conversation } = seed();
    let rival: string | null = null;
    h.store.beforeInsert = (launchpadId) => {
      h.store.beforeInsert = null;
      rival = h.store.addJob(launchpadId, { type: 'modify_launchpad', request: 'Rival' }).id;
      throw new StoreError('insert modification job', '23505');
    };
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Mine' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jobId: string }).jobId).toBe(rival);
    expect(modificationJobs(lp.id).map((j) => j.id)).toEqual([rival]);
  });

  it('maps a unique violation to MODIFICATION_IN_PROGRESS when the winner is already paid', async () => {
    const { lp, conversation } = seed();
    let rival: string | null = null;
    h.store.beforeInsert = (launchpadId) => {
      h.store.beforeInsert = null;
      rival = h.store.addJob(launchpadId, { type: 'modify_launchpad', status: 'paid' }).id;
      throw new StoreError('insert modification job', '23505');
    };
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Mine' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'MODIFICATION_IN_PROGRESS', jobId: rival });
  });

  it('maps a unique violation to MODIFICATION_IN_PROGRESS even if the winner is gone', async () => {
    const { lp, conversation } = seed();
    h.store.beforeInsert = () => {
      h.store.beforeInsert = null;
      throw new StoreError('insert modification job', '23505');
    };
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Mine' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('MODIFICATION_IN_PROGRESS');
    expect(body).not.toHaveProperty('jobId');
  });

  it('does not hide other database errors behind MODIFICATION_IN_PROGRESS', async () => {
    const { lp, conversation } = seed();
    h.store.beforeInsert = () => {
      throw new StoreError('insert modification job', '23503');
    };
    const res = await modify(lp.id, { conversationId: conversation.id, request: 'Mine' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(((await res.json()) as { code: string }).code).not.toBe('MODIFICATION_IN_PROGRESS');
  });

  it('requires a live launchpad whose creation is finished', async () => {
    const sleeping = h.store.addLaunchpad(owner, { status: 'sleeping' });
    const c1 = h.store.addConversation(owner, sleeping.id);
    const res = await modify(sleeping.id, { conversationId: c1.id, request: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'LAUNCHPAD_NOT_LIVE', status: 'sleeping' });

    const disabled = h.store.addLaunchpad(owner, { status: 'disabled' });
    const c2 = h.store.addConversation(owner, disabled.id);
    expect((await modify(disabled.id, { conversationId: c2.id, request: 'x' })).status).toBe(403);

    const deploying = h.store.addLaunchpad(owner, { status: 'live' });
    h.store.addJob(deploying.id, { status: 'deploying' });
    const c3 = h.store.addConversation(owner, deploying.id);
    expect((await modify(deploying.id, { conversationId: c3.id, request: 'x' })).status).toBe(409);
    expect(h.store.events).toHaveLength(0);
  });

  it('checks the owner and the conversation', async () => {
    const { lp, conversation } = seed();
    expect(
      (await modify(lp.id, { conversationId: conversation.id, request: 'x' }, other)).status,
    ).toBe(404);
    const theirs = h.store.addConversation(other, lp.id);
    expect((await modify(lp.id, { conversationId: theirs.id, request: 'x' })).status).toBe(404);
    const design = h.store.addConversation(owner, null);
    const res = await modify(lp.id, { conversationId: design.id, request: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CONVERSATION_MISMATCH' });
    expect(modificationJobs(lp.id)).toHaveLength(0);
  });

  it('rechecks the $FORGE gate, failing closed', async () => {
    const { lp, conversation } = seed();
    h.gate.result = { enabled: true, ok: false };
    const denied = await modify(lp.id, { conversationId: conversation.id, request: 'x' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'GATING_REQUIRED' });
    h.gate.result = new Error('rpc down');
    expect((await modify(lp.id, { conversationId: conversation.id, request: 'x' })).status).toBe(
      503,
    );
    expect(modificationJobs(lp.id)).toHaveLength(0);
  });

  it('validates the body strictly', async () => {
    const { lp, conversation } = seed();
    expect(
      (await modify(lp.id, { conversationId: conversation.id, request: 'x', extra: 1 })).status,
    ).toBe(400);
    expect((await modify(lp.id, { conversationId: 'nope', request: 'x' })).status).toBe(400);
    expect((await modify(lp.id, { conversationId: conversation.id, request: '   ' })).status).toBe(
      400,
    );
    const long = 'a'.repeat(LAUNCHPAD_QUOTAS.maxRequestLength + 1);
    expect((await modify(lp.id, { conversationId: conversation.id, request: long })).status).toBe(
      400,
    );
    expect(modificationJobs(lp.id)).toHaveLength(0);
  });

  it('rate limits per wallet', async () => {
    const { lp, conversation } = seed();
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await h.handlers.requestModification(
        request('POST', `/api/launchpads/${lp.id}/modifications`, {
          wallet: owner,
          body: { conversationId: conversation.id, request: 'x' },
          headers: { 'x-real-ip': `10.0.1.${i}` },
        }),
        ctx(lp.id),
      );
    }
    expect(last!.status).toBe(429);
  });
});

describe('POST /api/launchpads/:id/reactivate', () => {
  const reactivate = (id: string, wallet: string | null = owner) =>
    h.handlers.reactivate(request('POST', `/api/launchpads/${id}/reactivate`, { wallet }), ctx(id));

  it('wakes a sleeping launchpad and resets its dormancy clock, idempotently', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'sleeping' });
    const res = await reactivate(lp.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'live' });
    expect(h.store.launchpads.get(lp.id)).toMatchObject({
      status: 'live',
      lastTradeAt: new Date(NOW).toISOString(),
    });
    expect(await (await reactivate(lp.id)).json()).toEqual({ status: 'live' });
  });

  it('refuses other wallets, drafts and disabled launchpads', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'sleeping' });
    expect((await reactivate(lp.id, other)).status).toBe(404);
    expect((await reactivate(lp.id, null)).status).toBe(401);
    expect(h.store.launchpads.get(lp.id)!.status).toBe('sleeping');
    const draft = h.store.addLaunchpad(owner, { status: 'draft' });
    expect((await reactivate(draft.id)).status).toBe(409);
    const disabled = h.store.addLaunchpad(owner, { status: 'disabled' });
    expect((await reactivate(disabled.id)).status).toBe(403);
    expect(h.store.launchpads.get(disabled.id)!.status).toBe('disabled');
  });

  it('respects deploys_paused and fails closed when flags cannot be read', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'sleeping' });
    h.store.flags.set('deploys_paused', true);
    const paused = await reactivate(lp.id);
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ code: 'DEPLOYS_PAUSED' });
    h.store.flags.set('deploys_paused', false);
    h.store.failFlags = true;
    expect((await reactivate(lp.id)).status).toBe(503);
    expect(h.store.launchpads.get(lp.id)!.status).toBe('sleeping');
  });

  it('rejects cross-site requests', async () => {
    const lp = h.store.addLaunchpad(owner, { status: 'sleeping', spec: spec(owner) });
    const res = await h.handlers.reactivate(
      request('POST', `/api/launchpads/${lp.id}/reactivate`, {
        wallet: owner,
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      }),
      ctx(lp.id),
    );
    expect(res.status).toBe(403);
    expect(h.store.launchpads.get(lp.id)!.status).toBe('sleeping');
  });
});
