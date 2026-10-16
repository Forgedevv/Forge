// @vitest-environment node
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeResolver,
  fakeTransport,
  pngBytes,
  PUBLIC_BASE,
  PUBLIC_V4,
  storageHarness,
  type FakeReply,
} from '../../coin-images/__tests__/fakes';
import type { CoinImageRehoster } from '../../coin-images';
import { fetchPublicImage } from '../../coin-images/fetch-image';
import { createCoinImageRehoster, IMMUTABLE_CACHE_CONTROL } from '../../coin-images/rehost';
import { ctx, request, spec } from '../../jobs/__tests__/fakes';
import { UploadConfigError } from '../../uploads/config';
import {
  MAX_STORED_REQUEST_LENGTH,
  readImageUrl,
  requestWithStoredImages,
} from '../modification-images';
import { launchpadsHarness } from './helpers';

/*
 * POST /api/launchpads/:id/modifications with a logo (or coin image) changed in the modification
 * chat: the real image copy (fetch-image.ts + rehost.ts) over fake DNS, a fake pinned transport and
 * the in-memory R2.
 */

const owner = Keypair.generate().publicKey.toBase58();
const LOGO = 'https://cdn.example.com/new-logo.png';
const COIN = 'https://cdn.example.com/new-coin.png';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stored = (bytes: Uint8Array) => `${PUBLIC_BASE}/coin-images/${sha(bytes)}.png`;
const png = (bytes = pngBytes()): FakeReply => ({
  status: 200,
  headers: { 'content-type': 'image/png' },
  body: bytes,
});

function setup(
  replies: Record<string, FakeReply>,
  opts: {
    dns?: Record<string, string[]>;
    images?: () => CoinImageRehoster;
  } = {},
) {
  const resolve = fakeResolver(opts.dns ?? { 'cdn.example.com': [PUBLIC_V4] });
  const transport = fakeTransport(replies);
  const r2 = storageHarness();
  let created = 0;
  const rehoster = createCoinImageRehoster({
    storage: r2.storage,
    fetchImage: (url) => fetchPublicImage(url, { resolve, transport }),
  });
  const h = launchpadsHarness({
    images:
      opts.images ??
      (() => {
        created += 1;
        return rehoster;
      }),
  });
  return { h, resolve, transport, r2, created: () => created };
}

type Harness = ReturnType<typeof setup>['h'];

/** A live launchpad (creation finished) and its modification conversation holding `draft`. */
function seed(h: Harness, draft: unknown, current = spec(owner)) {
  const lp = h.store.addLaunchpad(owner, { status: 'live', spec: current });
  h.store.addJob(lp.id, { status: 'live', type: 'create_launchpad' });
  const conversation = h.store.addConversation(owner, lp.id, draft);
  return { lp, conversation };
}

/** The launchpad's spec with the draft's image changes. */
function draftWith(images: { logoUrl?: string; imageUrl?: string }) {
  const base = spec(owner);
  return {
    ...base,
    theme: { ...base.theme, ...(images.logoUrl ? { logoUrl: images.logoUrl } : {}) },
    launchpadCoin: {
      ...base.launchpadCoin,
      ...(images.imageUrl ? { imageUrl: images.imageUrl } : {}),
    },
  };
}

function modify(h: Harness, launchpadId: string, conversationId: string, text: string) {
  return h.handlers.requestModification(
    request('POST', `/api/launchpads/${launchpadId}/modifications`, {
      wallet: owner,
      body: { conversationId, request: text },
    }),
    ctx(launchpadId),
  );
}

function modificationJobs(h: Harness, launchpadId: string) {
  return [...h.store.jobs.values()].filter(
    (j) => j.launchpadId === launchpadId && j.type === 'modify_launchpad',
  );
}

