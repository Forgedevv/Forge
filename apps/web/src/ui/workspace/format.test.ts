import { describe, expect, it } from 'vitest';
import { FORGE_TOKEN_DECIMALS, formatTokenAmount } from './format';

describe('formatTokenAmount', () => {
  it('shows $FORGE raw units in whole tokens (6 decimals)', () => {
    expect(FORGE_TOKEN_DECIMALS).toBe(6);
    expect(formatTokenAmount('1000000', 6)).toBe('1');
    expect(formatTokenAmount('2500000', 6)).toBe('2.5');
    expect(formatTokenAmount('250000', 6)).toBe('0.25');
    expect(formatTokenAmount('1', 6)).toBe('0.000001');
    expect(formatTokenAmount('0', 6)).toBe('0');
    expect(formatTokenAmount('1234500000', 6)).toBe('1,234.5');
    expect(formatTokenAmount('1000000000000000', 6)).toBe('1,000,000,000');
  });

  it('works for other mints (SOL has 9 decimals) and keeps every digit exact', () => {
    expect(formatTokenAmount('1500000000', 9)).toBe('1.5');
    expect(formatTokenAmount('123', 0)).toBe('123');
    // Beyond Number.MAX_SAFE_INTEGER: a float would round these digits.
    expect(formatTokenAmount('18446744073709551615', 6)).toBe('18,446,744,073,709.551615');
    expect(formatTokenAmount('9007199254740993', 6)).toBe('9,007,199,254.740993');
  });

  it('shows a dash for anything that is not a raw amount', () => {
    for (const raw of ['', '-1', '1.5', '1e6', ' 1', '0x10', 'abc']) {
      expect(formatTokenAmount(raw, 6)).toBe('—');
    }
    expect(formatTokenAmount('1', -1)).toBe('—');
    expect(formatTokenAmount('1', 1.5)).toBe('—');
    expect(formatTokenAmount('1', 19)).toBe('—');
  });
});
