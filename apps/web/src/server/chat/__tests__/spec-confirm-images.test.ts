// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeResolver,
  fakeTransport,
  pngBytes,
  PUBLIC_BASE,
  PUBLIC_V4,
  storageHarness,
  type FakeReply,
} from '@/server/coin-images/__tests__/fakes';
import { fetchPublicImage, MAX_BYTES } from '@/server/coin-images/fetch-image';
import { createCoinImageRehoster, IMMUTABLE_CACHE_CONTROL } from '@/server/coin-images/rehost';
import { UploadConfigError } from '@/server/uploads/config';
import { handleSpecConfirm, type SpecConfirmDeps } from '../spec-confirm';
import { makeDeps, MemoryStore, postJson, setTestEnv, validSpec } from './helpers';

/*
 * POST /api/spec/confirm with the real image copy (fetch-image.ts + rehost.ts) over fake DNS,
 * a fake pinned transport and the in-memory R2.
 */

const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const SOURCE = 'https://cdn.example.com/moon.png';
const LOGO = 'https://cdn.example.com/logo.png';

let errors: string[];
beforeEach(() => {
  setTestEnv();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => errors.push(String(line)));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function harness(
  replies: Record<string, FakeReply>,
  dns: Record<string, string[]> = { 'cdn.example.com': [PUBLIC_V4] },
) {
  const resolve = fakeResolver(dns);
  const transport = fakeTransport(replies);
  const r2 = storageHarness();
  const store = new MemoryStore();
  const rehoster = createCoinImageRehoster({
    storage: r2.storage,
    fetchImage: (url) => fetchPublicImage(url, { resolve, transport }),
  });
  const deps: SpecConfirmDeps = { ...makeDeps({ store }), images: () => rehoster };
  return { resolve, transport, r2, store, deps };
}

function confirm(deps: SpecConfirmDeps, spec: unknown = validSpec()) {
  return handleSpecConfirm(
    postJson('/api/spec/confirm', { conversationId: CONVERSATION, spec }),
    deps,
  );
}

function withImages(imageUrl: string, logoUrl?: string): Record<string, unknown> {
  const base = validSpec();
  return {
    ...base,
    theme: { ...(base.theme as object), ...(logoUrl ? { logoUrl } : {}) },
    launchpadCoin: { ...(base.launchpadCoin as object), imageUrl },
  };
}

const json = async (res: Response) => (await res.json()) as Record<string, string>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = (bytes = pngBytes()): FakeReply => ({
  status: 200,
  headers: { 'content-type': 'image/png' },
  body: bytes,
});

describe('POST /api/spec/confirm: coin image copy', () => {
  it('stores the image in R2 and confirms the spec with the R2 URL', async () => {
    const bytes = pngBytes(2048);
    const h = harness({ [SOURCE]: png(bytes) });
    const res = await confirm(h.deps);
    expect(res.status).toBe(201);
    const key = `coin-images/${sha(bytes)}.png`;
    const [confirmed] = h.store.confirmed;
    expect(confirmed?.spec.launchpadCoin.imageUrl).toBe(`${PUBLIC_BASE}/${key}`);
    expect(h.r2.r2.objects.get(key)?.bytes).toEqual(bytes);
    expect(h.r2.r2.objects.get(key)?.contentType).toBe('image/png');
    expect(h.r2.puts[0]?.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('copies the logo too', async () => {
    const logo = pngBytes(900, 3);
    const h = harness({ [SOURCE]: png(), [LOGO]: png(logo) });
    const res = await confirm(h.deps, withImages(SOURCE, LOGO));
    expect(res.status).toBe(201);
    expect(h.store.confirmed[0]?.spec.theme.logoUrl).toBe(
      `${PUBLIC_BASE}/coin-images/${sha(logo)}.png`,
    );
  });

  it('keeps an image already stored in R2 without fetching anything', async () => {
    const stored = `${PUBLIC_BASE}/coin-images/${'c'.repeat(64)}.png`;
    const h = harness({});
    const res = await confirm(h.deps, withImages(stored));
    expect(res.status).toBe(201);
    expect(h.store.confirmed[0]?.spec.launchpadCoin.imageUrl).toBe(stored);
    expect(h.resolve.calls).toEqual([]);
    expect(h.transport.calls).toEqual([]);
    expect(h.r2.puts).toEqual([]);
  });

  it('confirms the same stored spec again when the same image is given again', async () => {
    const h = harness({ [SOURCE]: png() });
    expect((await confirm(h.deps)).status).toBe(201);
    expect((await confirm(h.deps)).status).toBe(201);
    const [first, second] = h.store.confirmed;
    expect(second?.spec).toEqual(first?.spec);
  });

  async function expectRefused(
    h: ReturnType<typeof harness>,
    mention: string,
    spec: unknown = validSpec(),
  ) {
    const res = await confirm(h.deps, spec);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe('IMAGE_UNAVAILABLE');
    expect(body.message).toContain(mention);
    expect(body.message).toContain('give another image URL');
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
    // No launchpad, no job, no payment: the store was never asked to confirm.
    expect(h.store.confirmed).toHaveLength(0);
    expect(h.r2.puts).toHaveLength(0);
    return JSON.stringify(body);
  }

  it('refuses a host resolving to a private address, without connecting', async () => {
    const h = harness({ [SOURCE]: png() }, { 'cdn.example.com': ['10.0.0.12'] });
    const text = await expectRefused(h, 'could not be downloaded');
    expect(text).not.toContain('10.0.0.12');
    expect(text).not.toContain('cdn.example.com');
    expect(h.transport.calls).toHaveLength(0);
  });

  it('refuses a redirect to a private address', async () => {
    const h = harness(
      {
        [SOURCE]: { status: 302, headers: { location: 'https://meta.example.net/latest' } },
        'https://meta.example.net/latest': png(),
      },
      { 'cdn.example.com': [PUBLIC_V4], 'meta.example.net': ['169.254.169.254'] },
    );
    const text = await expectRefused(h, 'could not be downloaded');
    expect(text).not.toContain('169.254');
    expect(h.transport.calls.map((c) => c.url)).toEqual([SOURCE]);
  });

  it('refuses an image larger than 5 MB', async () => {
    const h = harness({ [SOURCE]: png(pngBytes(MAX_BYTES + 1)) });
    await expectRefused(h, 'larger than 5 MB');
  });

  it('refuses bytes that are not an image, without echoing them', async () => {
    const page = new TextEncoder().encode('<html>SECRET-INTERNAL-PAGE</html>');
    const h = harness({
      [SOURCE]: { status: 200, headers: { 'content-type': 'image/png' }, body: page },
    });
    const text = await expectRefused(h, 'not a PNG, JPEG, WebP or GIF');
    expect(text).not.toContain('SECRET-INTERNAL-PAGE');
  });

  it('refuses an unreachable image (the host answers 400)', async () => {
    const h = harness({ [SOURCE]: { status: 400 } });
    await expectRefused(h, 'could not be downloaded');
  });

  it('names the logo when the logo is the image that fails', async () => {
    const h = harness({ [SOURCE]: png(), [LOGO]: { status: 404 } });
    await expectRefused(h, 'The logo could not be downloaded', withImages(SOURCE, LOGO));
  });

  it('answers 503 and creates nothing when R2 refuses the write', async () => {
    const h = harness({ [SOURCE]: png() });
    h.r2.r2.failures.push(500, 500, 500);
    const res = await confirm(h.deps);
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('SERVER_ERROR');
    expect(h.store.confirmed).toHaveLength(0);
    expect(errors.join('\n')).toContain('storage put failed (500)');
  });

  it('answers 503 and creates nothing when R2 is not configured', async () => {
    const store = new MemoryStore();
    const deps: SpecConfirmDeps = {
      ...makeDeps({ store }),
      images: () => {
        throw new UploadConfigError(['R2_ACCESS_KEY_ID', 'R2_PUBLIC_URL']);
      },
    };
    const res = await confirm(deps);
    expect(res.status).toBe(503);
    expect(store.confirmed).toHaveLength(0);
    expect(errors.join('\n')).toContain('R2_ACCESS_KEY_ID, R2_PUBLIC_URL');
  });

  it('fetches nothing for a request refused earlier (invalid spec, token gate)', async () => {
    const invalid = harness({ [SOURCE]: png() });
    const bad = await confirm(invalid.deps, validSpec({ tradingFeeBps: 5000 }));
    expect(bad.status).toBe(400);
    expect(invalid.resolve.calls).toEqual([]);

    const gated = harness({ [SOURCE]: png() });
    const res = await confirm({
      ...gated.deps,
      gating: () => Promise.resolve({ enabled: true, ok: false }),
    });
    expect(res.status).toBe(403);
    expect(gated.resolve.calls).toEqual([]);
  });
});
