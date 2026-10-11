// @vitest-environment node
import { GatingResponse } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatingError, type GatingStatus } from '../chat/gating';
import { MemoryRateLimiter } from '../chat/rate-limit';
import { APP, OTHER_WALLET, sessionCookie, setTestEnv, WALLET } from '../chat/__tests__/helpers';
import { GATING_ROUTE_LIMITS, handleGating, type GatingRouteDeps } from './handler';

function get(opts: { cookie?: string | null; ip?: string } = {}): Request {
  const cookie = opts.cookie === undefined ? sessionCookie() : opts.cookie;
  return new Request(`${APP}/api/gating`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      'x-real-ip': opts.ip ?? '203.0.113.7',
    },
  });
}

function deps(
  status: GatingStatus | Error,
  limiter = new MemoryRateLimiter(),
): GatingRouteDeps & { calls: string[]; logs: string[] } {
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    gating: () => async (wallet) => {
      calls.push(wallet);
      if (status instanceof Error) throw status;
      return status;
    },
    limiter: () => limiter,
    log: (message) => logs.push(message),
  };
}

const ENABLED: GatingStatus = { enabled: true, ok: false, required: 1_000n, balance: 999n };

beforeEach(() => setTestEnv());
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/gating', () => {
  it('answers the gate of the session wallet per the shared schema', async () => {
    const d = deps(ENABLED);
    const res = await handleGating(get(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as unknown;
    expect(GatingResponse.parse(body)).toEqual({
      ok: false,
      required: '1000',
      balance: '999',
      enabled: true,
    });
    expect(d.calls).toEqual([WALLET]);
  });

  it('answers enabled: false, ok: true when gating is disabled', async () => {
    const res = await handleGating(
      get(),
      deps({ enabled: false, ok: true, required: 0n, balance: 0n }),
    );
    expect(await res.json()).toEqual({ ok: true, required: '0', balance: '0', enabled: false });
  });

  it('keeps huge raw amounts exact', async () => {
    const big = 123_456_789_012_345_678_901_234n;
    const res = await handleGating(
      get(),
      deps({ enabled: true, ok: true, required: big, balance: big }),
    );
    const body = (await res.json()) as { required: string; balance: string };
    expect(body.required).toBe(big.toString());
    expect(body.balance).toBe(big.toString());
  });

  it('requires a session (401 UNAUTHORIZED, no balance read)', async () => {
    const d = deps(ENABLED);
    const res = await handleGating(get({ cookie: null }), d);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHORIZED');
    expect(d.calls).toEqual([]);
  });

  it('refuses a wallet the private beta does not let in', async () => {
    vi.stubEnv('FORGE_BETA_MODE', 'on');
    vi.stubEnv('FORGE_BETA_ALLOWLIST', OTHER_WALLET);
    const d = deps(ENABLED);
    const res = await handleGating(get(), d);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('BETA_NOT_INVITED');
    expect(d.calls).toEqual([]);
  });

  it('fails closed with a 503 when the balance cannot be read', async () => {
    const d = deps(new GatingError('RPC request failed'));
    const res = await handleGating(get(), d);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('SERVER_ERROR');
    expect(d.logs).toEqual(['[gating] GatingError: RPC request failed']);
  });

  it('does not log the message of an unexpected error', async () => {
    const d = deps(new Error('https://rpc.example/?api-key=SECRET'));
    const res = await handleGating(get(), d);
    expect(res.status).toBe(503);
    expect(d.logs.join(' ')).not.toContain('SECRET');
  });

  it('rate limits per IP before reading the session', async () => {
    const d = deps(ENABLED);
    for (let i = 0; i < GATING_ROUTE_LIMITS.ip.limit; i++) {
      expect((await handleGating(get({ cookie: null, ip: '198.51.100.1' }), d)).status).toBe(401);
    }
    const res = await handleGating(get({ ip: '198.51.100.1' }), d);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(d.calls).toEqual([]);
    expect((await handleGating(get({ ip: '198.51.100.2' }), d)).status).toBe(200);
  });

  it('rate limits per wallet across IPs', async () => {
    const d = deps(ENABLED);
    for (let i = 0; i < GATING_ROUTE_LIMITS.wallet.limit; i++) {
      expect((await handleGating(get({ ip: `198.51.100.${i + 1}` }), d)).status).toBe(200);
    }
    expect((await handleGating(get({ ip: '192.0.2.1' }), d)).status).toBe(429);
  });
});

describe('route file', () => {
  it('serves GET /api/gating with the default gate (disabled without FORGE_MINT)', async () => {
    vi.stubEnv('FORGE_MINT', '');
    const { GET } = await import('../../../app/api/gating/route');
    const res = await GET(get({ ip: '192.0.2.200' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, required: '0', balance: '0', enabled: false });
    expect((await GET(get({ cookie: null, ip: '192.0.2.201' }))).status).toBe(401);
  });
});
