// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PriceUnavailableError } from './errors';
import {
  FixedPriceSource,
  GuardedPriceSource,
  JUPITER_LITE_PRICE_URL,
  JUPITER_PRICE_URL,
  JupiterPriceSource,
  PRICE_REFERENCE_MAX_AGE_MS,
  PRICE_REFERENCE_SAVE_INTERVAL_MS,
  WSOL_MINT,
  type PriceReference,
  type PriceReferenceStore,
  type SolUsdPriceSource,
} from './price-source';
import { DEFAULT_SOL_USD_PRICE_GUARD } from './pricing';

/** A source whose next answers are set by the test. */
function scripted(prices: number[]): SolUsdPriceSource {
  return {
    getSolUsdPrice: async () => {
      const next = prices.shift();
      if (next === undefined) throw new Error('no price scripted');
      return next;
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const OK = { [WSOL_MINT]: { usdPrice: 152.25, blockId: 1, decimals: 9 } };
const noSleep = async () => {};

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
}

describe('JupiterPriceSource', () => {
  it('reads the SOL price from the keyed endpoint with the API key header', async () => {
    const fetchImpl = vi.fn(async () => response(OK));
    const source = new JupiterPriceSource({ apiKey: 'k', fetchImpl, sleep: noSleep });
    await expect(source.getSolUsdPrice()).resolves.toBe(152.25);
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`${JUPITER_PRICE_URL}?ids=${WSOL_MINT}`);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('uses the free endpoint without a key', async () => {
    const fetchImpl = vi.fn(async () => response(OK));
    await new JupiterPriceSource({ fetchImpl, sleep: noSleep }).getSolUsdPrice();
    const [url, init] = call(fetchImpl);
    expect(url.startsWith(JUPITER_LITE_PRICE_URL)).toBe(true);
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('caches the price for a short time', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => response(OK));
    const source = new JupiterPriceSource({ fetchImpl, cacheMs: 1000, now: () => now });
    await source.getSolUsdPrice();
    now = 999;
    await source.getSolUsdPrice();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 1000;
    await source.getSolUsdPrice();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors and bad statuses, then fails closed', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response(OK));
    const source = new JupiterPriceSource({ fetchImpl, sleep: noSleep });
    await expect(source.getSolUsdPrice()).resolves.toBe(152.25);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const down = new JupiterPriceSource({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      sleep: noSleep,
    });
    await expect(down.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it.each([
    ['a missing SOL entry', {}],
    ['a null SOL entry', { [WSOL_MINT]: null }],
    ['an insane price', { [WSOL_MINT]: { usdPrice: 0 } }],
    ['a malformed price', { [WSOL_MINT]: { usdPrice: '152' } }],
  ])('rejects %s', async (_label, body) => {
    const source = new JupiterPriceSource({
      fetchImpl: async () => response(body),
      sleep: noSleep,
    });
    await expect(source.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it('accepts a rate above the guard defaults when it is within the hard limits', async () => {
    // The guard (GuardedPriceSource) applies the configured bounds, not the price source.
    const source = new JupiterPriceSource({
      fetchImpl: async () => response({ [WSOL_MINT]: { usdPrice: 2_500 } }),
      sleep: noSleep,
    });
    await expect(source.getSolUsdPrice()).resolves.toBe(2_500);
  });
});

describe('GuardedPriceSource', () => {
  it('has defaults of 10 to 2000 $/SOL and a 25% move', () => {
    expect(DEFAULT_SOL_USD_PRICE_GUARD).toEqual({ min: 10, max: 2_000, maxDeviationPct: 25 });
  });

  it('refuses a rate outside the configured bounds (fail closed, retryable)', async () => {
    const refused: { reason: string; price: number; reference: number | null }[] = [];
    for (const price of [5, 9.99, 2_000.01, 50_000, Number.NaN]) {
      const guarded = new GuardedPriceSource(scripted([price]), DEFAULT_SOL_USD_PRICE_GUARD, {
        onRefused: (event) => refused.push(event),
      });
      await expect(guarded.getSolUsdPrice(), String(price)).rejects.toBeInstanceOf(
        PriceUnavailableError,
      );
    }
    expect(refused.map((r) => r.reason)).toEqual(Array(5).fill('out_of_bounds'));
    expect(refused[0]).toEqual({ reason: 'out_of_bounds', price: 5, reference: null });
    // The bounds come from the configuration.
    const custom = new GuardedPriceSource(scripted([2_500]), {
      min: 100,
      max: 3_000,
      maxDeviationPct: 25,
    });
    await expect(custom.getSolUsdPrice()).resolves.toBe(2_500);
    const fixed = new GuardedPriceSource(new FixedPriceSource(150), DEFAULT_SOL_USD_PRICE_GUARD);
    await expect(fixed.getSolUsdPrice()).resolves.toBe(150);
  });

  it('refuses a rate that moved more than the allowed deviation from the last accepted one', async () => {
    let now = 0;
    const refused: { reason: string; price: number; reference: number | null }[] = [];
    const source = new GuardedPriceSource(
      scripted([150, 180, 240, 230, 200, 140, 260]),
      DEFAULT_SOL_USD_PRICE_GUARD,
      { now: () => now, onRefused: (event) => refused.push(event) },
    );
    await expect(source.getSolUsdPrice()).resolves.toBe(150);
    // +20% from 150: accepted, and the new reference.
    await expect(source.getSolUsdPrice()).resolves.toBe(180);
    // +33% from 180: refused, retryable.
    await expect(source.getSolUsdPrice()).rejects.toThrow(
      'SOL/USD price moved more than the allowed deviation from the last accepted price',
    );
    // A refused rate never becomes the reference: +27.8% from 180 is refused too.
    await expect(source.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
    await expect(source.getSolUsdPrice()).resolves.toBe(200);
    // -30% from 200: refused.
    await expect(source.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(refused.map((r) => [r.reason, r.price, r.reference])).toEqual([
      ['deviation', 240, 180],
      ['deviation', 230, 180],
      ['deviation', 140, 200],
    ]);

    // Without a quote for longer than the reference lifetime, the bounds alone apply again.
    now += PRICE_REFERENCE_MAX_AGE_MS + 1;
    await expect(source.getSolUsdPrice()).resolves.toBe(260);
  });

  /** In-memory reference store; `failing` makes both operations throw. */
  function memoryReferences(initial: PriceReference | null = null) {
    const state = {
      stored: initial,
      failing: false,
      loads: 0,
      saves: [] as PriceReference[],
    };
    const store: PriceReferenceStore = {
      load: async () => {
        state.loads += 1;
        if (state.failing) throw new Error('database down');
        return state.stored;
      },
      save: async (reference) => {
        if (state.failing) throw new Error('database down');
        state.saves.push({ ...reference });
        state.stored = { ...reference };
      },
    };
    return { state, store };
  }

  it('starts a fresh instance from the stored reference (cold start)', async () => {
    const now = 10 * PRICE_REFERENCE_MAX_AGE_MS;
    const refs = memoryReferences({ price: 150, at: now - 30 * 60_000 });
    const refused: [string, number, number | null][] = [];
    const fresh = new GuardedPriceSource(scripted([240, 160]), DEFAULT_SOL_USD_PRICE_GUARD, {
      now: () => now,
      referenceStore: refs.store,
      onRefused: (e) => refused.push([e.reason, e.price, e.reference]),
    });
    // +60% from the stored 150: refused even though this instance accepted nothing yet.
    await expect(fresh.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(refused).toEqual([['deviation', 240, 150]]);
    await expect(fresh.getSolUsdPrice()).resolves.toBe(160);
    // Read once; the accepted rate is kept for the next instances.
    expect(refs.state.loads).toBe(1);
    expect(refs.state.saves).toEqual([{ price: 160, at: now }]);
  });

  it('ignores a stored reference older than the expiry, from the future or out of bounds', async () => {
    const now = 10 * PRICE_REFERENCE_MAX_AGE_MS;
    for (const stored of [
      { price: 150, at: now - PRICE_REFERENCE_MAX_AGE_MS - 1 },
      { price: 150, at: now + 60_000 },
      { price: 5, at: now - 60_000 },
      { price: Number.NaN, at: now - 60_000 },
    ]) {
      const refs = memoryReferences(stored);
      const fresh = new GuardedPriceSource(scripted([240]), DEFAULT_SOL_USD_PRICE_GUARD, {
        now: () => now,
        referenceStore: refs.store,
      });
      await expect(fresh.getSolUsdPrice(), JSON.stringify(stored)).resolves.toBe(240);
    }
  });

  it('works from memory when the store is unavailable, with a warning', async () => {
    let now = 0;
    const refs = memoryReferences({ price: 150, at: 0 });
    refs.state.failing = true;
    const errors: string[] = [];
    const source = new GuardedPriceSource(scripted([240, 400, 250]), DEFAULT_SOL_USD_PRICE_GUARD, {
      now: () => now,
      referenceStore: refs.store,
      onStoreError: (operation) => errors.push(operation),
    });
    // Current behaviour: the first rate of the instance is accepted and becomes its reference.
    await expect(source.getSolUsdPrice()).resolves.toBe(240);
    expect(errors).toEqual(['load', 'save']);
    // The move limit then applies from memory, and the store is not read again.
    await expect(source.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
    now += PRICE_REFERENCE_SAVE_INTERVAL_MS;
    await expect(source.getSolUsdPrice()).resolves.toBe(250);
    expect(refs.state.loads).toBe(1);
    expect(errors).toEqual(['load', 'save', 'save']);
  });

  it('writes the accepted rate at most once per interval', async () => {
    let now = 0;
    const refs = memoryReferences();
    const source = new GuardedPriceSource(scripted([150, 151, 152]), DEFAULT_SOL_USD_PRICE_GUARD, {
      now: () => now,
      referenceStore: refs.store,
    });
    await source.getSolUsdPrice();
    now += PRICE_REFERENCE_SAVE_INTERVAL_MS - 1;
    await source.getSolUsdPrice();
    now += 1;
    await source.getSolUsdPrice();
    expect(refs.state.saves).toEqual([
      { price: 150, at: 0 },
      { price: 152, at: PRICE_REFERENCE_SAVE_INTERVAL_MS },
    ]);
  });

  it('passes the errors of its source through', async () => {
    const source = new GuardedPriceSource(
      { getSolUsdPrice: () => Promise.reject(new PriceUnavailableError('down')) },
      DEFAULT_SOL_USD_PRICE_GUARD,
    );
    await expect(source.getSolUsdPrice()).rejects.toThrow('down');
  });
});
