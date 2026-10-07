import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  bpsToFeeNumerator,
  buildCurve,
  type BuildCurveParams,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import type { LaunchpadSpec } from '@forge/shared';
import {
  FEES,
  MAX_FEE_BPS,
  MAX_MIGRATED_POOL_FEE_BPS,
  MAX_POOL_CREATION_FEE,
  MIN_FEE_BPS,
  MIN_LOCKED_LIQUIDITY_BPS,
  MIN_MIGRATED_POOL_FEE_BPS,
  MIN_POOL_CREATION_FEE,
  SOL_QUOTE_MINT,
  SOL_QUOTE_MINT_2022,
} from './constants.js';
import {
  ValidationError,
  assertValid,
  validateLaunchpadCoinConfigParams,
  validateLaunchpadConfigParams,
  validateSpecOnchain,
  type ConfigCandidate,
  type ValidationResult,
  type ViolationCode,
} from './validate.js';

const OWNER = new PublicKey(Keypair.generate().publicKey.toBase58());
const OTHER = Keypair.generate().publicKey;

function makeSpec(overrides: Partial<LaunchpadSpec> = {}): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: OWNER.toBase58(),
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.05,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#22C55E',
      darkMode: true,
      tagline: 'To the moon',
      designNotes: '',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: 'The MoonPad coin',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 1,
    },
    ...overrides,
  };
}

interface CurveOptions {
  tradingFeeBps?: number;
  antiSniper?: boolean;
  startingFeeBps?: number;
  baseFeeMode?: BaseFeeMode.FeeSchedulerLinear | BaseFeeMode.FeeSchedulerExponential;
  creatorTradingFeePercentage?: number;
  poolCreationFeeSol?: number;
  creatorLocked?: number;
  partnerLocked?: number;
  partnerLiquidity?: number;
  creatorLiquidity?: number;
  migrationFeeOption?: MigrationFeeOption;
  migratedPoolFeeBps?: number;
  migrationThresholdSol?: number;
}

function curveParams(o: CurveOptions = {}): BuildCurveParams {
  const tradingFeeBps = o.tradingFeeBps ?? 100;
  const antiSniper = o.antiSniper ?? true;
  const customizable =
    (o.migrationFeeOption ?? MigrationFeeOption.Customizable) === MigrationFeeOption.Customizable;
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: o.baseFeeMode ?? BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: antiSniper
          ? {
              startingFeeBps: o.startingFeeBps ?? 5000,
              endingFeeBps: tradingFeeBps,
              numberOfPeriod: 10,
              totalDuration: 60,
            }
          : {
              startingFeeBps: tradingFeeBps,
              endingFeeBps: tradingFeeBps,
              numberOfPeriod: 0,
              totalDuration: 0,
            },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorTradingFeePercentage ?? 25,
      poolCreationFee: o.poolCreationFeeSol ?? 0.05,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: o.migrationFeeOption ?? MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      ...(customizable
        ? {
            migratedPoolFee: {
              collectFeeMode: MigratedCollectFeeMode.QuoteToken,
              dynamicFee: DammV2DynamicFeeMode.Disabled,
              poolFeeBps: o.migratedPoolFeeBps ?? 100,
            },
          }
        : {}),
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: o.partnerLocked ?? 50,
      partnerLiquidityPercentage: o.partnerLiquidity ?? 0,
      creatorPermanentLockedLiquidityPercentage: o.creatorLocked ?? 50,
      creatorLiquidityPercentage: o.creatorLiquidity ?? 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: o.migrationThresholdSol ?? 10,
  };
}

function makeConfig(o: CurveOptions = {}): ConfigCandidate {
  return {
    ...buildCurve(curveParams(o)),
    feeClaimer: OWNER,
    leftoverReceiver: OWNER,
    quoteMint: SOL_QUOTE_MINT,
  };
}

function codes(result: ValidationResult): ViolationCode[] {
  return result.violations.map((v) => v.code);
}

