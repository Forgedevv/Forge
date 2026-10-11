import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function fakeRequest() {
  return Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: { host: 'moon.example', 'content-type': 'application/json' },
    socket: { remoteAddress: '10.0.0.1' },
  });
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader() {},
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

describe('/api/upload route', () => {
  it('reads its own body (bodyParser off, capped by the handler)', async () => {
    const route = await import('../../src/pages/api/upload');
    expect(route.config).toEqual({ api: { bodyParser: false } });
  });

  it('fails closed with 503 when the relay, the FORGE API and the on-chain config are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', '');
    vi.stubEnv('NEXT_PUBLIC_FORGE_API_URL', '');
    // Storage credentials, if a project still had them, are never used.
    vi.stubEnv('R2_ACCESS_KEY_ID', 'unused');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'unused');
    vi.stubEnv('RPC_URL', 'https://devnet.example/unused');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { default: upload } = await import('../../src/pages/api/upload');
    const res = fakeResponse();
    await upload(fakeRequest() as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Coin creation is not configured on this site yet.' });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
