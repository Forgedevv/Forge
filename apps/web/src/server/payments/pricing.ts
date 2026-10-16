import { LAMPORTS_PER_SOL, PRICING, type JobType, type PaymentKind } from '@forge/shared';
import { PriceUnavailableError } from './errors';

/*
 * Server-side pricing. Prices are fixed in dollars (PRICING, docs/PRODUCT.md) and converted to
 * lamports at quote time. The client never sends an amount.
 */

/**
 * Absolute limits on the SOL/USD rate, checked on every conversion: no configuration can accept a
 * rate outside them. The narrower, configurable guard below is what quotes actually go through.
 */
export const SOL_USD_PRICE_HARD_LIMITS = { min: 1, max: 100_000 } as const;

/**
 * The guard of the quote price (GuardedPriceSource, price-source.ts). A rate outside [min, max],
 * or more than `maxDeviationPct` percent away from the last accepted rate, is treated as a broken
 * or manipulated oracle and the quote is refused (fail closed, retryable), so that a bad price can
 * never make a launchpad (almost) free.
 */
export interface SolUsdPriceGuard {
  /** Dollars per SOL. */
  min: number;
  max: number;
  /** Largest move from the last accepted price, in percent. */
  maxDeviationPct: number;
}

/** Defaults of SOL_USD_PRICE_MIN, SOL_USD_PRICE_MAX and SOL_USD_PRICE_MAX_DEVIATION_PCT. */
export const DEFAULT_SOL_USD_PRICE_GUARD: Readonly<SolUsdPriceGuard> = {
  min: 10,
  max: 2_000,
  maxDeviationPct: 25,
};

/** The payment kind each job type is paid with. */
export function kindForJobType(type: JobType): PaymentKind {
  return type === 'create_launchpad' ? 'creation' : 'modification';
}

/** Dollar price of a paid quote of this kind. */
export function usdPriceForKind(kind: PaymentKind): number {
  return kind === 'creation' ? PRICING.creationUsd : PRICING.modificationUsd;
}

/** Throws PriceUnavailableError unless `price` is a finite rate within `bounds` (inclusive). */
export function assertSaneSolUsdPrice(
  price: number,
  bounds: { min: number; max: number } = SOL_USD_PRICE_HARD_LIMITS,
): void {
  if (!Number.isFinite(price) || price < bounds.min || price > bounds.max) {
    throw new PriceUnavailableError('SOL/USD price outside the sanity bounds');
  }
}

/**
 * Converts a dollar amount to lamports at `solUsdPrice` dollars per SOL, rounding UP so that the
 * quote never undercharges. Integer math: dollars and the price are scaled to micro-dollars.
 */
export function usdToLamports(usd: number, solUsdPrice: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError('usd must be a positive number');
  assertSaneSolUsdPrice(solUsdPrice);
  const usdMicros = BigInt(Math.round(usd * 1_000_000));
  const priceMicros = BigInt(Math.round(solUsdPrice * 1_000_000));
  const numerator = usdMicros * BigInt(LAMPORTS_PER_SOL);
  const lamports = (numerator + priceMicros - 1n) / priceMicros;
  if (lamports <= 0n) throw new RangeError('quote rounds to zero lamports');
  return lamports;
}