describe('validateSpecOnchain', () => {
  it('accepts a valid spec', () => {
    expect(validateSpecOnchain(makeSpec())).toEqual({ ok: true, violations: [] });
  });

  it.each([50, 51, 199, 200])('accepts tradingFeeBps %i (client bounds)', (bps) => {
    expect(validateSpecOnchain(makeSpec({ tradingFeeBps: bps })).ok).toBe(true);
  });

  it.each([49, 201, 100.5])('rejects tradingFeeBps %d', (bps) => {
    const result = validateSpecOnchain(makeSpec({ tradingFeeBps: bps }));
    expect(codes(result)).toContain('FEE_OUT_OF_CLIENT_BOUNDS');
  });

  it('reports the SDK fee bounds too', () => {
    expect(codes(validateSpecOnchain(makeSpec({ tradingFeeBps: MIN_FEE_BPS - 1 })))).toEqual([
      'FEE_OUT_OF_SDK_BOUNDS',
      'FEE_OUT_OF_CLIENT_BOUNDS',
    ]);
    expect(codes(validateSpecOnchain(makeSpec({ tradingFeeBps: MAX_FEE_BPS + 1 })))).toContain(
      'FEE_OUT_OF_SDK_BOUNDS',
    );
  });

  it.each([0, 50])('accepts coinCreatorSharePct %i', (pct) => {
    expect(validateSpecOnchain(makeSpec({ coinCreatorSharePct: pct })).ok).toBe(true);
  });

  it.each([-1, 51, 2.5])('rejects coinCreatorSharePct %d', (pct) => {
    expect(codes(validateSpecOnchain(makeSpec({ coinCreatorSharePct: pct })))).toEqual([
      'CREATOR_TRADING_FEE_OUT_OF_BOUNDS',
    ]);
  });

  it.each([0, 0.001, 0.5, 1])('accepts poolCreationFeeSol %d', (sol) => {
    expect(validateSpecOnchain(makeSpec({ poolCreationFeeSol: sol })).ok).toBe(true);
  });

  it.each([0.000999999, 1.000000001, -0.001, 0.0005])('rejects poolCreationFeeSol %d', (sol) => {
    expect(validateSpecOnchain(makeSpec({ poolCreationFeeSol: sol })).ok).toBe(false);
  });

  it('rejects a pool creation fee with sub-lamport precision', () => {
    expect(validateSpecOnchain(makeSpec({ poolCreationFeeSol: 0.1 + 0.2 })).ok).toBe(false);
  });

  it('rejects an invalid owner wallet and a non-SOL quote', () => {
    const spec = {
      ...makeSpec(),
      ownerWallet: 'not-a-key',
      quote: 'USDC',
    } as unknown as LaunchpadSpec;
    expect(codes(validateSpecOnchain(spec))).toEqual(['QUOTE_NOT_SOL', 'INVALID_ADDRESS']);
  });

  it.each([-1, 100.000000001])('rejects firstBuySol %d', (sol) => {
    const spec = makeSpec();
    spec.launchpadCoin.firstBuySol = sol;
    expect(codes(validateSpecOnchain(spec))).toEqual(['SPEC_INVALID']);
  });

  it('reports several violations together', () => {
    const result = validateSpecOnchain(
      makeSpec({ tradingFeeBps: 300, coinCreatorSharePct: 60, poolCreationFeeSol: 2 }),
    );
    expect(codes(result)).toEqual([
      'FEE_OUT_OF_CLIENT_BOUNDS',
      'CREATOR_TRADING_FEE_OUT_OF_BOUNDS',
      'POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS',
    ]);
  });
});

