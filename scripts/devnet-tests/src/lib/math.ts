/**
 * Pure helpers (no network) used by the tests and covered by vitest.
 *
 * Fee model of the Meteora DBC program (docs/METEORA.md):
 *   total trading fee     = amount * feeBps / 10_000
 *   protocol share        = 20 % of the fee (PROTOCOL_FEE_PERCENT)
 *   referral (host) share = 20 % of the protocol share (HOST_FEE_PERCENT), taken from Meteora
 *   remaining 80 %        = split between partner and creator by creatorTradingFeePercentage
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const PROTOCOL_FEE_PERCENT = 20n;
export const HOST_FEE_PERCENT = 20n;

export interface FeeSplit {
  totalFee: bigint;
  protocol: bigint;
  referral: bigint;
  partner: bigint;
  creator: bigint;
}

/** Expected split of the trading fee for a swap of `amountIn` (in quote lamports when fees are collected in quote). */
export function expectedFeeSplit(
  amountIn: bigint,
  feeBps: number,
  creatorTradingFeePercentage: number,
  withReferral: boolean,
): FeeSplit {
  if (!Number.isInteger(feeBps) || feeBps < 0) throw new Error('feeBps must be a non-negative integer');
  if (
    !Number.isInteger(creatorTradingFeePercentage) ||
    creatorTradingFeePercentage < 0 ||
    creatorTradingFeePercentage > 100
  ) {
    throw new Error('creatorTradingFeePercentage must be an integer between 0 and 100');
  }
  const totalFee = (amountIn * BigInt(feeBps)) / BPS_DENOMINATOR;
  const protocolTotal = (totalFee * PROTOCOL_FEE_PERCENT) / 100n;
  const referral = withReferral ? (protocolTotal * HOST_FEE_PERCENT) / 100n : 0n;
  const protocol = protocolTotal - referral;
  const nonProtocol = totalFee - protocolTotal;
  const creator = (nonProtocol * BigInt(creatorTradingFeePercentage)) / 100n;
  const partner = nonProtocol - creator;
  return { totalFee, protocol, referral, partner, creator };
}

/** Platform fee: `bps` of `amount`, rounded down. */
export function platformFeeLamports(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('bps out of range');
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new Error('sol must be a non-negative number');
  // Avoid floating point drift: go through a fixed 9-decimal string.
  const [whole = '0', frac = ''] = sol.toFixed(9).split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'));
}

export function lamportsToSol(lamports: bigint | number): string {
  const value = BigInt(lamports);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? '.' + frac : ''}`;
}

/** True when |actual - expected| <= tolerance. */
export function approxEqual(actual: bigint, expected: bigint, tolerance: bigint): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff <= tolerance;
}

/** Percentage (two decimals) of `part` over `whole`, as a string, "n/a" when whole is 0. */
export function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return 'n/a';
  const scaled = (part * 10_000n) / whole;
  return `${(Number(scaled) / 100).toFixed(2)}%`;
}

/**
 * Sum of lamports the funder must hold to cover `needs` (per wallet) plus a margin for fees.
 * Returns the missing amount (0n when nothing is missing).
 */
export function missingLamports(
  needs: ReadonlyArray<{ required: bigint; balance: bigint }>,
  funderBalance: bigint,
  marginLamports: bigint,
): bigint {
  let shortfall = 0n;
  for (const n of needs) if (n.balance < n.required) shortfall += n.required - n.balance;
  if (shortfall === 0n) return 0n;
  const total = shortfall + marginLamports;
  return funderBalance >= total ? 0n : total - funderBalance;
}
