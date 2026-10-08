import { LAMPORTS_PER_SOL, PRICING, type JobType, type PaymentKind } from '@forge/shared';
import { PriceUnavailableError } from './errors';

/*
 * Server-side pricing. Prices are fixed in dollars (PRICING, docs/PRODUCT.md) and converted to
 * lamports at quote time. The client never sends an amount.
 */

/**
 * Sanity bounds on the SOL/USD rate. A rate outside them is treated as a broken oracle and the
 * quote is refused (fail closed), so that a bad price can never make a launchpad (almost) free.
 */
export const SOL_USD_PRICE_BOUNDS = { min: 1, max: 100_000 } as const;

/** The payment kind each job type is paid with. */
export function kindForJobType(type: JobType): PaymentKind {
  return type === 'create_launchpad' ? 'creation' : 'modification';
}

/** Dollar price of a paid quote of this kind. */
export function usdPriceForKind(kind: PaymentKind): number {
  return kind === 'creation' ? PRICING.creationUsd : PRICING.modificationUsd;
}

export function assertSaneSolUsdPrice(price: number): void {
  if (
    !Number.isFinite(price) ||
    price < SOL_USD_PRICE_BOUNDS.min ||
    price > SOL_USD_PRICE_BOUNDS.max
  ) {
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