describe('validateLaunchpadConfigParams: valid configs', () => {
  it('accepts a config built with the SDK from the spec (exponential anti-sniper)', () => {
    const result = validateLaunchpadConfigParams(makeConfig(), makeSpec());
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('accepts a linear anti-sniper scheduler', () => {
    const config = makeConfig({ baseFeeMode: BaseFeeMode.FeeSchedulerLinear });
    expect(validateLaunchpadConfigParams(config, makeSpec()).violations).toEqual([]);
  });

  it('accepts a flat fee when anti-sniper is off', () => {
    const config = makeConfig({ antiSniper: false });
    expect(
      validateLaunchpadConfigParams(config, makeSpec({ antiSniper: false })).violations,
    ).toEqual([]);
  });

  it.each([50, 200])('accepts the client fee bound %i bps', (bps) => {
    const config = makeConfig({ tradingFeeBps: bps });
    expect(
      validateLaunchpadConfigParams(config, makeSpec({ tradingFeeBps: bps })).violations,
    ).toEqual([]);
  });

  it('accepts base58 strings for the accounts', () => {
    const config = {
      ...makeConfig(),
      feeClaimer: OWNER.toBase58(),
      leftoverReceiver: OWNER.toBase58(),
      quoteMint: SOL_QUOTE_MINT.toBase58(),
    };
    expect(validateLaunchpadConfigParams(config, makeSpec()).ok).toBe(true);
  });

  it('accepts the coin config with FORGE creator share and locked creator liquidity', () => {
    const config = makeConfig({ creatorTradingFeePercentage: FEES.forgeCreatorSharePct });
    expect(
      validateLaunchpadCoinConfigParams(config, makeSpec({ coinCreatorSharePct: 10 })).violations,
    ).toEqual([]);
  });
});

describe('validateLaunchpadConfigParams: trading fee', () => {
  it.each([49, 201])('rejects an ending fee of %i bps (outside client bounds)', (bps) => {
    const config = makeConfig({ tradingFeeBps: bps });
    expect(
      codes(validateLaunchpadConfigParams(config, makeSpec({ tradingFeeBps: bps }))),
    ).toContain('FEE_OUT_OF_CLIENT_BOUNDS');
  });

  it('accepts the exponential scheduler rounding (ending fee within half a bps of the spec)', () => {
    // The SDK floors the exponential reduction factor, so the ending fee lands slightly above.
    const config = makeConfig({ tradingFeeBps: 133 });
    expect(
      validateLaunchpadConfigParams(config, makeSpec({ tradingFeeBps: 133 })).violations,
    ).toEqual([]);
  });

  it('rejects a fee that differs from the spec', () => {
    const config = makeConfig({ tradingFeeBps: 150 });
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ tradingFeeBps: 100 })))).toEqual([
      'FEE_MISMATCH',
    ]);
  });

  it('rejects a flat fee 1 numerator unit away from the spec', () => {
    const config = makeConfig({ antiSniper: false });
    config.poolFees.baseFee.cliffFeeNumerator = bpsToFeeNumerator(100).addn(1);
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ antiSniper: false })))).toEqual([
      'FEE_MISMATCH',
    ]);
  });

  it(`accepts a starting fee of exactly ${MAX_FEE_BPS} bps and rejects ${MAX_FEE_BPS + 1}`, () => {
    expect(
      validateLaunchpadConfigParams(makeConfig({ startingFeeBps: MAX_FEE_BPS }), makeSpec()).ok,
    ).toBe(true);
    const config = makeConfig({ startingFeeBps: MAX_FEE_BPS });
    config.poolFees.baseFee.cliffFeeNumerator = bpsToFeeNumerator(MAX_FEE_BPS + 1);
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'FEE_OUT_OF_SDK_BOUNDS',
    );
  });

  it(`rejects a flat fee below the SDK minimum (${MIN_FEE_BPS} bps)`, () => {
    const config = makeConfig({ antiSniper: false });
    config.poolFees.baseFee.cliffFeeNumerator = bpsToFeeNumerator(MIN_FEE_BPS - 1);
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ antiSniper: false })))).toEqual(
      expect.arrayContaining(['FEE_OUT_OF_SDK_BOUNDS']),
    );
  });

  it('rejects anti-sniper on in the spec but no scheduler in the config', () => {
    const config = makeConfig({ antiSniper: false });
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ antiSniper: true })))).toEqual([
      'ANTI_SNIPER_MISMATCH',
    ]);
  });

  it('rejects anti-sniper off in the spec but a scheduler in the config', () => {
    const config = makeConfig({ antiSniper: true });
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ antiSniper: false })))).toEqual([
      'ANTI_SNIPER_MISMATCH',
    ]);
  });

  it('rejects a half-configured fee scheduler', () => {
    const config = makeConfig();
    config.poolFees.baseFee.secondFactor = new BN(0);
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'FEE_SCHEDULER_INVALID',
    );
  });

  it('rejects the deprecated rate limiter mode', () => {
    const config = makeConfig({ antiSniper: false });
    config.poolFees.baseFee.baseFeeMode = BaseFeeMode.RateLimiter;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec({ antiSniper: false })))).toContain(
      'FEE_MODE_NOT_ALLOWED',
    );
  });

  it('rejects a dynamic fee', () => {
    const config = makeConfig({});
    config.poolFees.dynamicFee = {
      binStep: 1,
      binStepU128: new BN(0),
      filterPeriod: 10,
      decayPeriod: 120,
      reductionFactor: 5000,
      maxVolatilityAccumulator: 0,
      variableFeeControl: 0,
    };
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'DYNAMIC_FEE_NOT_ALLOWED',
    );
  });

  it('rejects collecting fees in the output token', () => {
    const config = makeConfig();
    config.collectFeeMode = CollectFeeMode.OutputToken;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'COLLECT_FEE_MODE_NOT_ALLOWED',
    );
  });
});

