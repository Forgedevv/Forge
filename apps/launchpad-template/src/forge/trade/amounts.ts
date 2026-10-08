import { PLATFORM_FEE_BPS, SLIPPAGE_BPS } from './constants';

export type AmountParse =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'empty' | 'invalid' | 'too_many_decimals' | 'zero' | 'too_large' };

/** Largest u64: on-chain amounts never exceed it. */
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/**
 * Parses a user-typed decimal string into raw units (bigint). No floating point is involved.
 * Accepts "1", "1.", ".5", "0.25". Rejects signs, exponents, separators and thousands marks.
 */
export function parseAmount(input: string, decimals: number): AmountParse {
  const text = input.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return { ok: false, reason: 'invalid' };
  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    // Trailing zeros beyond the precision are harmless ("1.500000000" for 6 decimals is not).
    if (/[1-9]/.test(fraction.slice(decimals))) return { ok: false, reason: 'too_many_decimals' };
  }
  const raw = BigInt((whole || '0') + fraction.slice(0, decimals).padEnd(decimals, '0'));
  if (raw === BigInt(0)) return { ok: false, reason: 'zero' };
  if (raw > U64_MAX) return { ok: false, reason: 'too_large' };
  return { ok: true, value: raw };
}

/** Formats raw units as a decimal string, trimming trailing zeros and capping the fraction digits. */
export function formatUnits(raw: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0');
  if (maxFractionDigits < decimals) fraction = fraction.slice(0, maxFractionDigits);
  fraction = fraction.replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Formats basis points as a percentage string ("30" -> "0.3%"). */
export function formatBps(bps: number): string {
  const text = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}

export type SlippageParse =
  { ok: true; bps: number } | { ok: false; reason: 'invalid' | 'too_low' | 'too_high' };

/** Parses a percentage typed by the user ("1", "0.5") into bounded basis points. */
export function parseSlippagePercent(input: string): SlippageParse {
  const text = input.trim().replace(/%$/, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return { ok: false, reason: 'invalid' };
  const parsed = parseAmount(text, 2);
  // "0" parses to a zero error: treat as too low.
  if (!parsed.ok) {
    if (parsed.reason === 'zero') return { ok: false, reason: 'too_low' };
    return { ok: false, reason: 'invalid' };
  }
  const bps = Number(parsed.value);
  if (bps < SLIPPAGE_BPS.min) return { ok: false, reason: 'too_low' };
  if (bps > SLIPPAGE_BPS.max) return { ok: false, reason: 'too_high' };
  return { ok: true, bps };
}

/** floor(amount * bps / 10_000), exact. */
export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BigInt(10_000);
}

/** Minimum output for a given expected output and slippage tolerance. */
export function minAfterSlippage(expectedOut: bigint, slippageBps: number): bigint {
  return expectedOut - applyBps(expectedOut, slippageBps);
}

/**
 * Sanity check on the platform fee announced by the quote. The UI refuses to let the user sign a
 * quote whose fee does not match the documented 0.3% (docs/METEORA.md, "The platform fee").
 *
 * - Buy: 0.3% of the SOL spent (rounding tolerance of 1 lamport).
 * - Sell: 0.3% of the expected SOL output, computed with the same tolerance as the slippage,
 *   so it may lie between 0.3% of the minimum and 0.3% of the expected output.
 */
export function isPlatformFeeConsistent(args: {
  side: 'buy' | 'sell';
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  platformFee: bigint;
  platformFeeBps: number;
}): boolean {
  const { side, amountIn, amountOut, minAmountOut, platformFee, platformFeeBps } = args;
  if (platformFeeBps !== PLATFORM_FEE_BPS) return false;
  if (platformFee < BigInt(0)) return false;
  if (side === 'buy') {
    const expected = applyBps(amountIn, PLATFORM_FEE_BPS);
    return platformFee >= expected - BigInt(1) && platformFee <= expected + BigInt(1);
  }
  const low = applyBps(minAmountOut, PLATFORM_FEE_BPS);
  const high = applyBps(amountOut, PLATFORM_FEE_BPS);
  return platformFee >= low - BigInt(1) && platformFee <= high + BigInt(1);
}
