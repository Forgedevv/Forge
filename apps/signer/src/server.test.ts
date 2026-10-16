import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
  SIGNER_NONCE_HEADER,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
} from '@forge/shared';
import {
  createSignerServer,
  loadSignerServerEnv,
  signRequest,
  stubSignerRoutes,
  type SignerRouteHandlers,
  type SignerServerOptions,
} from './server.js';
import { ReplayCache } from './http/replay.js';
import { normalizeIp, parseAllowedIps } from './http/ip.js';

const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
const NOW = 1_800_000_000_000;
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CONFIG = '11111111111111111111111111111111';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

interface Started {
  port: number;
  clock: { now: number };
}

async function start(overrides: Partial<SignerServerOptions> = {}): Promise<Started> {
  const clock = { now: NOW };
  const server = createSignerServer({
    hmacSecret: SECRET,
    routes: stubSignerRoutes,
    now: () => clock.now,
    production: false,
    logger: pino({ level: 'silent' }),
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, clock };
}

interface Reply {
  status: number;
  body: unknown;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | Buffer = '',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Distinct timestamps (within the window), on top of the fresh nonce of every signRequest call.
let tick = 0;
function nextAt(): number {
  tick = (tick + 1) % 50;
  return NOW - tick * 1000;
}

function signed(port: number, method: string, path: string, body = '', at = nextAt()) {
  return send(port, method, path, signRequest(SECRET, { method, path, body }, at), body);
}

const configsBody = JSON.stringify({ jobId: JOB_ID });
const configsReq = { method: 'POST', path: '/v1/configs', body: configsBody };
const healthReq = { method: 'GET', path: '/v1/health' };

describe('createSignerServer', () => {
  it('refuses a secret shorter than 32 bytes', () => {
    expect(() =>
      createSignerServer({ hmacSecret: 'x'.repeat(31), routes: stubSignerRoutes }),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      createSignerServer({
        hmacSecret: 'x'.repeat(32),
        routes: stubSignerRoutes,
        production: false,
      }),
    ).not.toThrow();
  });

  it('answers a valid health request', async () => {
    const { port } = await start();
    const res = await signed(port, 'GET', '/v1/health');
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it('returns 501 from the stub signing routes after authentication', async () => {
    const { port } = await start();
    expect((await signed(port, 'POST', '/v1/configs', configsBody)).status).toBe(501);
    expect((await signed(port, 'POST', '/v1/launch-coin/prepare', configsBody)).status).toBe(501);
  });

  it('passes the validated body to the handler and filters the response', async () => {
    const configs = vi.fn(async () => ({
      ok: true as const,
      body: { launchpadConfig: CONFIG, launchpadCoinConfig: CONFIG, extra: 'leak' },
    }));
    const routes: SignerRouteHandlers = { ...stubSignerRoutes, configs };
    const { port } = await start({ routes });
    const res = await signed(port, 'POST', '/v1/configs', configsBody);
    expect(res).toEqual({
      status: 200,
      body: { launchpadConfig: CONFIG, launchpadCoinConfig: CONFIG },
    });
    expect(configs).toHaveBeenCalledWith({ jobId: JOB_ID });
  });

  it('rejects a bad signature', async () => {
    const { port } = await start();
    const headers = signRequest('another-secret-0123456789-abcdefghijk', configsReq, NOW);
    const res = await send(port, 'POST', '/v1/configs', headers, configsBody);
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('rejects malformed signatures (uppercase, short, non hex)', async () => {
    const { port } = await start();
    const good = signRequest(SECRET, configsReq, NOW);
    const sig = good[SIGNER_SIGNATURE_HEADER] as string;
    for (const bad of [sig.toUpperCase(), sig.slice(0, 63), `${sig}00`, 'z'.repeat(64)]) {
      const res = await send(
        port,
        'POST',
        '/v1/configs',
        { ...good, [SIGNER_SIGNATURE_HEADER]: bad },
        configsBody,
      );
      expect(res.status).toBe(401);
    }
  });

  it('rejects a tampered body', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, configsReq, NOW);
    const tampered = JSON.stringify({ jobId: '00000000-0000-4000-8000-000000000000' });
    const res = await send(port, 'POST', '/v1/configs', headers, tampered);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered timestamp', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, configsReq, NOW);
    const ts = Number(headers[SIGNER_TIMESTAMP_HEADER]) + 1;
    const res = await send(
      port,
      'POST',
      '/v1/configs',
      { ...headers, [SIGNER_TIMESTAMP_HEADER]: String(ts) },
      configsBody,
    );
    expect(res.status).toBe(401);
  });

  it('rejects timestamps outside the 60 s window and accepts its edges', async () => {
    const { port } = await start();
    expect((await signed(port, 'GET', '/v1/health', '', NOW - 61_000)).status).toBe(401);
    expect((await signed(port, 'GET', '/v1/health', '', NOW + 61_000)).status).toBe(401);
    expect((await signed(port, 'GET', '/v1/health', '', NOW - 60_000)).status).toBe(200);
    expect((await signed(port, 'GET', '/v1/health', '', NOW + 60_000)).status).toBe(200);
  });

  it('rejects malformed timestamps even when signed', async () => {
    const { port } = await start();
    const seconds = String(NOW / 1000);
    const nonce = 'a'.repeat(32);
    // A correct MAC over the malformed timestamp itself: only the format check can refuse it.
    const emptyBody = createHash('sha256').digest('hex');
    const sign = (ts: string, n: string) =>
      createHmac('sha256', SECRET)
        .update(['forge-signer-v2', 'GET', '/v1/health', ts, n, emptyBody].join('\n'))
        .digest('hex');
    for (const ts of [`${seconds}.0`, `+${seconds}`, `-${seconds}`, '1.8e9', '0x6b49d200', '']) {
      const res = await send(port, 'GET', '/v1/health', {
        [SIGNER_TIMESTAMP_HEADER]: ts,
        [SIGNER_NONCE_HEADER]: nonce,
        [SIGNER_SIGNATURE_HEADER]: sign(ts, nonce),
      });
      expect(res.status).toBe(401);
    }
  });

  it('rejects a replayed request, on the same or another route', async () => {
    const configs = vi.fn(stubSignerRoutes.configs);
    const { port, clock } = await start({ routes: { ...stubSignerRoutes, configs } });
    const headers = signRequest(SECRET, configsReq, NOW);
    expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(501);
    expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(401);
    expect((await send(port, 'POST', '/v1/launch-coin/prepare', headers, configsBody)).status).toBe(
      401,
    );
    clock.now = NOW + 30_000;
    expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(401);
    clock.now = NOW + 61_000;
    expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(401);
    expect(configs).toHaveBeenCalledTimes(1);
  });

  describe('signature bound to the method, the path and the query string', () => {
    it('refuses a valid signature replayed on another route, method or path spelling', async () => {
      const configs = vi.fn(stubSignerRoutes.configs);
      const launchCoinPrepare = vi.fn(stubSignerRoutes.launchCoinPrepare);
      const { port } = await start({ routes: { ...stubSignerRoutes, configs, launchCoinPrepare } });
      const headers = signRequest(SECRET, configsReq, NOW);
      const replays: [string, string][] = [
        ['POST', '/v1/launch-coin/prepare'],
        ['PUT', '/v1/configs'],
        ['POST', '/v1/configs?retry=1'],
        ['POST', '/v1/configs?'],
        ['POST', '/v1/configs/'],
        ['POST', '/v1//configs'],
        ['POST', '/V1/configs'],
      ];
      for (const [method, path] of replays) {
        const res = await send(port, method, path, headers, configsBody);
        expect(res, `${method} ${path}`).toEqual({ status: 401, body: { error: 'unauthorized' } });
      }
      expect(configs).not.toHaveBeenCalled();
      expect(launchCoinPrepare).not.toHaveBeenCalled();
      // The refused attempts did not consume the nonce: the genuine request still passes, once.
      expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(501);
      expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(401);
      expect(configs).toHaveBeenCalledTimes(1);
    });

    it('refuses a GET signature on another method or another query string', async () => {
      const { port } = await start();
      const health = signRequest(SECRET, healthReq, NOW);
      expect((await send(port, 'POST', '/v1/health', health)).status).toBe(401);
      expect((await send(port, 'HEAD', '/v1/health', health)).status).toBe(401);
      expect((await send(port, 'GET', '/v1/health?x=1', health)).status).toBe(401);
      const withQuery = signRequest(SECRET, { method: 'GET', path: '/v1/health?x=1' }, NOW);
      expect((await send(port, 'GET', '/v1/health', withQuery)).status).toBe(401);
      expect((await send(port, 'GET', '/v1/health?x=2', withQuery)).status).toBe(401);
      expect((await send(port, 'GET', '/v1/health?x=1&x=1', withQuery)).status).toBe(401);
      // Each signature verifies on its own target only (the query one then has no route).
      expect((await send(port, 'GET', '/v1/health?x=1', withQuery)).status).toBe(404);
      expect(await send(port, 'GET', '/v1/health', health)).toEqual({
        status: 200,
        body: { ok: true },
      });
    });

    it('refuses a tampered or malformed nonce, and a nonce reused under a fresh signature', async () => {
      const { port } = await start();
      const nonce = '0123456789abcdef0123456789abcdef';
      const headers = signRequest(SECRET, { ...healthReq, nonce }, NOW);
      expect(headers[SIGNER_NONCE_HEADER]).toBe(nonce);
      for (const bad of [
        `1${nonce.slice(1)}`,
        nonce.toUpperCase(),
        nonce.slice(0, 31),
        `${nonce}00`,
        'z'.repeat(32),
        '',
      ]) {
        const res = await send(port, 'GET', '/v1/health', {
          ...headers,
          [SIGNER_NONCE_HEADER]: bad,
        });
        expect(res.status, bad).toBe(401);
      }
      expect((await send(port, 'GET', '/v1/health', headers)).status).toBe(200);
      const reused = signRequest(SECRET, { ...healthReq, nonce }, NOW - 1_000);
      expect(reused[SIGNER_SIGNATURE_HEADER]).not.toBe(headers[SIGNER_SIGNATURE_HEADER]);
      expect((await send(port, 'GET', '/v1/health', reused)).status).toBe(401);
    });

    it('accepts a MAC computed independently from the documented signed string', async () => {
      const { port } = await start();
      const ts = String(NOW / 1000);
      const nonce = 'fedcba9876543210fedcba9876543210';
      const signedString = [
        'forge-signer-v2',
        'POST',
        '/v1/configs',
        ts,
        nonce,
        createHash('sha256').update(configsBody, 'utf8').digest('hex'),
      ].join('\n');
      const signature = createHmac('sha256', SECRET).update(signedString, 'utf8').digest('hex');
      expect(signRequest(SECRET, { ...configsReq, nonce }, NOW)[SIGNER_SIGNATURE_HEADER]).toBe(
        signature,
      );
      const res = await send(
        port,
        'POST',
        '/v1/configs',
        {
          [SIGNER_TIMESTAMP_HEADER]: ts,
          [SIGNER_NONCE_HEADER]: nonce,
          [SIGNER_SIGNATURE_HEADER]: signature,
        },
        configsBody,
      );
      expect(res.status).toBe(501);
    });
  });

  it('rejects concurrent identical requests except one', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, healthReq, NOW);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(port, 'GET', '/v1/health', headers)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
  });

  it('rejects missing headers', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, configsReq, NOW);
    const without = (name: string) =>
      Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
    expect((await send(port, 'POST', '/v1/configs', {}, configsBody)).status).toBe(401);
    for (const name of [SIGNER_TIMESTAMP_HEADER, SIGNER_NONCE_HEADER, SIGNER_SIGNATURE_HEADER]) {
      expect((await send(port, 'POST', '/v1/configs', without(name), configsBody)).status).toBe(
        401,
      );
    }
    // All three present: the same request passes.
    expect((await send(port, 'POST', '/v1/configs', headers, configsBody)).status).toBe(501);
  });

  it('rejects an oversized body before checking anything else', async () => {
    const { port } = await start({ maxBodyBytes: 1024 });
    const big = JSON.stringify({ jobId: JOB_ID, pad: 'a'.repeat(2000) });
    const res = await signed(port, 'POST', '/v1/configs', big);
    expect(res).toEqual({ status: 413, body: { error: 'payload_too_large' } });
  });

  it('rejects an oversized chunked body', async () => {
    const { port } = await start({ maxBodyBytes: 1024 });
    const res = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/configs' }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('a'.repeat(800));
      req.end('a'.repeat(800));
    });
    expect(res).toBe(413);
  });

  it('accepts a body at the default 16 KB limit and rejects one byte more', async () => {
    const { port } = await start();
    // Valid signature, invalid schema: reaching 400 proves the size check passed.
    const atLimit = JSON.stringify({ x: 'a'.repeat(16 * 1024 - 8) });
    expect(Buffer.byteLength(atLimit)).toBe(16 * 1024);
    expect((await signed(port, 'POST', '/v1/configs', atLimit)).status).toBe(400);
    const over = `${atLimit} `;
    expect((await signed(port, 'POST', '/v1/configs', over)).status).toBe(413);
  });

  it('rejects unknown routes and wrong methods after authentication only', async () => {
    const { port } = await start();
    expect((await signed(port, 'POST', '/v1/unknown', configsBody)).status).toBe(404);
    expect((await signed(port, 'GET', '/v1/configs')).status).toBe(404);
    expect((await signed(port, 'POST', '/v1/health')).status).toBe(404);
    expect((await signed(port, 'GET', '/v1/health?x=1')).status).toBe(404);
    // Without a valid signature, an unknown route looks like any other unauthenticated request.
    expect((await send(port, 'POST', '/v1/unknown', {}, configsBody)).status).toBe(401);
  });

  it('rejects a non-allowlisted IP with 403, even with a valid signature', async () => {
    const { port } = await start({ allowedIps: ['10.0.0.1'] });
    const res = await signed(port, 'GET', '/v1/health');
    expect(res).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it('accepts an allowlisted IP', async () => {
    const { port } = await start({ allowedIps: ['127.0.0.1'], production: true });
    expect((await signed(port, 'GET', '/v1/health')).status).toBe(200);
  });

  it('denies everything in production when the allowlist is empty', async () => {
    const { port } = await start({ allowedIps: [], production: true });
    expect((await signed(port, 'GET', '/v1/health')).status).toBe(403);
  });

  it('allows loopback outside production when the allowlist is empty', async () => {
    const { port } = await start({ allowedIps: [], production: false });
    expect((await signed(port, 'GET', '/v1/health')).status).toBe(200);
  });

  it('rejects unknown JSON keys and invalid bodies', async () => {
    const { port } = await start();
    const bodies = [
      JSON.stringify({ jobId: JOB_ID, ownerWallet: CONFIG }),
      JSON.stringify({ jobId: 'not-a-uuid' }),
      JSON.stringify({}),
      JSON.stringify([JOB_ID]),
      '{"jobId":',
      '',
    ];
    for (const body of bodies) {
      expect((await signed(port, 'POST', '/v1/configs', body)).status).toBe(400);
    }
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
    const headers = signRequest(SECRET, { ...configsReq, body: invalidUtf8 }, NOW);
    const res = await send(port, 'POST', '/v1/configs', headers, invalidUtf8);
    expect(res.status).toBe(400);
  });

  it('rejects a health request with a body', async () => {
    const { port } = await start();
    expect((await signed(port, 'GET', '/v1/health', '{}')).status).toBe(400);
  });

  it('answers 500 without detail when a handler throws or returns an invalid body', async () => {
    const routes: SignerRouteHandlers = {
      ...stubSignerRoutes,
      configs: async () => {
        throw new Error('secret detail');
      },
      launchCoinPrepare: async () => ({
        ok: true,
        body: { partiallySignedTx: '', mint: 'bad' },
      }),
    };
    const { port } = await start({ routes });
    expect(await signed(port, 'POST', '/v1/configs', configsBody)).toEqual({
      status: 500,
      body: { error: 'internal_error' },
    });
    expect(await signed(port, 'POST', '/v1/launch-coin/prepare', configsBody)).toEqual({
      status: 500,
      body: { error: 'internal_error' },
    });
  });

  it('refuses requests when the replay cache is full of live entries', async () => {
    const { port, clock } = await start({ maxReplayEntries: 2 });
    expect((await signed(port, 'GET', '/v1/health', '', NOW)).status).toBe(200);
    expect((await signed(port, 'GET', '/v1/health', '', NOW - 1000)).status).toBe(200);
    expect((await signed(port, 'GET', '/v1/health', '', NOW - 2000)).status).toBe(503);
    clock.now = NOW + 62_000;
    expect((await signed(port, 'GET', '/v1/health', '', clock.now)).status).toBe(200);
  });

  it('never logs the secret, the signature or the body', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const { port } = await start({ logger });
    const headers = signRequest(SECRET, configsReq, NOW);
    await send(port, 'POST', '/v1/configs', headers, configsBody);
    await send(port, 'POST', '/v1/configs', headers, configsBody);
    const tampered = JSON.stringify({ jobId: JOB_ID, marker: 'BODY-MARKER' });
    await send(port, 'POST', '/v1/configs', headers, tampered);
    const output = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(headers[SIGNER_SIGNATURE_HEADER]);
    expect(output).not.toContain('BODY-MARKER');
    expect(output).not.toContain(JOB_ID);
  });
});

