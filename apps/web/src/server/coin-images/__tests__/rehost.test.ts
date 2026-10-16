// @vitest-environment node
import { createHash } from 'node:crypto';
import type { LaunchpadSpec } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../jobs/log';
import { ImageFetchError, type FetchedImage } from '../fetch-image';
import {
  CoinImageUnavailableError,
  createCoinImageRehoster,
  IMMUTABLE_CACHE_CONTROL,
  imageUnavailableMessage,
  isStoredCoinImageUrl,
} from '../rehost';
import { jpegBytes, pngBytes, PUBLIC_BASE, storageHarness } from './fakes';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function spec(imageUrl: string, logoUrl?: string): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.01,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'Launch your next moonshot',
      designNotes: 'Dark, glossy, space themed hero.',
      ...(logoUrl === undefined ? {} : { logoUrl }),
    },
    launchpadCoin: {
      name: 'Moon Coin',
      symbol: 'MOON',
      description: 'The coin of MoonPad.',
      imageUrl,
      firstBuySol: 1,
    },
  } as LaunchpadSpec;
}

function fakeFetch(images: Record<string, FetchedImage | ImageFetchError>) {
  const calls: string[] = [];
  const fetchImage = (url: string) => {
    calls.push(url);
    const found = images[url];
    if (!found) return Promise.reject(new ImageFetchError('network'));
    return found instanceof ImageFetchError ? Promise.reject(found) : Promise.resolve(found);
  };
  return Object.assign(fetchImage, { calls });
}

const COIN = 'https://images.example.com/moon.png';
const LOGO = 'https://images.example.com/logo.jpg';

