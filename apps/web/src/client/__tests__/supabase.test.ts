import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('../http', () => ({ request: (...a: unknown[]) => requestMock(...a) }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    realtime: { setAuth: vi.fn() },
    removeAllChannels: vi.fn(async () => []),
  })),
}));

import { getSupabase, startSupabaseAuth, stopSupabaseAuth } from '../supabase';

const tokenRes = (t: string) => ({
  accessToken: t,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('supabase auth lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    requestMock.mockReset();
  });
  afterEach(() => {
    stopSupabaseAuth();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('does not rebuild the client when a token fetch resolves after stopSupabaseAuth', async () => {
    let resolve!: (v: unknown) => void;
    requestMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const started = startSupabaseAuth();
    stopSupabaseAuth();
    resolve(tokenRes('late'));
    await started;
    expect(getSupabase()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the response of a superseded start and keeps a single refresh timer', async () => {
    let resolveA!: (v: unknown) => void;
    requestMock.mockReturnValueOnce(new Promise((r) => (resolveA = r)));
    requestMock.mockResolvedValueOnce(tokenRes('b'));
    const a = startSupabaseAuth();
    const b = startSupabaseAuth();
    await b;
    resolveA(tokenRes('a'));
    await a;
    expect(getSupabase()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });
});
