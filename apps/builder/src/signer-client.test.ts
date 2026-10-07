/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSignerClient, SignerClientError } from './signer-client.js';

const SECRET = 'a'.repeat(32);
const JOB = '3f2b8c1e-9d4a-4b6e-8a1c-2d3e4f5a6b7c';
const ADDR = '11111111111111111111111111111112';
const NOW = 1_700_000_000_000;

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

  it('signs "<ts>.<raw body>" and sends the exact same bytes', async () => {
    const fetchMock = vi.fn(async () =>
      json({ launchpadConfig: ADDR, launchpadCoinConfig: ADDR }),
    );
    const res = await make(fetchMock).createConfigs(JOB);
    expect(res.launchpadConfig).toBe(ADDR);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://signer:8787/v1/configs');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toBe(JSON.stringify({ jobId: JOB }));
    const headers = init.headers as Record<string, string>;
    const ts = headers['X-Forge-Timestamp'];
    expect(ts).toBe(String(NOW / 1000));
    const expected = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(headers['X-Forge-Signature']).toBe(expected);
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
      createHmac('sha256', SECRET).update(`${headers['X-Forge-Timestamp']}.`).digest('hex'),
    );
  });

  it('prepares the launch coin route', async () => {
    const fetchMock = vi.fn(async () => json({ partiallySignedTx: 'AAAA', mint: ADDR }));
    const res = await make(fetchMock).prepareLaunchCoin(JOB);
    expect(res.mint).toBe(ADDR);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://signer:8787/v1/launch-coin/prepare',
    );
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