describe('createCoinImageRehoster', () => {
  it('stores the image under its content hash and rewrites the URL', async () => {
    const h = storageHarness();
    const bytes = pngBytes();
    const logger = new MemoryLogger();
    const rehoster = createCoinImageRehoster({
      storage: h.storage,
      fetchImage: fakeFetch({ [COIN]: { bytes, contentType: 'image/png' } }),
      logger,
    });
    const out = await rehoster.rehost(spec(COIN));
    const key = `coin-images/${sha(bytes)}.png`;
    expect(out.launchpadCoin.imageUrl).toBe(`${PUBLIC_BASE}/${key}`);
    expect(out.theme.logoUrl).toBeUndefined();
    // Everything else is untouched.
    expect({ ...out, launchpadCoin: { ...out.launchpadCoin, imageUrl: COIN } }).toEqual(spec(COIN));
    const stored = h.r2.objects.get(key);
    expect(stored?.bytes).toEqual(bytes);
    expect(stored?.contentType).toBe('image/png');
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]?.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(h.puts[0]?.headers['if-none-match']).toBe('*');
    expect(logger.events()).toEqual(['coin_image_copied']);
  });

  it('copies the logo too, and fetches a URL used twice only once', async () => {
    const h = storageHarness();
    const coin = pngBytes();
    const logo = jpegBytes();
    const fetchImage = fakeFetch({
      [COIN]: { bytes: coin, contentType: 'image/png' },
      [LOGO]: { bytes: logo, contentType: 'image/jpeg' },
    });
    const rehoster = createCoinImageRehoster({ storage: h.storage, fetchImage });
    const out = await rehoster.rehost(spec(COIN, LOGO));
    expect(out.launchpadCoin.imageUrl).toBe(`${PUBLIC_BASE}/coin-images/${sha(coin)}.png`);
    expect(out.theme.logoUrl).toBe(`${PUBLIC_BASE}/coin-images/${sha(logo)}.jpg`);

    fetchImage.calls.length = 0;
    const same = await rehoster.rehost(spec(COIN, COIN));
    expect(fetchImage.calls).toEqual([COIN]);
    expect(same.theme.logoUrl).toBe(same.launchpadCoin.imageUrl);
  });

  it('keeps a URL that already is a coin image of the bucket (idempotent re-confirm)', async () => {
    const h = storageHarness();
    const fetchImage = fakeFetch({});
    const rehoster = createCoinImageRehoster({ storage: h.storage, fetchImage });
    const stored = `${PUBLIC_BASE}/coin-images/${'a'.repeat(64)}.png`;
    const out = await rehoster.rehost(spec(stored, stored));
    expect(out).toEqual(spec(stored, stored));
    expect(fetchImage.calls).toEqual([]);
    expect(h.puts).toHaveLength(0);
  });

  it('gives the same URL when the same bytes are confirmed again', async () => {
    const h = storageHarness();
    const bytes = pngBytes();
    const rehoster = createCoinImageRehoster({
      storage: h.storage,
      fetchImage: fakeFetch({ [COIN]: { bytes, contentType: 'image/png' } }),
    });
    const first = await rehoster.rehost(spec(COIN));
    const second = await rehoster.rehost(spec(COIN));
    expect(second).toEqual(first);
    // The second write found the object in place (write-once) and overwrote nothing.
    expect(h.r2.calls.filter((c) => c.method === 'PUT').map((c) => c.status)).toEqual([200, 412]);
  });

  it('copies other keys of the bucket instead of trusting them', () => {
    const { storage } = storageHarness();
    expect(isStoredCoinImageUrl(`${PUBLIC_BASE}/coin-images/${'b'.repeat(64)}.webp`, storage)).toBe(
      true,
    );
    for (const url of [
      `${PUBLIC_BASE}/pending/moonpad/mint.png`,
      `${PUBLIC_BASE}/coin-images/${'b'.repeat(64)}.svg`,
      `${PUBLIC_BASE}/coin-images/${'b'.repeat(64)}.png?v=2`,
      `${PUBLIC_BASE}/coin-images/../pending/${'b'.repeat(64)}.png`,
      `${PUBLIC_BASE}.evil.example/coin-images/${'b'.repeat(64)}.png`,
      `https://other.example/coin-images/${'b'.repeat(64)}.png`,
    ]) {
      expect(isStoredCoinImageUrl(url, storage)).toBe(false);
    }
  });

  it('reports the field and reason of an image that cannot be copied, writing nothing', async () => {
    const h = storageHarness();
    const logger = new MemoryLogger();
    const rehoster = createCoinImageRehoster({
      storage: h.storage,
      fetchImage: fakeFetch({
        [COIN]: { bytes: pngBytes(), contentType: 'image/png' },
        [LOGO]: new ImageFetchError('too_large'),
      }),
      logger,
    });
    const error = await rehoster.rehost(spec(COIN, LOGO)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoinImageUnavailableError);
    expect((error as CoinImageUnavailableError).field).toBe('theme.logoUrl');
    expect((error as CoinImageUnavailableError).reason).toBe('too_large');
    // The coin image downloaded fine but is not stored either: the confirmation fails.
    expect(h.puts).toHaveLength(0);
    const refused = logger.entries.find((e) => e.event === 'coin_image_refused');
    expect(refused?.fields).toEqual({
      field: 'theme.logoUrl',
      reason: 'too_large',
      host: 'images.example.com',
    });
  });

  it('reports the coin image first when both fail', async () => {
    const rehoster = createCoinImageRehoster({
      storage: storageHarness().storage,
      fetchImage: fakeFetch({
        [COIN]: new ImageFetchError('not_an_image'),
        [LOGO]: new ImageFetchError('blocked_address'),
      }),
    });
    const error = (await rehoster
      .rehost(spec(COIN, LOGO))
      .catch((e: unknown) => e)) as CoinImageUnavailableError;
    expect(error.field).toBe('launchpadCoin.imageUrl');
    expect(error.reason).toBe('not_an_image');
  });

  it('lets a storage failure through (a server error, not the owner image)', async () => {
    const h = storageHarness();
    h.r2.failures.push(500, 500, 500);
    const rehoster = createCoinImageRehoster({
      storage: h.storage,
      fetchImage: fakeFetch({ [COIN]: { bytes: pngBytes(), contentType: 'image/png' } }),
    });
    const error = await rehoster.rehost(spec(COIN)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(CoinImageUnavailableError);
    expect((error as Error).name).toBe('StorageError');
  });
});

describe('imageUnavailableMessage', () => {
  it('tells the owner what to do without internal details', () => {
    const big = imageUnavailableMessage(
      new CoinImageUnavailableError('launchpadCoin.imageUrl', 'too_large'),
    );
    expect(big).toContain('coin image is larger than 5 MB');
    expect(big).toContain('give another image URL');
    const notImage = imageUnavailableMessage(
      new CoinImageUnavailableError('theme.logoUrl', 'not_an_image'),
    );
    expect(notImage).toContain('logo is not a PNG, JPEG, WebP or GIF');
    const blocked = imageUnavailableMessage(
      new CoinImageUnavailableError('launchpadCoin.imageUrl', 'blocked_address'),
    );
    expect(blocked).toContain('could not be downloaded');
    expect(blocked).not.toMatch(/address|private|dns/i);
  });
});
