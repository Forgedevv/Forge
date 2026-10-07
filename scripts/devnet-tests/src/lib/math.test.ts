import { describe, expect, it } from 'vitest';
import {
  approxEqual,
  expectedFeeSplit,
  lamportsToSol,
  missingLamports,
  pct,
  platformFeeLamports,
  solToLamports,
} from './math.js';

describe('expectedFeeSplit', () => {
  it('matches the DEVNET_TESTS.md expectation for test 1 (0.1 SOL, 1%, creator 0)', () => {
    const withRef = expectedFeeSplit(100_000_000n, 100, 0, true);
    expect(withRef).toEqual({
      totalFee: 1_000_000n,
      protocol: 160_000n,
      referral: 40_000n,
      partner: 800_000n,
      creator: 0n,
    });
    const withoutRef = expectedFeeSplit(100_000_000n, 100, 0, false);
    expect(withoutRef).toEqual({
      totalFee: 1_000_000n,
      protocol: 200_000n,
      referral: 0n,
      partner: 800_000n,
      creator: 0n,
    });
  });

  it('splits the non-protocol share between partner and creator (test 2, creator 25%)', () => {
    const s = expectedFeeSplit(100_000_000n, 100, 25, false);
    expect(s.creator).toBe(200_000n);
    expect(s.partner).toBe(600_000n);
    expect(s.partner + s.creator + s.protocol + s.referral).toBe(s.totalFee);
  });

  it('rejects invalid inputs', () => {
    expect(() => expectedFeeSplit(1n, -1, 0, false)).toThrow();
    expect(() => expectedFeeSplit(1n, 100, 101, false)).toThrow();
  });
});

describe('platformFeeLamports', () => {
  it('computes 30 bps rounded down', () => {
    expect(platformFeeLamports(100_000_000n, 30)).toBe(300_000n);
    expect(platformFeeLamports(1n, 30)).toBe(0n);
  });
  it('rejects out-of-range bps', () => {
    expect(() => platformFeeLamports(1n, 10_001)).toThrow();
  });
});

describe('sol conversions', () => {
  it('converts without floating point drift', () => {
    expect(solToLamports(0.1)).toBe(100_000_000n);
    expect(solToLamports(1.000000001)).toBe(1_000_000_001n);
    expect(solToLamports(0)).toBe(0n);
    expect(lamportsToSol(1_234_000_000n)).toBe('1.234');
    expect(lamportsToSol(-5n)).toBe('-0.000000005');
    expect(lamportsToSol(0n)).toBe('0');
  });
});

describe('approxEqual / pct', () => {
  it('works', () => {
    expect(approxEqual(100n, 102n, 2n)).toBe(true);
    expect(approxEqual(100n, 103n, 2n)).toBe(false);
    expect(pct(25n, 100n)).toBe('25.00%');
    expect(pct(1n, 0n)).toBe('n/a');
  });
});

describe('missingLamports', () => {
  it('returns 0 when nothing is missing', () => {
    expect(missingLamports([{ required: 10n, balance: 10n }], 0n, 5n)).toBe(0n);
  });
  it('adds the margin and subtracts the funder balance', () => {
    expect(missingLamports([{ required: 10n, balance: 4n }], 3n, 5n)).toBe(8n);
    expect(missingLamports([{ required: 10n, balance: 4n }], 20n, 5n)).toBe(0n);
  });
});