describe('validateLaunchpadConfigParams: migration', () => {
  it.each([MIN_MIGRATED_POOL_FEE_BPS, MAX_MIGRATED_POOL_FEE_BPS])(
    'accepts a migrated pool fee of %i bps',
    (bps) => {
      expect(
        validateLaunchpadConfigParams(makeConfig({ migratedPoolFeeBps: bps }), makeSpec()).ok,
      ).toBe(true);
    },
  );

  it.each([MIN_MIGRATED_POOL_FEE_BPS - 1, MAX_MIGRATED_POOL_FEE_BPS + 1])(
    'rejects a migrated pool fee of %i bps',
    (bps) => {
      const config = makeConfig();
      config.migratedPoolFee.poolFeeBps = bps;
      expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
        'MIGRATED_POOL_FEE_OUT_OF_BOUNDS',
      );
    },
  );

  it('accepts a fixed migration fee option with an all-zero migrated pool fee', () => {
    const config = makeConfig({ migrationFeeOption: MigrationFeeOption.FixedBps100 });
    expect(validateLaunchpadConfigParams(config, makeSpec()).violations).toEqual([]);
  });

  it('rejects a fixed migration fee option with a migrated pool fee set', () => {
    const config = makeConfig({ migrationFeeOption: MigrationFeeOption.FixedBps100 });
    config.migratedPoolFee.poolFeeBps = 100;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'MIGRATED_POOL_FEE_INVALID',
    );
  });

  it('accepts exactly 10 SOL and rejects 1 lamport more or less', () => {
    const ok = makeConfig();
    expect(ok.migrationQuoteThreshold.toString()).toBe('10000000000');
    expect(validateLaunchpadConfigParams(ok, makeSpec()).ok).toBe(true);
    for (const delta of [1, -1]) {
      const config = makeConfig();
      config.migrationQuoteThreshold = new BN('10000000000').addn(delta);
      expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
        'MIGRATION_THRESHOLD_MISMATCH',
      );
    }
  });

  it('rejects another migration threshold built with the SDK', () => {
    const config = makeConfig({ migrationThresholdSol: 85 });
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'MIGRATION_THRESHOLD_MISMATCH',
    );
  });

  it('rejects the deprecated DAMM v1 migration', () => {
    const config = makeConfig({ migrationFeeOption: MigrationFeeOption.FixedBps100 });
    config.migrationOption = MigrationOption.MET_DAMM;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'MIGRATION_OPTION_NOT_ALLOWED',
    );
  });

  it('rejects an invalid migration fee', () => {
    const config = makeConfig();
    config.migrationFee = { feePercentage: 100, creatorFeePercentage: 0 };
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'MIGRATION_FEE_INVALID',
    );
  });
});

