import * as sdk from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import * as shared from '@forge/shared';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_BOUNDS,
  CLIENT_POOL_CREATION_FEE_LAMPORTS,
  FEES,
  LAMPORTS_PER_SOL,
  MAX_FEE_BPS,
  MAX_MIGRATED_POOL_FEE_BPS,
  MAX_POOL_CREATION_FEE,
  MIGRATION_THRESHOLD_LAMPORTS,
  MIN_FEE_BPS,
  MIN_LOCKED_LIQUIDITY_BPS,
  MIN_MIGRATED_POOL_FEE_BPS,
  MIN_POOL_CREATION_FEE,
  OPS,
  PRICING,
  SOL_QUOTE_MINT,
  solToLamports,
} from './constants.js';

describe('constants', () => {
  it('re-exports the shared business constants unchanged', () => {
    expect(PRICING).toBe(shared.PRICING);
    expect(FEES).toBe(shared.FEES);
    expect(CLIENT_BOUNDS).toBe(shared.CLIENT_BOUNDS);
    expect(OPS).toBe(shared.OPS);
    expect(LAMPORTS_PER_SOL).toBe(shared.LAMPORTS_PER_SOL);
  });

  it('re-exports the SDK bounds (values of docs/METEORA.md)', () => {
    expect(MIN_FEE_BPS).toBe(sdk.MIN_FEE_BPS);
    expect([MIN_FEE_BPS, MAX_FEE_BPS]).toEqual([25, 9900]);
    expect([MIN_MIGRATED_POOL_FEE_BPS, MAX_MIGRATED_POOL_FEE_BPS]).toEqual([10, 1000]);
    expect(MIN_LOCKED_LIQUIDITY_BPS).toBe(1000);
    expect([MIN_POOL_CREATION_FEE, MAX_POOL_CREATION_FEE]).toEqual([1_000_000, 100_000_000_000]);
  });

  it('keeps the client bounds inside the SDK bounds', () => {
    expect(CLIENT_BOUNDS.tradingFeeBps.min).toBeGreaterThanOrEqual(MIN_FEE_BPS);
    expect(CLIENT_BOUNDS.tradingFeeBps.max).toBeLessThanOrEqual(MAX_FEE_BPS);
    expect(CLIENT_POOL_CREATION_FEE_LAMPORTS.min).toBe(BigInt(MIN_POOL_CREATION_FEE));
    expect(CLIENT_POOL_CREATION_FEE_LAMPORTS.max).toBeLessThanOrEqual(
      BigInt(MAX_POOL_CREATION_FEE),
    );
    expect(CLIENT_POOL_CREATION_FEE_LAMPORTS.max).toBe(1_000_000_000n);
  });

  it('uses wrapped SOL as the quote mint and 10 SOL as the migration threshold', () => {
    expect(SOL_QUOTE_MINT.equals(NATIVE_MINT)).toBe(true);
    expect(MIGRATION_THRESHOLD_LAMPORTS).toBe(10_000_000_000n);
  });
});

describe('solToLamports', () => {
  it.each([
    [0, 0n],
    [0.001, 1_000_000n],
    [0.000000001, 1n],
    [0.3, 300_000_000n],
    [1, 1_000_000_000n],
    [10, 10_000_000_000n],
    [100, 100_000_000_000n],
    [123.456789012, 123_456_789_012n],
  ])('converts %d SOL', (sol, lamports) => {
    expect(solToLamports(sol)).toBe(lamports);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.0000000001, 0.1 + 0.2, 2_000_000])(
    'rejects %d',
    (sol) => {
      expect(() => solToLamports(sol)).toThrow(RangeError);
    },
  );
});
