import { afterEach, describe, expect, it, vi } from 'vitest';
import { explorerTxUrl, formatSol, formatUsd, shortAddress } from '../format';

describe('formatSol', () => {
  it('formats zero', () => {
    expect(formatSol('0')).toBe('0');
    expect(formatSol('0', { withUnit: true })).toBe('0 SOL');
  });

  it('formats whole and fractional SOL', () => {
    expect(formatSol('1000000000')).toBe('1');
    expect(formatSol('1500000000')).toBe('1.5');
    expect(formatSol('123456789')).toBe('0.1235');
  });

  it('shows 1 lamport as a lower bound by default and exactly with 9 digits', () => {
    expect(formatSol('1')).toBe('<0.0001');
    expect(formatSol('1', { maxFractionDigits: 9 })).toBe('0.000000001');
    expect(formatSol('1', { maxFractionDigits: 0 })).toBe('<1');
  });

  it('is bigint-safe for very large values', () => {
    const lamports = '123456789012345678901234567890';
    expect(formatSol(lamports, { maxFractionDigits: 9 })).toBe(
      '123,456,789,012,345,678,901.23456789',
    );
    expect(formatSol('18446744073709551615', { maxFractionDigits: 9 })).toBe(
      '18,446,744,073.709551615',
    );
  });

  it('rounds half up and carries into the whole part', () => {
    expect(formatSol('999990000', { maxFractionDigits: 3 })).toBe('1');
    expect(formatSol('1000050000', { maxFractionDigits: 4 })).toBe('1.0001');
  });

  it('handles invalid input without throwing', () => {
    expect(formatSol('abc')).toBe('-');
    expect(formatSol('-5')).toBe('-');
  });
});

describe('formatUsd', () => {
  it('formats dollars', () => {
    expect(formatUsd(5.5)).toBe('$5.50');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(Number.NaN)).toBe('-');
  });
});

describe('shortAddress', () => {
  it('shortens long addresses and keeps short ones', () => {
    expect(shortAddress('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe('9xQe...VFin');
    expect(shortAddress('abc')).toBe('abc');
  });
});

describe('explorerTxUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the devnet cluster by default', () => {
    expect(explorerTxUrl('sig1')).toBe('https://explorer.solana.com/tx/sig1?cluster=devnet');
  });

  it('has no cluster param on mainnet', () => {
    vi.stubEnv('NEXT_PUBLIC_SOLANA_CLUSTER', 'mainnet-beta');
    expect(explorerTxUrl('sig1')).toBe('https://explorer.solana.com/tx/sig1');
  });
});
