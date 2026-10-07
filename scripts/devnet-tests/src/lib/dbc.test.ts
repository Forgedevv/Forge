/**
 * Network-free checks of the config building: the exact curves sent on devnet by the four tests
 * must pass the SDK validation before any SOL is spent.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  TokenAuthorityOption,
  TokenType,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildTestCurve, jsonify, type CurveOptions } from './dbc.js';

const base: CurveOptions = {
  feeBps: 100,
  creatorTradingFeePercentage: 0,
  poolCreationFeeSol: 0.001,
  enableFirstSwapWithMinFee: false,
  migrationQuoteThresholdSol: 10,
  partnerPermanentLockedLiquidityPercentage: 100,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 0,
  creatorLiquidityPercentage: 0,
};

const leftoverReceiver = Keypair.generate().publicKey;

describe('buildTestCurve', () => {
  it('test 1 config: flat 1% fee, no creator share, 10 SOL threshold', () => {
    const p = buildTestCurve(base);
    expect(p.creatorTradingFeePercentage).toBe(0);
    expect(p.enableFirstSwapWithMinFee).toBe(false);
    expect(p.migrationQuoteThreshold.toString()).toBe('10000000000');
    expect(p.poolCreationFee.toString()).toBe('1000000');
    expect(p.collectFeeMode).toBe(CollectFeeMode.QuoteToken);
    expect(p.migrationOption).toBe(MigrationOption.MET_DAMM_V2);
    expect(p.tokenType).toBe(TokenType.SPLToken);
    expect(p.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    expect(p.poolFees.baseFee.cliffFeeNumerator.toString()).toBe('10000000'); // 1% of FEE_DENOMINATOR 1e9
    expect(p.poolFees.baseFee.firstFactor).toBe(0);
    expect(() => validateConfigParameters({ ...p, leftoverReceiver })).not.toThrow();
  });

  it('test 2 config: 25% creator share, 1 SOL threshold, 50/50 permanently locked liquidity', () => {
    const p = buildTestCurve({
      ...base,
      creatorTradingFeePercentage: 25,
      migrationQuoteThresholdSol: 1,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorPermanentLockedLiquidityPercentage: 50,
    });
    expect(p.creatorTradingFeePercentage).toBe(25);
    expect(p.migrationQuoteThreshold.toString()).toBe('1000000000');
    expect(p.partnerPermanentLockedLiquidityPercentage).toBe(50);
    expect(p.creatorPermanentLockedLiquidityPercentage).toBe(50);
    expect(() => validateConfigParameters({ ...p, leftoverReceiver })).not.toThrow();
  });

  it('test 3 config: anti-sniper schedule 99% -> 1% with first swap at min fee', () => {
    const p = buildTestCurve({
      ...base,
      antiSniper: { startingFeeBps: 9900, numberOfPeriod: 10, totalDurationSeconds: 600 },
      creatorTradingFeePercentage: 25,
      enableFirstSwapWithMinFee: true,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorPermanentLockedLiquidityPercentage: 50,
    });
    expect(p.enableFirstSwapWithMinFee).toBe(true);
    expect(p.poolFees.baseFee.baseFeeMode).toBe(BaseFeeMode.FeeSchedulerLinear);
    expect(p.poolFees.baseFee.cliffFeeNumerator.toString()).toBe('990000000');
    expect(p.poolFees.baseFee.firstFactor).toBe(10);
    expect(p.poolFees.baseFee.secondFactor.toString()).toBe('60');
    expect(() => validateConfigParameters({ ...p, leftoverReceiver })).not.toThrow();
  });

  it('poolCreationFee 0 passes the SDK validation (the program decides; test 1 checks on-chain)', () => {
    const p = buildTestCurve({ ...base, poolCreationFeeSol: 0 });
    expect(p.poolCreationFee.toString()).toBe('0');
    expect(() => validateConfigParameters({ ...p, leftoverReceiver })).not.toThrow();
  });

  it('rejects a curve with less than 10% locked liquidity', () => {
    const p = buildTestCurve({ ...base, partnerPermanentLockedLiquidityPercentage: 5, partnerLiquidityPercentage: 95 });
    expect(() => validateConfigParameters({ ...p, leftoverReceiver })).toThrow(/locked/i);
  });
});

describe('jsonify', () => {
  it('turns BN and PublicKey into strings, recursively', () => {
    const p = buildTestCurve(base);
    const json = jsonify({ p, key: leftoverReceiver, n: 1n, nested: [leftoverReceiver] });
    expect(typeof (json as Record<string, unknown>).key).toBe('string');
    expect((json as Record<string, unknown>).n).toBe('1');
    expect(JSON.stringify(json)).toContain('"migrationQuoteThreshold":"10000000000"');
  });
});
