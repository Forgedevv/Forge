// @vitest-environment node
import { FlagsResponse } from '@forge/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_CONTROL,
  CACHE_TTL_MS,
  createFlagsHandler,
  createSupabaseFlagsSource,
  FlagsConfigError,
  MAX_STALE_MS,
  readFlagsEnv,
  toFlagsResponse,
  type FlagsSource,
} from './flags';

function source(values: Record<string, boolean>): FlagsSource & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => new Map(Object.entries(values))) };
}

describe('GET /api/flags handler', () => {
  it('answers the FlagsResponse shape with short public caching', async () => {
    const handler = createFlagsHandler({ source: () => source({ signups_paused: true }) });
    const res = await handler();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROL);
    const body = (await res.json()) as unknown;
    expect(FlagsResponse.parse(body)).toEqual({ signupsPaused: true });
    // Only the public flag is exposed.
    expect(Object.keys(body as object)).toEqual(['signupsPaused']);
  });

  it('exposes only signups_paused, missing means not paused', () => {
    expect(toFlagsResponse(new Map([['deploys_paused', true]]))).toEqual({ signupsPaused: false });
    expect(toFlagsResponse(new Map([['signups_paused', false]]))).toEqual({ signupsPaused: false });
  });

  it('caches in memory for the TTL, with a single read under concurrency', async () => {
    let t = 0;
    const s = source({ signups_paused: false });
    const handler = createFlagsHandler({ source: () => s, now: () => t });
    await Promise.all([handler(), handler(), handler()]);
    expect(s.read).toHaveBeenCalledTimes(1);
    t = CACHE_TTL_MS - 1;
    await handler();
    expect(s.read).toHaveBeenCalledTimes(1);
    t = CACHE_TTL_MS;
    await handler();
    expect(s.read).toHaveBeenCalledTimes(2);
  });

  it('serves a recent value on a read failure, then answers 503', async () => {
    let t = 0;
    let fail = false;
    const onError = vi.fn();
    const s: FlagsSource = {
      read: async () => {
        if (fail) throw new Error('db down');
        return new Map([['signups_paused', true]]);
      },
    };
    const handler = createFlagsHandler({ source: () => s, now: () => t, onError });
    await handler();
    fail = true;
    t = CACHE_TTL_MS + 1;
    const stale = await handler();
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ signupsPaused: true });
    t = MAX_STALE_MS + 1;
    const down = await handler();
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect(await down.json()).toEqual({
      code: 'NETWORK',
      message: 'Service status is temporarily unavailable.',
    });
    expect(onError).toHaveBeenCalledWith('read_failed', expect.any(Error));
  });

  it('answers 503 on a configuration error', async () => {
    const onError = vi.fn();
    const handler = createFlagsHandler({
      source: () => {
        throw new FlagsConfigError('SUPABASE_URL is not set');
      },
      onError,
    });
    expect((await handler()).status).toBe(503);
    expect(onError).toHaveBeenCalledWith('config_error', expect.any(FlagsConfigError));
  });
});

describe('flags source', () => {
  it('reads the flags table and fails without the Supabase error text', async () => {
    const ok = {
      from: (table: string) => ({
        select: async () => {
          expect(table).toBe('flags');
          return {
            data: [
              { key: 'signups_paused', value: true },
              { key: 'deploys_paused', value: 'yes' },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseClient;
    const values = await createSupabaseFlagsSource(ok).read();
    expect(values.get('signups_paused')).toBe(true);
    expect(values.get('deploys_paused')).toBe(false);

    const broken = {
      from: () => ({ select: async () => ({ data: null, error: { message: 'secret detail' } }) }),
    } as unknown as SupabaseClient;
    await expect(createSupabaseFlagsSource(broken).read()).rejects.toThrow('flags read failed');
  });

  it('uses the anon key, falling back to the public variables', () => {
    expect(readFlagsEnv({ SUPABASE_URL: 'https://a', SUPABASE_ANON_KEY: 'anon' })).toEqual({
      url: 'https://a',
      anonKey: 'anon',
    });
    expect(
      readFlagsEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://b', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'pub' }),
    ).toEqual({ url: 'https://b', anonKey: 'pub' });
    expect(() => readFlagsEnv({ SUPABASE_URL: 'https://a' })).toThrow(
      'SUPABASE_ANON_KEY is not set',
    );
    expect(() => readFlagsEnv({})).toThrow('SUPABASE_URL is not set');
  });
});
