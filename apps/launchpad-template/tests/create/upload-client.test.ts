import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  UploadError,
  createUploadClient,
  resolveForgeApiBase,
  type HttpResponseLike,
  type UploadFetch,
  type UploadRequest,
} from '@/forge/create/upload-client';
import { PNG } from './images';

const API = 'https://forge.example';
const PUBLIC = 'https://cdn.forge.example';
const mint = Keypair.generate().publicKey.toBase58();
const sha = createHash('sha256').update(PNG).digest();

const request: UploadRequest = {
  version: 1,
  mint,
  wallet: Keypair.generate().publicKey.toBase58(),
  coin: { name: 'Moon Coin', symbol: 'MOON', description: 'To the moon' },
  firstBuyLamports: '0',
  image: { contentType: 'image/png', size: PNG.length, sha256: sha.toString('hex') },
  auth: {
    host: 'moon.example',
    nonce: '0123456789abcdef0123456789abcdef',
    issuedAt: '2026-10-11T10:00:00.000Z',
    signature: 'c2ln',
  },
};

function reply(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const goodHeaders = {
  'Content-Type': 'image/png',
  'If-None-Match': '*',
  'x-amz-checksum-sha256': sha.toString('base64'),
};

function ticket(overrides: Record<string, unknown> = {}, image: Record<string, unknown> = {}) {
  return {
    uploadId: 'upl_12345678',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    image: {
      uploadUrl: `https://acc.r2.cloudflarestorage.com/bucket/launchpads/moon/staging/${mint}.png?X-Amz-Signature=abc`,
      method: 'PUT',
      headers: goodHeaders,
      publicUrl: `${PUBLIC}/launchpads/moon/images/${mint}.png`,
      ...image,
    },
    metadata: { publicUrl: `${PUBLIC}/launchpads/moon/metadata/${mint}.json` },
    ...overrides,
  };
}

function receipt() {
  return {
    image: {
      publicUrl: `${PUBLIC}/launchpads/moon/images/${mint}.png`,
      sha256: sha.toString('hex'),
    },
    metadata: {
      publicUrl: `${PUBLIC}/launchpads/moon/metadata/${mint}.json`,
      sha256: 'a'.repeat(64),
    },
  };
}

function client(fetch: UploadFetch) {
  return createUploadClient({
    apiBase: API,
    slug: 'moon',
    publicBaseUrl: PUBLIC,
    fetch,
    sleep: async () => {},
  });
}

describe('createUploadClient', () => {
  it('asks FORGE for a ticket, PUTs the image write-once, completes, returns the public URLs', async () => {
    const fetch = vi
      .fn<UploadFetch>()
      .mockResolvedValueOnce(reply(200, ticket()))
      .mockResolvedValueOnce(reply(200))
      .mockResolvedValueOnce(reply(200, receipt()));
    const uploaded = await client(fetch).uploadCoin(request, PNG);

    expect(uploaded).toEqual({
      imageUrl: `${PUBLIC}/launchpads/moon/images/${mint}.png`,
      metadataUrl: `${PUBLIC}/launchpads/moon/metadata/${mint}.json`,
    });
    const [first, put, complete] = fetch.mock.calls;
    expect(first?.[0]).toBe(`${API}/api/launchpads/moon/uploads`);
    expect(first?.[1].method).toBe('POST');
    expect(JSON.parse(first?.[1].body as string)).toEqual(request);
    expect(put?.[1].method).toBe('PUT');
    expect(put?.[1].headers).toEqual({
      'content-type': 'image/png',
      'if-none-match': '*',
      'x-amz-checksum-sha256': sha.toString('base64'),
    });
    expect(put?.[1].body).toBe(PNG);
    expect(complete?.[0]).toBe(`${API}/api/launchpads/moon/uploads/upl_12345678/complete`);
    expect(JSON.parse(complete?.[1].body as string)).toEqual({ mint });
    // No storage credential ever leaves the site.
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/R2_|SECRET|ACCESS_KEY|api-key/i);
  });

  it('refuses a ticket that would allow an overwrite (no If-None-Match)', async () => {
    const answer = ticket(
      {},
      {
        headers: {
          'Content-Type': 'image/png',
          'x-amz-checksum-sha256': sha.toString('base64'),
        },
      },
    );
    const fetch = vi.fn<UploadFetch>().mockResolvedValueOnce(reply(200, answer));
    await expect(client(fetch).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'invalid_answer',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a ticket with extra headers, another type or checksum, or URLs outside the bucket', async () => {
    const cases = [
      ticket({}, { headers: { ...goodHeaders, 'x-amz-acl': 'public-read-write' } }),
      ticket({}, { headers: { ...goodHeaders, 'Content-Type': 'text/html' } }),
      ticket(
        {},
        {
          headers: {
            ...goodHeaders,
            'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64'),
          },
        },
      ),
      ticket({}, { publicUrl: `https://evil.example/launchpads/moon/images/${mint}.png` }),
      ticket({ metadata: { publicUrl: `${PUBLIC}/launchpads/moon/metadata/other.json` } }),
      ticket({}, { uploadUrl: 'http://acc.r2.cloudflarestorage.com/x' }),
      ticket({ expiresAt: new Date(Date.now() + 1000).toISOString() }),
      { nonsense: true },
    ];
    for (const answer of cases) {
      const fetch = vi.fn<UploadFetch>().mockResolvedValueOnce(reply(200, answer));
      await expect(client(fetch).uploadCoin(request, PNG)).rejects.toBeInstanceOf(UploadError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('never overwrites: a 412 on the first PUT stops everything', async () => {
    const fetch = vi
      .fn<UploadFetch>()
      .mockResolvedValueOnce(reply(200, ticket()))
      .mockResolvedValueOnce(reply(412));
    await expect(client(fetch).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a 412 after a retried PUT (our own lost attempt) is left to complete to check', async () => {
    const fetch = vi
      .fn<UploadFetch>()
      .mockResolvedValueOnce(reply(200, ticket()))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(reply(412))
      .mockResolvedValueOnce(reply(200, receipt()));
    await expect(client(fetch).uploadCoin(request, PNG)).resolves.toMatchObject({
      metadataUrl: `${PUBLIC}/launchpads/moon/metadata/${mint}.json`,
    });
  });

  it('retries network errors and 5xx, then gives up with a clear error', async () => {
    const fetch = vi
      .fn<UploadFetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, ticket()))
      .mockResolvedValueOnce(reply(200))
      .mockResolvedValueOnce(reply(200, receipt()));
    await expect(client(fetch).uploadCoin(request, PNG)).resolves.toBeTruthy();

    const down = vi.fn<UploadFetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client(down).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(down).toHaveBeenCalledTimes(3);
  });

  it('surfaces FORGE refusals and rate limits without retrying them', async () => {
    const limited = vi
      .fn<UploadFetch>()
      .mockResolvedValue(
        reply(
          429,
          { error: { code: 'rate_limited', message: 'slow down' } },
          { 'retry-after': '120' },
        ),
      );
    await expect(client(limited).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfter: 120,
    });
    expect(limited).toHaveBeenCalledTimes(1);

    const refused = vi
      .fn<UploadFetch>()
      .mockResolvedValue(reply(401, { error: { code: 'unauthorized', message: 'bad signature' } }));
    await expect(client(refused).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'refused',
      status: 401,
      message: 'bad signature',
    });
  });

  it('refuses a receipt that does not match the ticket', async () => {
    const fetch = vi
      .fn<UploadFetch>()
      .mockResolvedValueOnce(reply(200, ticket()))
      .mockResolvedValueOnce(reply(200))
      .mockResolvedValueOnce(
        reply(200, {
          ...receipt(),
          metadata: { publicUrl: `${PUBLIC}/x/${mint}.json`, sha256: 'b'.repeat(64) },
        }),
      );
    await expect(client(fetch).uploadCoin(request, PNG)).rejects.toMatchObject({
      code: 'invalid_answer',
    });
  });

  it('refuses an image that does not match its descriptor, before any call', async () => {
    const fetch = vi.fn<UploadFetch>();
    await expect(client(fetch).uploadCoin(request, PNG.slice(1))).rejects.toBeInstanceOf(
      UploadError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('resolveForgeApiBase', () => {
  it('uses NEXT_PUBLIC_FORGE_API_URL, else the relay origin', () => {
    expect(resolveForgeApiBase('https://api.forge.example/', undefined)).toBe(
      'https://api.forge.example',
    );
    expect(resolveForgeApiBase(undefined, 'https://forge.example/api/rpc')).toBe(
      'https://forge.example',
    );
    expect(resolveForgeApiBase(undefined, 'https://forge.example')).toBe('https://forge.example');
  });

  it('refuses plain http (except localhost) and credentials in the URL', () => {
    expect(resolveForgeApiBase('http://forge.example', undefined)).toBeNull();
    expect(resolveForgeApiBase(undefined, 'http://localhost:3000/api/rpc')).toBe(
      'http://localhost:3000',
    );
    expect(resolveForgeApiBase('https://user:pass@forge.example', undefined)).toBeNull();
    expect(resolveForgeApiBase(undefined, undefined)).toBeNull();
  });
});
