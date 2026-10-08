import { describe, expect, it } from 'vitest';
import {
  applyBps,
  formatBps,
  formatUnits,
  isPlatformFeeConsistent,
  minAfterSlippage,
  parseAmount,
  parseSlippagePercent,
} from '../../src/forge/trade/amounts';

describe('parseAmount', () => {
  it('parses decimals exactly, without floating point', () => {
    expect(parseAmount('1', 9)).toEqual({ ok: true, value: BigInt(1_000_000_000) });
    expect(parseAmount('0.1', 9)).toEqual({ ok: true, value: BigInt(100_000_000) });
    expect(parseAmount('.5', 6)).toEqual({ ok: true, value: BigInt(500_000) });
    expect(parseAmount('12.', 6)).toEqual({ ok: true, value: BigInt(12_000_000) });
    expect(parseAmount('0.000000001', 9)).toEqual({ ok: true, value: BigInt(1) });
  });

  it('rejects empty, malformed, zero and over-precise input', () => {
    expect(parseAmount('', 9)).toEqual({ ok: false, reason: 'empty' });
    expect(parseAmount('  ', 9)).toEqual({ ok: false, reason: 'empty' });
    for (const bad of ['abc', '-1', '+1', '1e3', '1,5', '1.2.3', '0x10', 'NaN', '.']) {
      expect(parseAmount(bad, 9)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseAmount('0', 9)).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmount('0.0000', 6)).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmount('0.0000001', 6)).toEqual({ ok: false, reason: 'too_many_decimals' });
    expect(parseAmount('99999999999999999999999', 9)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('tolerates trailing zeros beyond the precision', () => {
    expect(parseAmount('1.5000000', 6)).toEqual({ ok: true, value: BigInt(1_500_000) });
  });
});

describe('formatUnits and formatBps', () => {
  it('formats with trimmed zeros and grouping', () => {
    expect(formatUnits(BigInt(1_500_000_000), 9)).toBe('1.5');
    expect(formatUnits(BigInt(1_234_567_000_000), 6)).toBe('1,234,567');
    expect(formatUnits(BigInt(123_456_789), 9, 4)).toBe('0.1234');
    expect(formatUnits(BigInt(0), 9)).toBe('0');
  });
  it('formats basis points as percentages', () => {
    expect(formatBps(30)).toBe('0.3%');
    expect(formatBps(100)).toBe('1%');
    expect(formatBps(2500)).toBe('25%');
  });
});

describe('slippage', () => {
  it('converts a percentage to bounded basis points', () => {
    expect(parseSlippagePercent('1')).toEqual({ ok: true, bps: 100 });
    expect(parseSlippagePercent('0.5%')).toEqual({ ok: true, bps: 50 });
    expect(parseSlippagePercent('0.1')).toEqual({ ok: true, bps: 10 });
    expect(parseSlippagePercent('25')).toEqual({ ok: true, bps: 2500 });
  });
  it('enforces the bounds', () => {
    expect(parseSlippagePercent('0')).toEqual({ ok: false, reason: 'too_low' });
    expect(parseSlippagePercent('0.05')).toEqual({ ok: false, reason: 'too_low' });
    expect(parseSlippagePercent('0.09')).toEqual({ ok: false, reason: 'too_low' });
    expect(parseSlippagePercent('25.01')).toEqual({ ok: false, reason: 'too_high' });
    expect(parseSlippagePercent('100')).toEqual({ ok: false, reason: 'too_high' });
    expect(parseSlippagePercent('abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSlippagePercent('-1')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSlippagePercent('')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('computes the minimum output', () => {
    expect(applyBps(BigInt(1_000_000), 30)).toBe(BigInt(3_000));
    expect(minAfterSlippage(BigInt(1_000_000), 100)).toBe(BigInt(990_000));
  });
});

describe('isPlatformFeeConsistent', () => {
  const buy = {
    side: 'buy' as const,
    amountIn: BigInt(1_000_000_000),
    amountOut: BigInt(5_000_000),
    minAmountOut: BigInt(4_950_000),
    platformFeeBps: 30,
  };
  it('accepts 0.3% of the SOL spent on a buy', () => {
    expect(isPlatformFeeConsistent({ ...buy, platformFee: BigInt(3_000_000) })).toBe(true);
  });
  it('rejects a wrong amount or a wrong rate on a buy', () => {
    expect(isPlatformFeeConsistent({ ...buy, platformFee: BigInt(2_000_000) })).toBe(false);
    expect(isPlatformFeeConsistent({ ...buy, platformFee: BigInt(0) })).toBe(false);
    expect(
      isPlatformFeeConsistent({ ...buy, platformFee: BigInt(3_000_000), platformFeeBps: 50 }),
    ).toBe(false);
  });
  it('allows the slippage tolerance on a sell', () => {
    const sell = {
      ...buy,
      side: 'sell' as const,
      amountIn: BigInt(1),
      amountOut: BigInt(1_000_000_000),
      minAmountOut: BigInt(990_000_000),
    };
    expect(isPlatformFeeConsistent({ ...sell, platformFee: BigInt(3_000_000) })).toBe(true);
    expect(isPlatformFeeConsistent({ ...sell, platformFee: BigInt(2_970_000) })).toBe(true);
    expect(isPlatformFeeConsistent({ ...sell, platformFee: BigInt(4_000_000) })).toBe(false);
    expect(isPlatformFeeConsistent({ ...sell, platformFee: BigInt(1_000_000) })).toBe(false);
  });
});