describe('validateLaunchpadConfigParams: pool creation fee', () => {
  it.each([0, 0.001, 1])('accepts %d SOL matching the spec', (sol) => {
    const config = makeConfig({ poolCreationFeeSol: sol });
    expect(
      validateLaunchpadConfigParams(config, makeSpec({ poolCreationFeeSol: sol })).violations,
    ).toEqual([]);
  });

  it('rejects 1 lamport below the minimum and 1 lamport above the client maximum', () => {
    const below = makeConfig();
    below.poolCreationFee = new BN(MIN_POOL_CREATION_FEE - 1);
    expect(codes(validateLaunchpadConfigParams(below, makeSpec()))).toEqual(
      expect.arrayContaining([
        'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS',
        'POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS',
      ]),
    );
    const above = makeConfig();
    above.poolCreationFee = new BN('1000000001');
    const aboveCodes = codes(validateLaunchpadConfigParams(above, makeSpec()));
    expect(aboveCodes).toContain('POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS');
    expect(aboveCodes).not.toContain('POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS');
  });

  it('rejects 1 lamport above the SDK maximum', () => {
    const config = makeConfig();
    config.poolCreationFee = new BN(MAX_POOL_CREATION_FEE).addn(1);
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS',
    );
  });

  it('rejects a fee that differs from the spec', () => {
    const config = makeConfig({ poolCreationFeeSol: 0.5 });
    expect(
      codes(validateLaunchpadConfigParams(config, makeSpec({ poolCreationFeeSol: 0.05 }))),
    ).toEqual(['POOL_CREATION_FEE_MISMATCH']);
  });
});

describe('validateLaunchpadConfigParams: creator share, liquidity, accounts, token', () => {
  it('rejects a creator trading fee different from spec.coinCreatorSharePct', () => {
    const config = makeConfig({ creatorTradingFeePercentage: 30 });
    expect(
      codes(validateLaunchpadConfigParams(config, makeSpec({ coinCreatorSharePct: 25 }))),
    ).toEqual(['CREATOR_TRADING_FEE_MISMATCH']);
  });

  it('rejects a creator trading fee above 100%', () => {
    const config = makeConfig();
    config.creatorTradingFeePercentage = 101;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'CREATOR_TRADING_FEE_OUT_OF_BOUNDS',
    );
  });

  it('accepts exactly 10% locked liquidity and rejects 9%', () => {
    const at10 = makeConfig({
      partnerLocked: 5,
      creatorLocked: 5,
      partnerLiquidity: 45,
      creatorLiquidity: 45,
    });
    expect(validateLaunchpadConfigParams(at10, makeSpec()).violations).toEqual([]);
    const at9 = makeConfig({
      partnerLocked: 5,
      creatorLocked: 5,
      partnerLiquidity: 45,
      creatorLiquidity: 45,
    });
    at9.creatorPermanentLockedLiquidityPercentage = 4;
    at9.creatorLiquidityPercentage = 46;
    const result = validateLaunchpadConfigParams(at9, makeSpec());
    expect(codes(result)).toContain('LOCKED_LIQUIDITY_TOO_LOW');
    expect(MIN_LOCKED_LIQUIDITY_BPS).toBe(1000);
  });

  it('rejects liquidity percentages that do not sum to 100', () => {
    const config = makeConfig();
    config.partnerLiquidityPercentage = 1;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'LP_PERCENTAGES_INVALID',
    );
  });

  it('rejects a coin config without locked creator liquidity or with the client creator share', () => {
    const config = makeConfig({
      creatorLocked: 0,
      partnerLocked: 100,
      creatorTradingFeePercentage: 10,
    });
    expect(codes(validateLaunchpadCoinConfigParams(config, makeSpec()))).toEqual([
      'CREATOR_TRADING_FEE_MISMATCH',
      'CREATOR_LOCKED_LIQUIDITY_REQUIRED',
    ]);
  });

  it('rejects a non-SOL quote mint, including Token-2022 wrapped SOL', () => {
    for (const quoteMint of [OTHER, SOL_QUOTE_MINT_2022, 'not-a-key']) {
      const config = { ...makeConfig(), quoteMint };
      expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain('QUOTE_NOT_SOL');
    }
  });

  it('rejects a fee claimer or leftover receiver that is not the client wallet', () => {
    const config = { ...makeConfig(), feeClaimer: OTHER, leftoverReceiver: 'bad' };
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toEqual(
      expect.arrayContaining(['FEE_CLAIMER_MISMATCH', 'INVALID_ADDRESS']),
    );
  });

  it.each([
    TokenAuthorityOption.CreatorUpdateAuthority,
    TokenAuthorityOption.PartnerUpdateAuthority,
    TokenAuthorityOption.CreatorUpdateAndMintAuthority,
    TokenAuthorityOption.PartnerUpdateAndMintAuthority,
  ])('rejects token update authority %i', (option) => {
    const config = makeConfig();
    config.tokenUpdateAuthority = option;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toContain(
      'TOKEN_UPDATE_AUTHORITY_NOT_IMMUTABLE',
    );
  });

  it('rejects enableFirstSwapWithMinFee = false', () => {
    const config = makeConfig();
    config.enableFirstSwapWithMinFee = false;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toEqual([
      'FIRST_SWAP_MIN_FEE_REQUIRED',
    ]);
  });

  it('rejects invalid token decimals, token type and activation type', () => {
    const config = makeConfig();
    config.tokenDecimal = 5;
    config.tokenType = 7;
    config.activationType = 9;
    expect(codes(validateLaunchpadConfigParams(config, makeSpec()))).toEqual(
      expect.arrayContaining([
        'TOKEN_DECIMAL_INVALID',
        'TOKEN_TYPE_INVALID',
        'ACTIVATION_TYPE_INVALID',
      ]),
    );
  });
});

