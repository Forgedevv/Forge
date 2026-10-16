// @vitest-environment node
import { PRICING } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import { PriceUnavailableError } from './errors';
import {
  assertSaneSolUsdPrice,
  DEFAULT_SOL_USD_PRICE_GUARD,
  kindForJobType,
  SOL_USD_PRICE_HARD_LIMITS,
  usdPriceForKind,
  usdToLamports,
} from './pricing';

describe('pricing', () => {
  it('takes prices from the shared constants', () => {
    expect(usdPriceForKind('creation')).toBe(PRICING.creationUsd);
    expect(usdPriceForKind('modification')).toBe(PRICING.modificationUsd);
    expect(kindForJobType('create_launchpad')).toBe('creation');
    expect(kindForJobType('modify_launchpad')).toBe('modification');
  });

  it('converts exactly when the division is exact', () => {
    expect(usdToLamports(33, 150)).toBe(220_000_000n);
    expect(usdToLamports(5.5, 110)).toBe(50_000_000n);
  });

  it('rounds up so that a quote never undercharges', () => {
    for (const price of [151.37, 97.123456, 233.3333333, 1.000001]) {
      const lamports = usdToLamports(33, price);
      const priceMicros = BigInt(Math.round(price * 1e6));
      const usdNanoMicros = 33n * 1_000_000n * 1_000_000_000n;
      // lamports * price >= $33, and one lamport less would be below $33.
      expect(lamports * priceMicros >= usdNanoMicros).toBe(true);
      expect((lamports - 1n) * priceMicros < usdNanoMicros).toBe(true);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 100_001])(
    'refuses an insane SOL price (%s)',
    (price) => {
      expect(() => usdToLamports(33, price)).toThrow(PriceUnavailableError);
    },
  );

  it('checks a rate against the given bounds, the hard limits by default', () => {
    expect(SOL_USD_PRICE_HARD_LIMITS).toEqual({ min: 1, max: 100_000 });
    expect(() => assertSaneSolUsdPrice(5_000)).not.toThrow();
    expect(() => assertSaneSolUsdPrice(5_000, DEFAULT_SOL_USD_PRICE_GUARD)).toThrow(
      PriceUnavailableError,
    );
    expect(() => assertSaneSolUsdPrice(9, DEFAULT_SOL_USD_PRICE_GUARD)).toThrow(
      PriceUnavailableError,
    );
    expect(() => assertSaneSolUsdPrice(10, DEFAULT_SOL_USD_PRICE_GUARD)).not.toThrow();
    expect(() => assertSaneSolUsdPrice(2_000, DEFAULT_SOL_USD_PRICE_GUARD)).not.toThrow();
  });

  it('refuses a non-positive dollar amount', () => {
    expect(() => usdToLamports(0, 150)).toThrow(RangeError);
  });
});
