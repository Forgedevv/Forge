/**
 * The fixed settings of every FORGE config (docs/METEORA.md, "Settings for the two configs").
 *
 * They live in their own module so that both the builders (config.ts) and the checks
 * (validate.ts, the on-chain comparison in config.ts) read the same constants without an import
 * cycle. `config.ts` re-exports them: they stay part of its public surface.
 */
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  getBaseFeeParams,
  type BaseFee,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type BN from 'bn.js';
import { CLIENT_BOUNDS, MAX_ANTI_SNIPER_STARTING_FEE_BPS, SOL_DECIMALS } from './constants.js';

/** Token of every coin: SPL token, 1,000,000,000 tokens with 6 decimals, immutable metadata. */
export const FORGE_TOKEN_SETTINGS = {
  tokenType: TokenType.SPLToken,
  tokenBaseDecimal: TokenDecimal.SIX,
  tokenQuoteDecimal: SOL_DECIMALS,
  tokenAuthorityOption: TokenAuthorityOption.Immutable,
  totalTokenSupply: 1_000_000_000,
  leftover: 0,
} as const;

/**
 * Anti-sniper fee schedule (`spec.antiSniper`): the fee starts at `startingFeeBps` and decreases
 * linearly, in `numberOfPeriod` equal steps over `totalDurationSeconds`, to `spec.tradingFeeBps`.
 * validate.ts requires exactly this schedule (or none when `spec.antiSniper` is off).
 */
export const ANTI_SNIPER_FEE_SCHEDULE = {
  baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
  startingFeeBps: MAX_ANTI_SNIPER_STARTING_FEE_BPS,
  numberOfPeriod: 10,
  totalDurationSeconds: 60,
} as const;

/** Migration: DAMM v2, migrated pool fee 0.25%, no migration fee, 20% of the supply migrated. */
export const FORGE_MIGRATION_SETTINGS = {
  migrationOption: MigrationOption.MET_DAMM_V2,
  migrationFeeOption: MigrationFeeOption.FixedBps25,
  migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  percentageSupplyOnMigration: 20,
} as const;

/** Fee scheduler periods are counted in seconds. */
export const FORGE_ACTIVATION_TYPE = ActivationType.Timestamp;

/** Total supply of every coin in raw base units (1,000,000,000 tokens x 10^6). */
export const FORGE_TOKEN_SUPPLY_RAW =
  BigInt(FORGE_TOKEN_SETTINGS.totalTokenSupply) *
  10n ** BigInt(FORGE_TOKEN_SETTINGS.tokenBaseDecimal);

/** The SDK `feeSchedulerParam` of a FORGE config (anti-sniper schedule, or a flat fee). */
export function forgeFeeSchedulerParam(
  tradingFeeBps: number,
  antiSniper: boolean,
): {
  startingFeeBps: number;
  endingFeeBps: number;
  numberOfPeriod: number;
  totalDuration: number;
} {
  const schedule = ANTI_SNIPER_FEE_SCHEDULE;
  return antiSniper
    ? {
        startingFeeBps: schedule.startingFeeBps,
        endingFeeBps: tradingFeeBps,
        numberOfPeriod: schedule.numberOfPeriod,
        totalDuration: schedule.totalDurationSeconds,
      }
    : {
        startingFeeBps: tradingFeeBps,
        endingFeeBps: tradingFeeBps,
        numberOfPeriod: 0,
        totalDuration: 0,
      };
}

/**
 * The base fee a FORGE config must carry for this trading fee and anti-sniper flag, computed by
 * the SDK exactly as `buildCurve` does (cliff, number of periods, period, reduction factor, mode).
 *
 * @throws when the SDK refuses the fee (out of its bounds).
 */
export function forgeBaseFee(tradingFeeBps: number, antiSniper: boolean): BaseFee {
  return getBaseFeeParams({
    baseFeeMode: ANTI_SNIPER_FEE_SCHEDULE.baseFeeMode,
    feeSchedulerParam: forgeFeeSchedulerParam(tradingFeeBps, antiSniper),
  });
}

/** Start price and curve shared by every FORGE config (they only depend on the settings above). */
export interface ForgeReferenceCurve {
  sqrtStartPrice: BN;
  curve: readonly { sqrtPrice: BN; liquidity: BN }[];
}

let referenceCurve: ForgeReferenceCurve | null = null;

/**
 * The curve and start price of every FORGE config. They follow from the token settings, the
 * migration settings and the 10 SOL threshold only (the SDK's `buildCurve` does not read the
 * fees or the liquidity split for them), so one reference fits both configs of every launchpad.
 * The curve decides how the supply is split between the swap, the migration and the leftover
 * (sent to the leftover receiver): pinning it pins the leftover. Computed once, then cached.
 */
export function forgeReferenceCurve(): ForgeReferenceCurve {
  if (referenceCurve) return referenceCurve;
  const built = buildCurve({
    token: { ...FORGE_TOKEN_SETTINGS },
    fee: {
      baseFeeParams: {
        baseFeeMode: ANTI_SNIPER_FEE_SCHEDULE.baseFeeMode,
        feeSchedulerParam: forgeFeeSchedulerParam(CLIENT_BOUNDS.tradingFeeBps.min, false),
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: FORGE_MIGRATION_SETTINGS.migrationOption,
      migrationFeeOption: FORGE_MIGRATION_SETTINGS.migrationFeeOption,
      migrationFee: { ...FORGE_MIGRATION_SETTINGS.migrationFee },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: FORGE_ACTIVATION_TYPE,
    percentageSupplyOnMigration: FORGE_MIGRATION_SETTINGS.percentageSupplyOnMigration,
    migrationQuoteThreshold: CLIENT_BOUNDS.migrationThresholdSol,
  });
  referenceCurve = { sqrtStartPrice: built.sqrtStartPrice, curve: built.curve };
  return referenceCurve;
}
