// @vitest-environment node
import type { LaunchpadSpec } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecConfirm } from '../spec-confirm';
import {
  makeDeps,
  MemoryStore,
  OTHER_WALLET,
  postJson,
  sessionCookie,
  setTestEnv,
  validSpec,
  WALLET,
} from './helpers';

beforeEach(() => {
  setTestEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const body = (spec: unknown = validSpec(), conversationId = CONVERSATION) => ({
  conversationId,
  spec,
});
// Image copies are covered by spec-confirm-images.test.ts; here the spec passes through.
const keepImages = { rehost: (spec: LaunchpadSpec) => Promise.resolve(spec) };
const call = (b: unknown, deps = makeDeps(), cookie?: string | null) =>
  handleSpecConfirm(postJson('/api/spec/confirm', b, cookie === undefined ? {} : { cookie }), {
    ...deps,
    images: () => keepImages,
  });
const json = async (res: Response) => (await res.json()) as Record<string, string>;

describe('POST /api/spec/confirm', () => {
  it('requires a session', async () => {
    const res = await call(body(), makeDeps(), null);
    expect(res.status).toBe(401);
  });

  it('creates the launchpad and job and returns their ids', async () => {
    const deps = makeDeps();
    const res = await call(body(), deps);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ launchpadId: 'lp-1', jobId: 'job-1' });
    const [confirmed] = deps.store().confirmed;
    expect(confirmed?.wallet).toBe(WALLET);
    expect(confirmed?.spec.ownerWallet).toBe(WALLET);
    // Defaults are applied by the schema.
    expect(confirmed?.spec.antiSniper).toBe(true);
  });

  it('answers 200 for an idempotent repeat', async () => {
    const store = new MemoryStore();
    store.confirmOutcome = { status: 'existing', launchpadId: 'lp-1', jobId: 'job-1' };
    expect((await call(body(), makeDeps({ store }))).status).toBe(200);
  });

  it('rejects a spec whose ownerWallet is not the session wallet', async () => {
    const deps = makeDeps();
    const res = await call(body(validSpec({ ownerWallet: OTHER_WALLET })), deps);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('WRONG_WALLET');
    expect(deps.store().confirmed).toHaveLength(0);
  });

  it('rejects a session for another wallet using the first wallet spec', async () => {
    const deps = makeDeps();
    const res = await call(body(), deps, sessionCookie(OTHER_WALLET));
    expect(res.status).toBe(403);
    expect(deps.store().confirmed).toHaveLength(0);
  });

  it.each([
    ['fee above max', validSpec({ tradingFeeBps: 5000 }), 'Trading fee'],
    ['fee below min', validSpec({ tradingFeeBps: 10 }), 'Trading fee'],
    ['creation fee in the gap', validSpec({ poolCreationFeeSol: 0.0005 }), 'Coin creation fee'],
    ['creator share above max', validSpec({ coinCreatorSharePct: 80 }), 'Coin creator share'],
    ['reserved slug', validSpec({ slug: 'admin' }), 'Subdomain'],
    ['quote not SOL', validSpec({ quote: 'USDC' }), 'Quote currency must be SOL'],
    [
      'wallet in design notes',
      validSpec({ theme: { ...(validSpec().theme as object), designNotes: OTHER_WALLET } }),
      'Design notes',
    ],
    [
      'private image host',
      validSpec({
        launchpadCoin: {
          ...(validSpec().launchpadCoin as object),
          imageUrl: 'https://127.0.0.1/x.png',
        },
      }),
      'image URL',
    ],
  ])('re-validates the spec server side: %s', async (_label, spec, mention) => {
    const deps = makeDeps();
    const res = await call(body(spec), deps);
    expect(res.status).toBe(400);
    const out = await json(res);
    expect(out.code).toBe('BAD_REQUEST');
    expect(out.message).toContain(mention);
    expect(deps.store().confirmed).toHaveLength(0);
  });

  it.each([
    ['unknown key', { ...body(), extra: 1 }],
    ['bad conversation id', body(validSpec(), 'nope')],
    ['missing spec', { conversationId: CONVERSATION }],
    ['not an object', '"x"'],
  ])('rejects a malformed request: %s', async (_label, b) => {
    const res = await call(b);
    expect(res.status).toBe(400);
  });

  it('maps store outcomes to HTTP errors', async () => {
    const cases = [
      [{ status: 'conversation_not_found' }, 404],
      [{ status: 'slug_taken' }, 409],
      [{ status: 'conflict' }, 409],
      [{ status: 'too_many_drafts' }, 409],
      [{ status: 'draft_released' }, 409],
    ] as const;
    for (const [outcome, status] of cases) {
      const store = new MemoryStore();
      store.confirmOutcome = outcome;
      expect((await call(body(), makeDeps({ store }))).status).toBe(status);
    }
  });

  it('explains the unpaid draft cap', async () => {
    const store = new MemoryStore();
    store.confirmOutcome = { status: 'too_many_drafts' };
    const res = await call(body(), makeDeps({ store }));
    expect((await json(res)).message).toContain('3 unpaid launchpad drafts');
  });

  it('respects the signups_paused flag and the token gate', async () => {
    const store = new MemoryStore();
    store.flags.signups_paused = true;
    const paused = await call(body(), makeDeps({ store }));
    expect(paused.status).toBe(403);
    expect((await json(paused)).code).toBe('SIGNUPS_PAUSED');

    const gated = await call(
      body(),
      makeDeps({ gating: () => Promise.resolve({ enabled: true, ok: false }) }),
    );
    expect(gated.status).toBe(403);
    expect((await json(gated)).code).toBe('GATING_REQUIRED');
  });

  it('is rate limited', async () => {
    const deps = makeDeps();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call(body(), deps)).status;
    expect(last).toBe(429);
  });

  it('answers 503 without internals when storage fails', async () => {
    const store = new MemoryStore();
    store.confirmSpec = () => Promise.reject(new Error('password authentication failed for user'));
    const res = await call(body(), makeDeps({ store }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await json(res))).not.toContain('password');
  });
});
