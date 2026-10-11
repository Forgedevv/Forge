import { describe, expect, it } from 'vitest';
import { formatSol, parseSolToLamports, solNumberToLamports } from '@/forge/create/amounts';

describe('parseSolToLamports', () => {
  it('parses exact decimals', () => {
    expect(parseSolToLamports('1')).toBe(BigInt(1000000000));
    expect(parseSolToLamports('0.5')).toBe(BigInt(500000000));
    expect(parseSolToLamports('0.000000001')).toBe(BigInt(1));
    expect(parseSolToLamports(' 12.345 ')).toBe(BigInt(12345000000));
    expect(parseSolToLamports('0')).toBe(BigInt(0));
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1e3', '.5', '1.', '0.0000000001', 'abc', '1,5', '0x10']) {
      expect(parseSolToLamports(bad)).toBeNull();
    }
  });
});

describe('formatSol', () => {
  it('trims trailing zeros', () => {
    expect(formatSol(BigInt(1500000000))).toBe('1.5');
    expect(formatSol(BigInt(5000))).toBe('0.000005');
    expect(formatSol(BigInt(0))).toBe('0');
    expect(formatSol(BigInt(2000000000))).toBe('2');
  });

  it('round-trips', () => {
    for (const v of ['0.001', '12.000000001', '99.999999999']) {
      expect(formatSol(parseSolToLamports(v) as bigint)).toBe(v);
    }
  });
});

describe('solNumberToLamports', () => {
  it('converts config values exactly', () => {
    expect(solNumberToLamports(0.001)).toBe(BigInt(1000000));
    expect(solNumberToLamports(0)).toBe(BigInt(0));
    expect(solNumberToLamports(0.1)).toBe(BigInt(100000000));
  });

  it('rejects invalid values', () => {
    expect(() => solNumberToLamports(-1)).toThrow();
    expect(() => solNumberToLamports(Number.NaN)).toThrow();
  });
});
