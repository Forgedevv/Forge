import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COIN_CACHE_CONTROL,
  LIST_CACHE_CONTROL,
  createCoinsHandler,
} from '../../src/forge/data/onchain/handler';
import type { OnchainCoinService } from '../../src/forge/data/onchain/service';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

const request = (query: Record<string, string | string[]> = {}, method = 'GET') =>
  ({ method, query, headers: {} }) as never;

const EMPTY = { recent: { pools: [] }, aboutToGraduate: { pools: [] }, graduated: { pools: [] } };

function service(overrides: Partial<OnchainCoinService> = {}): OnchainCoinService {
  return {
    lists: vi.fn(async () => EMPTY),
    coin: vi.fn(async (mint: string) =>
      mint === 'bad' ? null : { pool: null, description: null },
    ),
    ...overrides,
  };
}

describe('GET /api/coins (handler)', () => {
  it('serves the lists with a CDN cache header', async () => {
    const res = fakeResponse();
    await createCoinsHandler({ service: () => service(), mode: 'live' })(request(), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ source: 'chain', ...EMPTY });
    expect(res.headers['cache-control']).toBe(LIST_CACHE_CONTROL);
  });

  it('serves one coin, refuses an invalid or repeated mint parameter', async () => {
    const s = service();
    const handler = createCoinsHandler({ service: () => s, mode: 'live' });
    const ok = fakeResponse();
    await handler(request({ mint: 'So11111111111111111111111111111111111111112' }), ok as never);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toEqual({ source: 'chain', pool: null, description: null });
    expect(ok.headers['cache-control']).toBe(COIN_CACHE_CONTROL);
    for (const mint of ['bad', ['a', 'b']]) {
      const res = fakeResponse();
      await handler(request({ mint }), res as never);
      expect(res.statusCode).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('answers 503 (never cached) when the chain cannot be read or nothing is configured', async () => {
    const failing = service({
      lists: vi.fn(async () => {
        throw new Error('relay down');
      }),
    });
    const res = fakeResponse();
    await createCoinsHandler({ service: () => failing, mode: 'live' })(request(), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('relay down');

    const none = fakeResponse();
    await createCoinsHandler({ service: () => null, mode: 'live' })(request(), none as never);
    expect(none.statusCode).toBe(503);
  });

  it('refuses other methods and serves nothing when the site is not live', async () => {
    const s = service();
    const post = fakeResponse();
    await createCoinsHandler({ service: () => s, mode: 'live' })(
      request({}, 'POST'),
      post as never,
    );
    expect(post.statusCode).toBe(405);
    for (const mode of ['sleeping', 'disabled'] as const) {
      const res = fakeResponse();
      await createCoinsHandler({ service: () => s, mode })(request(), res as never);
      expect(res.statusCode).toBe(503);
    }
    expect(s.lists).not.toHaveBeenCalled();
  });
});

describe('/api/coins route', () => {
  it('answers 503 without any network call when the relay is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', '');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { default: coins } = await import('../../src/pages/api/coins');
    const res = fakeResponse();
    await coins(request() as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
