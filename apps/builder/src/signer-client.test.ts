/// <reference types="node" />
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSignerClient, SignerClientError } from './signer-client.js';

const SECRET = 'a'.repeat(32);
const JOB = '3f2b8c1e-9d4a-4b6e-8a1c-2d3e4f5a6b7c';
const ADDR = '11111111111111111111111111111112';
const NOW = 1_700_000_000_000;
const NONCE_RE = /^[0-9a-f]{32}$/;

/** The signed string documented on `signerSignedPayload` (packages/shared), rebuilt by hand. */
function expectedSignature(method: string, path: string, ts: string, nonce: string, body: string) {
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  return createHmac('sha256', SECRET)
    .update(['forge-signer-v2', method, path, ts, nonce, bodySha256].join('\n'))
    .digest('hex');
}

function sentHeaders(fetchMock: { mock: { calls: unknown[][] } }, call = 0) {
  return (fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function make(fetchMock: unknown, extra: Record<string, unknown> = {}) {
  return createSignerClient({
    baseUrl: 'http://signer:8787/',
    hmacSecret: SECRET,
    fetch: fetchMock as typeof fetch,
    now: () => NOW,
    timeoutMs: 1000,
    sleep: async () => {},
    ...extra,
  });
}

describe('createSignerClient', () => {
  it('refuses short secrets', () => {
    expect(() =>
      createSignerClient({ baseUrl: 'http://x', hmacSecret: 'short', timeoutMs: 1 }),
    ).toThrow(/32 bytes/);
  });

  it('signs the method, the path, the timestamp, the nonce and the body hash', async () => {
    const fetchMock = vi.fn(async () => json({ launchpadConfig: ADDR, launchpadCoinConfig: ADDR }));
    const res = await make(fetchMock).createConfigs(JOB);
    expect(res.launchpadConfig).toBe(ADDR);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://signer:8787/v1/configs');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toBe(JSON.stringify({ jobId: JOB }));
    const headers = init.headers as Record<string, string>;
    const ts = headers['X-Forge-Timestamp'] as string;
    expect(ts).toBe(String(NOW / 1000));
    const nonce = headers['X-Forge-Nonce'] as string;
    expect(nonce).toMatch(NONCE_RE);
    expect(headers['X-Forge-Signature']).toBe(
      expectedSignature('POST', '/v1/configs', ts, nonce, body),
    );
  });

  it('signs an empty body for health', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    expect(await make(fetchMock).health()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://signer:8787/v1/health');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Forge-Signature']).toBe(
      expectedSignature(
        'GET',
        '/v1/health',
        headers['X-Forge-Timestamp'] as string,
        headers['X-Forge-Nonce'] as string,
        '',
      ),
    );
  });

  it('gives the same body a different signature on each route', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/v1/configs')
        ? json({ launchpadConfig: ADDR, launchpadCoinConfig: ADDR })
        : json({ partiallySignedTx: 'AAAA', mint: ADDR }),
    );
    const client = make(fetchMock, { nonce: () => 'ab'.repeat(16) });
    await client.createConfigs(JOB);
    await client.prepareLaunchCoin(JOB);
    const configs = sentHeaders(fetchMock, 0);
    const prepare = sentHeaders(fetchMock, 1);
    // Same body, same second, same nonce: only the route differs, and so does the MAC.
    expect(configs['X-Forge-Timestamp']).toBe(prepare['X-Forge-Timestamp']);
    expect(configs['X-Forge-Nonce']).toBe(prepare['X-Forge-Nonce']);
    expect(configs['X-Forge-Signature']).not.toBe(prepare['X-Forge-Signature']);
    const body = JSON.stringify({ jobId: JOB });
    const ts = String(NOW / 1000);
    const nonce = 'ab'.repeat(16);
    expect(prepare['X-Forge-Signature']).toBe(
      expectedSignature('POST', '/v1/launch-coin/prepare', ts, nonce, body),
    );
    expect(prepare['X-Forge-Signature']).not.toBe(
      expectedSignature('POST', '/v1/configs', ts, nonce, body),
    );
  });

  it('signs the path of a base URL with a prefix, as requested', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    await make(fetchMock, { baseUrl: 'http://signer:8787/internal/' }).health();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://signer:8787/internal/v1/health');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Forge-Signature']).toBe(
      expectedSignature(
        'GET',
        '/internal/v1/health',
        headers['X-Forge-Timestamp'] as string,
        headers['X-Forge-Nonce'] as string,
        '',
      ),
    );
  });

  it('uses a fresh nonce on every attempt, even within the same second', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ ok: true }));
    expect(await make(fetchMock).health()).toEqual({ ok: true });
    const attempts = [0, 1, 2].map((i) => sentHeaders(fetchMock, i));
    for (const headers of attempts) {
      expect(headers['X-Forge-Timestamp']).toBe(String(NOW / 1000));
      expect(headers['X-Forge-Nonce']).toMatch(NONCE_RE);
      expect(headers['X-Forge-Signature']).toBe(
        expectedSignature(
          'GET',
          '/v1/health',
          headers['X-Forge-Timestamp'] as string,
          headers['X-Forge-Nonce'] as string,
          '',
        ),
      );
    }
    expect(new Set(attempts.map((h) => h['X-Forge-Nonce'])).size).toBe(3);
    expect(new Set(attempts.map((h) => h['X-Forge-Signature'])).size).toBe(3);
  });

  it('refuses to sign with a nonce outside the format', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    await expect(make(fetchMock, { nonce: () => 'not-hex' }).health()).rejects.toThrow(
      /invalid nonce/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prepares the launch coin route', async () => {
    const fetchMock = vi.fn(async () => json({ partiallySignedTx: 'AAAA', mint: ADDR }));
    const res = await make(fetchMock).prepareLaunchCoin(JOB);
    expect(res.mint).toBe(ADDR);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://signer:8787/v1/launch-coin/prepare',
    );
  });

  it('keeps the optional summary and details of the prepare answer', async () => {
    const summary = {
      coinName: 'Moon',
      coinSymbol: 'MOON',
      firstBuyLamports: '500000000',
      estimatedNetworkFeeLamports: '25000000',
      ownerWallet: ADDR,
    };
    const fetchMock = vi.fn(async () =>
      json({
        partiallySignedTx: 'AAAA',
        mint: ADDR,
        summary,
        details: { nonce: 'n', rebuilds: 1 },
        extra: 'dropped',
      }),
    );
    const res = await make(fetchMock).prepareLaunchCoin(JOB);
    expect(res).toEqual({
      partiallySignedTx: 'AAAA',
      mint: ADDR,
      summary,
      details: { nonce: 'n', rebuilds: 1 },
    });
  });

  it('drops a malformed summary or details instead of failing the launch', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        partiallySignedTx: 'AAAA',
        mint: ADDR,
        summary: { coinName: 'Moon', firstBuyLamports: 12 },
        details: 'not an object',
      }),
    );
    expect(await make(fetchMock).prepareLaunchCoin(JOB)).toEqual({
      partiallySignedTx: 'AAAA',
      mint: ADDR,
    });
  });

  it('still refuses a prepare answer without a valid transaction or mint', async () => {
    for (const body of [
      { mint: ADDR, summary: {} },
      { partiallySignedTx: 'AAAA', mint: 'not-an-address' },
    ]) {
      const fetchMock = vi.fn(async () => json(body));
      await expect(make(fetchMock).prepareLaunchCoin(JOB)).rejects.toBeInstanceOf(
        SignerClientError,
      );
    }
  });

  it('tolerates the optional health fields, well formed or not', async () => {
    const full = { ok: true, cluster: 'devnet', uptimeSeconds: 12, jobs: { claims: 'idle' } };
    expect(await make(vi.fn(async () => json(full))).health()).toEqual(full);
    expect(
      await make(vi.fn(async () => json({ ok: false, cluster: 3, uptimeSeconds: 'x' }))).health(),
    ).toEqual({ ok: false });
    await expect(make(vi.fn(async () => json({ cluster: 'devnet' }))).health()).rejects.toThrow();
  });

  it('rejects responses that fail schema validation', async () => {
    const fetchMock = vi.fn(async () => json({ launchpadConfig: 'nope' }));
    await expect(make(fetchMock).createConfigs(JOB)).rejects.toBeInstanceOf(SignerClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'bad' }, 401));
    await expect(make(fetchMock).health()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds, with backoff', async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ ok: true }));
    expect(await make(fetchMock, { sleep, retryBaseMs: 100 }).health()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it('gives up after maxAttempts', async () => {
    const fetchMock = vi.fn(async () => json({}, 500));
    await expect(make(fetchMock, { maxAttempts: 2 }).health()).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal that fires on timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const client = make(fetchMock, { timeoutMs: 20, maxAttempts: 1 });
    await expect(client.health()).rejects.toBeInstanceOf(SignerClientError);
  });
});