describe('multiple violations', () => {
  it('reports every violation at once, not just the first', () => {
    const config = {
      ...makeConfig({
        tradingFeeBps: 150,
        poolCreationFeeSol: 0.5,
        creatorTradingFeePercentage: 40,
      }),
      quoteMint: OTHER,
      feeClaimer: OTHER,
    };
    config.migrationQuoteThreshold = new BN(1);
    config.tokenUpdateAuthority = TokenAuthorityOption.CreatorUpdateAuthority;
    config.enableFirstSwapWithMinFee = false;
    const result = validateLaunchpadConfigParams(config, makeSpec({ tradingFeeBps: 300 }));
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'FEE_OUT_OF_CLIENT_BOUNDS',
        'QUOTE_NOT_SOL',
        'FEE_CLAIMER_MISMATCH',
        'FEE_MISMATCH',
        'MIGRATION_THRESHOLD_MISMATCH',
        'POOL_CREATION_FEE_MISMATCH',
        'CREATOR_TRADING_FEE_MISMATCH',
        'TOKEN_UPDATE_AUTHORITY_NOT_IMMUTABLE',
        'FIRST_SWAP_MIN_FEE_REQUIRED',
      ]),
    );
    expect(result.violations.find((v) => v.field === 'spec.tradingFeeBps')).toBeDefined();
  });

  it('assertValid throws a ValidationError listing all violations', () => {
    const config = makeConfig();
    config.enableFirstSwapWithMinFee = false;
    config.tokenUpdateAuthority = TokenAuthorityOption.CreatorUpdateAuthority;
    const result = validateLaunchpadConfigParams(config, makeSpec());
    expect(() => assertValid(result, 'launchpad config')).toThrow(ValidationError);
    try {
      assertValid(result, 'launchpad config');
    } catch (error) {
      expect((error as ValidationError).violations).toHaveLength(2);
      expect((error as Error).message).toContain('FIRST_SWAP_MIN_FEE_REQUIRED');
      expect((error as Error).message).toContain('TOKEN_UPDATE_AUTHORITY_NOT_IMMUTABLE');
    }
    expect(() =>
      assertValid(validateLaunchpadConfigParams(makeConfig(), makeSpec()), 'x'),
    ).not.toThrow();
  });
});
