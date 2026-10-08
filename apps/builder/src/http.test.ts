/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, parseRetryAfter, redactSecrets, ServiceError } from './http.js';
import { empty, json, stubFetch, type Route } from './http-mock.js';

function make(routes: Route[], extra: Record<string, unknown> = {}) {
  const stub = stubFetch(routes);
  const sleeps: number[] = [];
  const client = createHttpClient({
    service: 'github',
    baseUrl: 'https://api.example.test/',
    fetch: stub.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    retryBaseMs: 100,
    now: () => 1_000_000,
    ...extra,
  });
  return { stub, client, sleeps };
}

describe('retries', () => {
  it('retries GET on 5xx with exponential backoff, then succeeds', async () => {
    const { stub, client, sleeps } = make([
      { method: 'GET', path: '/x', times: 2, handler: () => json({ message: 'boom' }, 502) },
      { method: 'GET', path: '/x', handler: () => json({ ok: true }) },
    ]);
    const res = await client.request({ method: 'GET', path: '/x' });
    expect(res.json).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('does not replay a non-idempotent POST after a 5xx', async () => {
    const { stub, client } = make([
      { method: 'POST', path: '/x', handler: () => json({ message: 'boom' }, 500) },
    ]);
    await expect(client.request({ method: 'POST', path: '/x', body: {} })).rejects.toMatchObject({
      kind: 'server',
      status: 500,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('replays an idempotent POST after a 5xx', async () => {
    const { stub, client } = make([
      { method: 'POST', path: '/x', times: 1, handler: () => json({}, 503) },
      { method: 'POST', path: '/x', handler: () => json({ ok: 1 }, 201) },
    ]);
    const res = await client.request({ method: 'POST', path: '/x', body: {}, idempotent: true });
    expect(res.status).toBe(201);
    expect(stub.calls).toHaveLength(2);
  });

  it('retries 429 even for a non-idempotent POST and honors Retry-After seconds', async () => {
    const { stub, client, sleeps } = make([
      {
        method: 'POST',
        path: '/x',
        times: 1,
        handler: () => json({}, 429, { 'retry-after': '7' }),
      },
      { method: 'POST', path: '/x', handler: () => json({ ok: 1 }) },
    ]);
    await client.request({ method: 'POST', path: '/x', body: {} });
    expect(stub.calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('treats a 403 with x-ratelimit-remaining 0 as a rate limit and waits for the reset', async () => {
    // now() is 1_000_000 ms, i.e. 1000 s: a reset at 1005 s means 5 s plus a 1 s margin.
    const { client, sleeps } = make([
      {
        method: 'GET',
        path: '/x',
        times: 1,
        handler: () =>
          json({ message: 'rate limit' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1005',
          }),
      },
      { method: 'GET', path: '/x', handler: () => json({ ok: 1 }) },
    ]);
    await client.request({ method: 'GET', path: '/x' });
    expect(sleeps).toEqual([6000]);
  });

  it('a plain 403 is not retried', async () => {
    const { stub, client } = make([
      {
        method: 'GET',
        path: '/x',
        handler: () => json({ message: 'Resource not accessible' }, 403),
      },
    ]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('gives up on a server-requested wait longer than the cap', async () => {
    const { stub, client } = make(
      [{ method: 'GET', path: '/x', handler: () => json({}, 429, { 'retry-after': '600' }) }],
      { maxRetryWaitMs: 30_000 },
    );
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 600_000,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('stops after maxAttempts and reports the last status', async () => {
    const { stub, client } = make(
      [{ method: 'GET', path: '/x', handler: () => json({ message: 'down' }, 503) }],
      { maxAttempts: 3 },
    );
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      kind: 'server',
      status: 503,
    });
    expect(stub.calls).toHaveLength(3);
  });

  it('retries network errors on GET and maps them to a typed error when exhausted', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createHttpClient({
      service: 'vercel',
      baseUrl: 'https://x.test',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxAttempts: 3,
    });
    const err = await client.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ kind: 'network', service: 'vercel' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not replay a non-idempotent POST after a network error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createHttpClient({
      service: 'github',
      baseUrl: 'https://x.test',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(client.request({ method: 'POST', path: '/x', body: {} })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [400, 'validation'],
    [418, 'unexpected'],
  ])('maps %i to %s', async (status, kind) => {
    const { client } = make([
      { method: 'GET', path: '/x', handler: () => json({ message: 'm' }, status) },
    ]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      kind,
      status,
    });
  });

  it('reads the Vercel error shape and exposes the code', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/x',
        handler: () => json({ error: { code: 'forbidden', message: 'Not authorized' } }, 403),
      },
    ]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      apiCode: 'forbidden',
      message: expect.stringContaining('Not authorized'),
    });
  });

  it('returns allowed statuses instead of throwing', async () => {
    const { client } = make([{ method: 'GET', path: '/x', handler: () => empty(404) }]);
    const res = await client.request({ method: 'GET', path: '/x', allowStatus: [404] });
    expect(res.status).toBe(404);
  });

  it('rejects a 2xx body that is not JSON', async () => {
    const { client } = make([
      { method: 'GET', path: '/x', handler: () => new Response('<html>', { status: 200 }) },
    ]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('never puts credentials in error messages', async () => {
    const secret = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const { client } = make([
      {
        method: 'GET',
        path: '/x',
        handler: () => json({ message: `bad token ${secret} Bearer abcdefghijklmnop` }, 401),
      },
    ]);
    const err = (await client
      .request({ method: 'GET', path: '/x', authorization: async () => `Bearer ${secret}` })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(err)).not.toContain(secret);
  });
});

describe('request building', () => {
  it('serializes query and JSON body, resolves authorization per attempt', async () => {
    const { stub, client } = make([
      { method: 'POST', path: '/a/b', times: 1, handler: () => json({}, 502) },
      { method: 'POST', path: '/a/b', handler: () => json({ ok: 1 }) },
    ]);
    const auth = vi.fn(async () => 'Bearer t');
    await client.request({
      method: 'POST',
      path: '/a/b',
      query: { q: 'x y', skip: undefined, n: 2 },
      body: { a: 1 },
      authorization: auth,
      idempotent: true,
    });
    expect(auth).toHaveBeenCalledTimes(2);
    const call = stub.calls[0];
    expect(call?.url).toBe('/a/b?q=x+y&n=2');
    expect(call?.body).toEqual({ a: 1 });
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['authorization']).toBe('Bearer t');
  });

  it('rejects a path without a leading slash', async () => {
    const { client } = make([]);
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });
});

describe('helpers', () => {
  it('parses Retry-After in seconds and as an HTTP date', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it('redacts GitHub tokens, JWTs and bearer values', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlc2lnbmF0dXJl';
    const out = redactSecrets(`a ghp_0123456789abcdefghij b ${jwt} c Bearer abcdefghijklmnop`);
    expect(out).toBe('a [redacted] b [redacted] c [redacted]');
  });
});