describe('POST /api/launchpads/:id/modifications: changed images', () => {
  let bytes: Uint8Array;
  beforeEach(() => {
    bytes = pngBytes(1500, 9);
  });

  it('copies a new logo into R2 and stores the request with the R2 URL only', async () => {
    const t = setup({ [LOGO]: png(bytes) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    const res = await modify(t.h, lp.id, conversation.id, `Use ${LOGO} as the new logo`);
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    const url = stored(bytes);
    expect(t.h.store.jobs.get(jobId)!.request).toBe(
      `Use ${url} as the new logo\n\nNew logo image URL: ${url}`,
    );
    expect(t.h.store.jobs.get(jobId)!.request).not.toContain('cdn.example.com');
    const key = `coin-images/${sha(bytes)}.png`;
    expect(t.r2.r2.objects.get(key)?.bytes).toEqual(bytes);
    expect(t.r2.puts).toHaveLength(1);
    expect(t.r2.puts[0]?.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(t.transport.calls.map((c) => c.url)).toEqual([LOGO]);
  });

  it('names the R2 URL even when the request does not spell the URL out', async () => {
    const t = setup({ [LOGO]: png(bytes) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    const res = await modify(t.h, lp.id, conversation.id, 'Swap the logo for the one I sent');
    const { jobId } = (await res.json()) as { jobId: string };
    expect(t.h.store.jobs.get(jobId)!.request).toBe(
      `Swap the logo for the one I sent\n\nNew logo image URL: ${stored(bytes)}`,
    );
  });

  it('copies a changed coin image the same way, before the logo', async () => {
    const coin = pngBytes(700, 4);
    const t = setup({ [LOGO]: png(bytes), [COIN]: png(coin) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO, imageUrl: COIN }));
    const res = await modify(t.h, lp.id, conversation.id, 'New images');
    const { jobId } = (await res.json()) as { jobId: string };
    expect(t.h.store.jobs.get(jobId)!.request).toBe(
      `New images\n\nNew coin image URL: ${stored(coin)}\nNew logo image URL: ${stored(bytes)}`,
    );
    expect(t.transport.calls.map((c) => c.url)).toEqual([COIN, LOGO]);
  });

  it('keeps a logo already stored under coin-images/ without fetching anything', async () => {
    const already = `${PUBLIC_BASE}/coin-images/${'d'.repeat(64)}.png`;
    const t = setup({});
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: already }));
    const res = await modify(t.h, lp.id, conversation.id, `Logo: ${already}`);
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(t.h.store.jobs.get(jobId)!.request).toBe(
      `Logo: ${already}\n\nNew logo image URL: ${already}`,
    );
    expect(t.resolve.calls).toEqual([]);
    expect(t.transport.calls).toEqual([]);
    expect(t.r2.puts).toEqual([]);
  });

  it('copies another key of the bucket (staged uploads expire)', async () => {
    const staged = `${PUBLIC_BASE}/pending/${'e'.repeat(32)}.png`;
    const t = setup(
      { [staged]: png(bytes) },
      { dns: { [new URL(PUBLIC_BASE).hostname]: [PUBLIC_V4] } },
    );
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: staged }));
    const res = await modify(t.h, lp.id, conversation.id, 'New logo');
    const { jobId } = (await res.json()) as { jobId: string };
    expect(t.h.store.jobs.get(jobId)!.request).toBe(
      `New logo\n\nNew logo image URL: ${stored(bytes)}`,
    );
  });

  it('leaves the request as typed when no image changed, without creating the copy', async () => {
    const t = setup({});
    // Draft identical to the launchpad's spec, then no draft at all.
    for (const draft of [spec(owner), null]) {
      const { lp, conversation } = seed(t.h, draft);
      const res = await modify(t.h, lp.id, conversation.id, ' Make it blue ');
      expect(res.status).toBe(201);
      const { jobId } = (await res.json()) as { jobId: string };
      expect(t.h.store.jobs.get(jobId)!.request).toBe('Make it blue');
    }
    expect(t.created()).toBe(0);
    expect(t.transport.calls).toEqual([]);
  });

  it('does not report an image whose copy is the current one (creation conversation)', async () => {
    // The creation chat's draft still holds the owner's original URL; the launchpad holds its copy.
    const t = setup({ [COIN]: png(bytes) });
    const current = spec(owner, {
      launchpadCoin: { ...spec(owner).launchpadCoin, imageUrl: stored(bytes) },
    });
    const { lp, conversation } = seed(t.h, draftWith({ imageUrl: COIN }), current);
    const res = await modify(t.h, lp.id, conversation.id, 'Bigger title');
    const { jobId } = (await res.json()) as { jobId: string };
    expect(t.h.store.jobs.get(jobId)!.request).toBe('Bigger title');
  });

  it('is idempotent: the same request again returns the same job, unchanged', async () => {
    const t = setup({ [LOGO]: png(bytes) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    const text = `Use ${LOGO}`;
    const first = (await (await modify(t.h, lp.id, conversation.id, text)).json()) as {
      jobId: string;
    };
    const again = await modify(t.h, lp.id, conversation.id, text);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { jobId: string }).jobId).toBe(first.jobId);
    expect(modificationJobs(t.h, lp.id)).toHaveLength(1);
    expect(t.h.store.jobs.get(first.jobId)!.request).toBe(
      `Use ${stored(bytes)}\n\nNew logo image URL: ${stored(bytes)}`,
    );
  });

  it('rewrites a pending request with the R2 URL too', async () => {
    const t = setup({ [LOGO]: png(bytes) });
    const { lp, conversation } = seed(t.h, null);
    const first = (await (await modify(t.h, lp.id, conversation.id, 'Make it blue')).json()) as {
      jobId: string;
    };
    t.h.store.conversations.get(conversation.id)!.draft = draftWith({ logoUrl: LOGO });
    const changed = await modify(t.h, lp.id, conversation.id, `Make it blue, logo ${LOGO}`);
    expect(changed.status).toBe(200);
    expect(t.h.store.jobs.get(first.jobId)!.request).toBe(
      `Make it blue, logo ${stored(bytes)}\n\nNew logo image URL: ${stored(bytes)}`,
    );
  });

  async function expectRefused(t: ReturnType<typeof setup>, launchpadId: string, id: string) {
    const res = await modify(t.h, launchpadId, id, `Use ${LOGO}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('IMAGE_UNAVAILABLE');
    expect(body.message).toContain('logo');
    expect(body.message).toContain('give another image URL');
    expect(body.message).not.toContain('cdn.example.com');
    expect(modificationJobs(t.h, launchpadId)).toHaveLength(0);
    expect(t.h.store.events).toHaveLength(0);
    expect(t.r2.puts).toHaveLength(0);
  }

  it('answers 422 IMAGE_UNAVAILABLE and writes nothing when the logo cannot be downloaded', async () => {
    const t = setup({ [LOGO]: { status: 404 } });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    await expectRefused(t, lp.id, conversation.id);
  });

  it('refuses a logo that is not an image', async () => {
    const t = setup({
      [LOGO]: { status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array(64) },
    });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    await expectRefused(t, lp.id, conversation.id);
  });

  it('refuses a logo host resolving to a private address, without connecting', async () => {
    const t = setup({ [LOGO]: png(bytes) }, { dns: { 'cdn.example.com': ['10.0.0.12'] } });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    await expectRefused(t, lp.id, conversation.id);
    expect(t.transport.calls).toEqual([]);
  });

  it('answers 503 and writes nothing when R2 is not configured', async () => {
    const t = setup(
      {},
      {
        images: () => {
          throw new UploadConfigError(['R2_ACCESS_KEY_ID', 'R2_PUBLIC_URL']);
        },
      },
    );
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    const res = await modify(t.h, lp.id, conversation.id, 'New logo');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('SERVER_ERROR');
    expect(modificationJobs(t.h, lp.id)).toHaveLength(0);
    expect(JSON.stringify(t.h.logger.entries)).toContain('R2_ACCESS_KEY_ID, R2_PUBLIC_URL');
  });

  it('fetches nothing for a request refused earlier (token gate, not live)', async () => {
    const t = setup({ [LOGO]: png(bytes) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: LOGO }));
    t.h.gate.result = { enabled: true, ok: false };
    expect((await modify(t.h, lp.id, conversation.id, 'New logo')).status).toBe(403);
    t.h.gate.result = { enabled: false, ok: true };
    const sleeping = seed(t.h, draftWith({ logoUrl: LOGO }));
    t.h.store.launchpads.get(sleeping.lp.id)!.status = 'sleeping';
    expect((await modify(t.h, sleeping.lp.id, sleeping.conversation.id, 'New logo')).status).toBe(
      409,
    );
    expect(t.resolve.calls).toEqual([]);
    expect(t.created()).toBe(0);
  });

  it('refuses a request that the copy would make too long for the builder', async () => {
    const short = 'https://cdn.example.com/l.png';
    const t = setup({ [short]: png(bytes) });
    const { lp, conversation } = seed(t.h, draftWith({ logoUrl: short }));
    const text = Array.from({ length: 130 }, () => short).join(' ');
    expect(text.length).toBeLessThanOrEqual(4000);
    const res = await modify(t.h, lp.id, conversation.id, text);
    expect(res.status).toBe(400);
    expect(modificationJobs(t.h, lp.id)).toHaveLength(0);
  });
});

describe('modification image helpers', () => {
  it('reads an image URL from unparsed jsonb only when it is a non-empty string', () => {
    expect(readImageUrl({ theme: { logoUrl: LOGO } }, 'theme.logoUrl')).toBe(LOGO);
    expect(readImageUrl({ launchpadCoin: { imageUrl: COIN } }, 'launchpadCoin.imageUrl')).toBe(
      COIN,
    );
    for (const value of [
      null,
      'x',
      [],
      { theme: null },
      { theme: { logoUrl: 3 } },
      { theme: { logoUrl: '' } },
    ]) {
      expect(readImageUrl(value, 'theme.logoUrl')).toBeUndefined();
    }
  });

  it('replaces every occurrence of the source URL and appends one line per image', () => {
    const url = `${PUBLIC_BASE}/coin-images/${'a'.repeat(64)}.png`;
    expect(requestWithStoredImages('Make it blue', [])).toBe('Make it blue');
    expect(
      requestWithStoredImages(`${LOGO} and again ${LOGO}.`, [
        { field: 'theme.logoUrl', source: LOGO, url },
      ]),
    ).toBe(`${url} and again ${url}.\n\nNew logo image URL: ${url}`);
    expect(MAX_STORED_REQUEST_LENGTH).toBe(8000);
  });
});
