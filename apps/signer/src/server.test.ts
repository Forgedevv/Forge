import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNER_SIGNATURE_HEADER, SIGNER_TIMESTAMP_HEADER } from '@forge/shared';
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

// Distinct timestamps (within the window) so that identical requests get distinct signatures.
let tick = 0;
function nextAt(): number {
  tick = (tick + 1) % 50;
  return NOW - tick * 1000;
}

function signed(port: number, method: string, path: string, body = '', at = nextAt()) {
  return send(port, method, path, signRequest(SECRET, body, at), body);
}

const configsBody = JSON.stringify({ jobId: JOB_ID });

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
    const headers = signRequest('another-secret-0123456789-abcdefghijk', configsBody, NOW);
    const res = await send(port, 'POST', '/v1/configs', headers, configsBody);
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('rejects malformed signatures (uppercase, short, non hex)', async () => {
    const { port } = await start();
    const good = signRequest(SECRET, configsBody, NOW);
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
    const headers = signRequest(SECRET, configsBody, NOW);
    const tampered = JSON.stringify({ jobId: '00000000-0000-4000-8000-000000000000' });
    const res = await send(port, 'POST', '/v1/configs', headers, tampered);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered timestamp', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, configsBody, NOW);
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
    for (const ts of [`${seconds}.0`, `+${seconds}`, `-${seconds}`, '1.8e9', '0x6b49d200', '']) {
      const res = await send(port, 'GET', '/v1/health', {
        [SIGNER_TIMESTAMP_HEADER]: ts,
        [SIGNER_SIGNATURE_HEADER]: signRequest(SECRET, '', NOW)[SIGNER_SIGNATURE_HEADER] as string,
      });
      expect(res.status).toBe(401);
    }
  });

  it('rejects a replayed request, on the same or another route', async () => {
    const configs = vi.fn(stubSignerRoutes.configs);
    const { port, clock } = await start({ routes: { ...stubSignerRoutes, configs } });
    const headers = signRequest(SECRET, configsBody, NOW);
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

  it('rejects concurrent identical requests except one', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, '', NOW);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(port, 'GET', '/v1/health', headers)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
  });

  it('rejects missing headers', async () => {
    const { port } = await start();
    const headers = signRequest(SECRET, configsBody, NOW);
    const noTs = { [SIGNER_SIGNATURE_HEADER]: headers[SIGNER_SIGNATURE_HEADER] as string };
    const noSig = { [SIGNER_TIMESTAMP_HEADER]: headers[SIGNER_TIMESTAMP_HEADER] as string };
    expect((await send(port, 'POST', '/v1/configs', {}, configsBody)).status).toBe(401);
    expect((await send(port, 'POST', '/v1/configs', noTs, configsBody)).status).toBe(401);
    expect((await send(port, 'POST', '/v1/configs', noSig, configsBody)).status).toBe(401);
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
    const ts = String(NOW / 1000);
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${ts}.`), invalidUtf8]))
      .digest('hex');
    const res = await send(
      port,
      'POST',
      '/v1/configs',
      { [SIGNER_TIMESTAMP_HEADER]: ts, [SIGNER_SIGNATURE_HEADER]: sig },
      invalidUtf8,
    );
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
    const headers = signRequest(SECRET, configsBody, NOW);
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