describe('ReplayCache', () => {
  it('forgets entries once their window has passed', () => {
    const cache = new ReplayCache(60, 10);
    expect(cache.checkAndRemember('a', 100, 100)).toBe('fresh');
    expect(cache.checkAndRemember('a', 100, 160)).toBe('replay');
    expect(cache.checkAndRemember('a', 100, 161)).toBe('fresh');
    cache.sweep(1000);
    expect(cache.size).toBe(0);
  });
});

describe('IP helpers', () => {
  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('parses SIGNER_ALLOWED_IPS and refuses invalid entries', () => {
    expect(parseAllowedIps(undefined)).toEqual([]);
    expect(parseAllowedIps(' 10.0.0.1, ::ffff:10.0.0.2 ,,')).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(() => parseAllowedIps('10.0.0.0/24')).toThrow();
    expect(() => parseAllowedIps('localhost')).toThrow();
  });
});

describe('loadSignerServerEnv', () => {
  it('requires a long enough secret and validates the port', () => {
    expect(() => loadSignerServerEnv({})).toThrow();
    expect(() => loadSignerServerEnv({ SIGNER_HMAC_SECRET: 'short' })).toThrow();
    expect(() =>
      loadSignerServerEnv({ SIGNER_HMAC_SECRET: SECRET, SIGNER_PORT: '70000' }),
    ).toThrow();
    expect(
      loadSignerServerEnv({
        SIGNER_HMAC_SECRET: SECRET,
        SIGNER_ALLOWED_IPS: '10.0.0.1',
        SIGNER_PORT: '9000',
        NODE_ENV: 'production',
      }),
    ).toEqual({ hmacSecret: SECRET, allowedIps: ['10.0.0.1'], port: 9000, production: true });
    expect(loadSignerServerEnv({ SIGNER_HMAC_SECRET: SECRET }).production).toBe(true);
  });
});
