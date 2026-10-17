/**
 * The two Meteora DBC configs of a launchpad (docs/METEORA.md, "Settings for the two configs";
 * docs/INTERFACES.md §1-2; docs/PRODUCT.md, flow 1 step 6).
 *
 * - Launchpad config: used by every coin launched on the client's site. Creator share =
 *   `spec.coinCreatorSharePct` (the coin creator, e.g. Lisa).
 * - Launchpad coin config: used only by the launchpad's own coin (e.g. $MOON). Creator share =
 *   `FEES.forgeCreatorSharePct` (25%): FORGE's per-launchpad creator wallet is the pool creator.
 *
 * Both: fee claimer = leftover receiver = the client wallet (`spec.ownerWallet`), quote SOL,
 * trading fee `spec.tradingFeeBps` (with the anti-sniper schedule when `spec.antiSniper`),
 * `enableFirstSwapWithMinFee`, migration to DAMM v2 at exactly 10 SOL, immutable token metadata,
 * all post-graduation liquidity permanently locked. Pool creation fee: `spec.poolCreationFeeSol`
 * on the launchpad config, none on the launchpad coin config (the client would pay it to itself).
 *
 * Choices not fixed by the docs (kept as named constants, see the CHANGELOG):
 * - curve: `buildCurve` with 20% of the supply on migration, 1B tokens with 6 decimals (the
 *   shape run on devnet in tests 1-4);
 * - anti-sniper: linear fee scheduler from 99% down to `spec.tradingFeeBps` in 10 steps over
 *   60 s (linear lands exactly on the client's fee; exponential cannot);
 * - post-graduation liquidity split mirrors the pre-graduation fee split: the creator gets
 *   `creatorTradingFeePercentage`% of the liquidity, the partner (client) the rest, both locked;
 * - migrated DAMM v2 pool fee: `MigrationFeeOption.FixedBps25` (the option migrated on devnet).
 *
 * `buildLaunchpadConfig` / `buildLaunchpadCoinConfig` are pure and deterministic. Every result
 * passes `validate.ts` before it is returned; otherwise a `ValidationError` is thrown.
 */
import {
  CollectFeeMode,
  DynamicBondingCurveClient,
  FEE_DENOMINATOR,
  MAX_BASIS_POINT,
  MAX_CURVE_POINT,
  buildCurve,
  getMigrationThresholdPrice,
  swapQuoteExactIn,
  type BuildCurveParams,
  type ConfigParameters,
  type PoolConfig,
  type SwapQuoteConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import BN from 'bn.js';
import { LaunchpadSpec } from '@forge/shared';
import {
  CLIENT_BOUNDS,
  CLIENT_POOL_CREATION_FEE_LAMPORTS,
  FEES,
  LAMPORTS_PER_SOL_BIGINT,
  SOL_QUOTE_MINT,
  solToLamports,
} from './constants.js';
import { LaunchCoinError, assertSpecLaunchable } from './launch-metadata.js';
import {
  ANTI_SNIPER_FEE_SCHEDULE,
  FORGE_ACTIVATION_TYPE,
  FORGE_MIGRATION_SETTINGS,
  FORGE_TOKEN_SETTINGS,
  forgeFeeSchedulerParam,
} from './settings.js';
import {
  estimatePriorityFee,
  fixedPriorityFee,
  priorityFeeInstructions,
  resolvePriorityFeePolicy,
  type PriorityFeeQuote,
  type PriorityFeeSetting,
} from './priority-fee.js';
import {
  ValidationError,
  assertValid,
  validateLaunchpadCoinConfigParams,
  validateLaunchpadConfigParams,
  type Violation,
} from './validate.js';

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

// The fixed settings live in settings.ts (shared with validate.ts) and stay exported from here.
export {
  ANTI_SNIPER_FEE_SCHEDULE,
  FORGE_ACTIVATION_TYPE,
  FORGE_MIGRATION_SETTINGS,
  FORGE_TOKEN_SETTINGS,
  FORGE_TOKEN_SUPPLY_RAW,
  forgeBaseFee,
  forgeFeeSchedulerParam,
  forgeReferenceCurve,
  type ForgeReferenceCurve,
} from './settings.js';

/**
 * Pool creation fee of the launchpad coin config: none. The only pool ever created on it is the
 * client's own coin, paid by the client: a fee would only move the client's SOL to its own fee
 * claimer account, minus the protocol share. 0 is "no fee" for the pinned SDK
 * (`validatePoolCreationFee`) and was accepted on-chain on devnet (test 1). The launchpad config
 * keeps `spec.poolCreationFeeSol` (paid to the client by every coin of its site).
 */
export const LAUNCHPAD_COIN_POOL_CREATION_FEE_SOL = 0;

/** Pool creation fee of a config kind, in SOL. */
export function poolCreationFeeSolFor(
  spec: Pick<LaunchpadSpec, 'poolCreationFeeSol'>,
  kind: ConfigKind,
): number {
  return kind === 'launchpadCoin' ? LAUNCHPAD_COIN_POOL_CREATION_FEE_SOL : spec.poolCreationFeeSol;
}

/** Which of the two configs. */
export type ConfigKind = 'launchpad' | 'launchpadCoin';

/**
 * The spec fields a config depends on, besides the owner wallet (a full `LaunchpadSpec` fits).
 * Everything else in a FORGE config is a fixed setting (settings.ts).
 */
export type ConfigSpecFields = Pick<
  LaunchpadSpec,
  'tradingFeeBps' | 'antiSniper' | 'coinCreatorSharePct' | 'poolCreationFeeSol'
>;

/**
 * What `createConfig` needs besides the config keypair and the payer: the SDK
 * `ConfigParameters` plus the accounts that decide where the money goes.
 */
export type LaunchpadConfigParams = ConfigParameters & {
  /** Partner fee claimer = the client wallet (`spec.ownerWallet`). */
  feeClaimer: PublicKey;
  /** Receives the leftover base tokens after migration = the client wallet. */
  leftoverReceiver: PublicKey;
  /** Wrapped SOL. */
  quoteMint: PublicKey;
};

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

function specViolations(issues: readonly { path: PropertyKey[]; message: string }[]): Violation[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || 'spec',
    code: 'SPEC_INVALID' as const,
    message: issue.message,
  }));
}

/**
 * Parses the spec with the shared zod schema (the boundary: it may come straight from a
 * database row) and returns the parsed value, defaults applied.
 *
 * @throws ValidationError with `SPEC_INVALID` violations.
 */
export function parseLaunchpadSpec(spec: unknown): LaunchpadSpec {
  const parsed = LaunchpadSpec.safeParse(spec);
  if (!parsed.success) {
    throw new ValidationError('launchpad spec', specViolations(parsed.error.issues));
  }
  ownerKeyOf(parsed.data);
  return parsed.data;
}

/**
 * The owner wallet as a public key: canonical base58 of 32 bytes, not the all-zero key.
 *
 * @throws ValidationError `INVALID_ADDRESS`.
 */
function ownerKeyOf(spec: LaunchpadSpec): PublicKey {
  let key: PublicKey | null;
  try {
    key = new PublicKey(spec.ownerWallet);
  } catch {
    key = null;
  }
  if (!key || key.toBase58() !== spec.ownerWallet || key.equals(PublicKey.default)) {
    throw new ValidationError('launchpad spec', [
      {
        field: 'ownerWallet',
        code: 'INVALID_ADDRESS',
        message: 'ownerWallet must be a valid Solana public key',
      },
    ]);
  }
  return key;
}

/** Creator share of the trading fees for each config kind. */
export function creatorTradingFeePercentageFor(
  spec: Pick<LaunchpadSpec, 'coinCreatorSharePct'>,
  kind: ConfigKind,
): number {
  return kind === 'launchpadCoin' ? FEES.forgeCreatorSharePct : spec.coinCreatorSharePct;
}

/** The `buildCurve` input for a spec (or just its config fields) and a config kind (pure). */
export function curveParamsFor(spec: ConfigSpecFields, kind: ConfigKind): BuildCurveParams {
  const creatorShare = creatorTradingFeePercentageFor(spec, kind);
  return {
    token: { ...FORGE_TOKEN_SETTINGS },
    fee: {
      baseFeeParams: {
        baseFeeMode: ANTI_SNIPER_FEE_SCHEDULE.baseFeeMode,
        feeSchedulerParam: forgeFeeSchedulerParam(spec.tradingFeeBps, spec.antiSniper),
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorShare,
      poolCreationFee: poolCreationFeeSolFor(spec, kind),
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: FORGE_MIGRATION_SETTINGS.migrationOption,
      migrationFeeOption: FORGE_MIGRATION_SETTINGS.migrationFeeOption,
      migrationFee: { ...FORGE_MIGRATION_SETTINGS.migrationFee },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100 - creatorShare,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: creatorShare,
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
  };
}

export interface ConfigParamsOptions {
  /**
   * Metadata URI the launchpad coin will be launched with, when known (the signer knows it from
   * SIGNER_COIN_METADATA_URL): name + symbol + URI must then fit `LAUNCH_METADATA_BUDGET_BYTES`.
   * Without it, only the name, symbol and first buy rules are checked.
   */
  metadataUri?: string;
}

/**
 * Refuses a spec whose launchpad coin could never be launched (`assertSpecLaunchable`), as a
 * `ValidationError`: both configs are created before the launch, so they must not be created
 * for a coin the launch transaction cannot hold.
 */
function assertCoinLaunchable(
  spec: LaunchpadSpec,
  kind: ConfigKind,
  metadataUri: string | undefined,
): void {
  try {
    assertSpecLaunchable(spec, metadataUri ?? null);
  } catch (error) {
    if (!(error instanceof LaunchCoinError)) throw error;
    throw new ValidationError(`${kind} config`, [
      {
        field: 'launchpadCoin',
        code: error.code === 'TX_TOO_LARGE' ? 'LAUNCH_METADATA_TOO_LONG' : 'SPEC_INVALID',
        message: error.message,
      },
    ]);
  }
}

/**
 * Builds and validates one of the two configs. Pure: same spec, same result. Either kind first
 * checks that the launchpad coin can be launched (`assertSpecLaunchable`, with
 * `options.metadataUri` when given).
 *
 * @throws ValidationError when the spec or the resulting parameters break a bound.
 */
export function buildConfigParams(
  spec: LaunchpadSpec,
  kind: ConfigKind,
  options: ConfigParamsOptions = {},
): LaunchpadConfigParams {
  if (kind !== 'launchpad' && kind !== 'launchpadCoin') {
    throw new TypeError(`unknown config kind: ${String(kind)}`);
  }
  const parsed = parseLaunchpadSpec(spec);
  const owner = ownerKeyOf(parsed);
  assertCoinLaunchable(parsed, kind, options.metadataUri);

  let curve: ConfigParameters;
  try {
    curve = buildCurve(curveParamsFor(parsed, kind));
  } catch (error) {
    throw new ValidationError(`${kind} config`, [
      {
        field: 'curve',
        code: 'SDK_REJECTED',
        message: `SDK buildCurve: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }

  const params: LaunchpadConfigParams = {
    ...curve,
    feeClaimer: owner,
    leftoverReceiver: owner,
    quoteMint: SOL_QUOTE_MINT,
  };
  const result =
    kind === 'launchpadCoin'
      ? validateLaunchpadCoinConfigParams(params, parsed)
      : validateLaunchpadConfigParams(params, parsed);
  assertValid(result, `${kind} config`);

  // The launchpad coin is launched with the client's first buy on this config: a first buy the
  // curve cannot take would only fail at launch, after the configs are paid for.
  if (kind === 'launchpadCoin') {
    const firstBuy = solToLamports(parsed.launchpadCoin.firstBuySol);
    const quote = firstBuy > 0n ? quoteFirstBuyOnConfig(params, firstBuy) : null;
    if (quote && !quote.ok) {
      throw new ValidationError(`${kind} config`, [
        { field: 'launchpadCoin.firstBuySol', code: 'SPEC_INVALID', message: quote.message },
      ]);
    }
  }
  return params;
}

/** Launchpad config: every coin of the client's launchpad (creator share = the spec's). */
export function buildLaunchpadConfig(spec: LaunchpadSpec): LaunchpadConfigParams {
  return buildConfigParams(spec, 'launchpad');
}

/** Launchpad coin config: the launchpad's own coin, FORGE is the creator (25%). */
export function buildLaunchpadCoinConfig(spec: LaunchpadSpec): LaunchpadConfigParams {
  return buildConfigParams(spec, 'launchpadCoin');
}

// ---------------------------------------------------------------------------------------------
// On-chain config check
// ---------------------------------------------------------------------------------------------

/** What an on-chain config is expected to be, besides its kind. */
export interface OnchainConfigExpectation {
  /**
   * The spec the config was built from. Every field is then compared with
   * `buildConfigParams(spec, kind)`, exactly what `buildCreateConfigTx` sent.
   */
  spec?: LaunchpadSpec;
  /** Fee claimer and leftover receiver (`spec.ownerWallet` when a spec is given). */
  owner?: PublicKey;
  /** Pool creation fee in lamports (launchpad config; the coin config never has one). */
  poolCreationFeeLamports?: bigint;
}

const FEE_NUMERATOR_PER_BPS = BigInt(FEE_DENOMINATOR / MAX_BASIS_POINT);

/** An integer field (BN, number, bigint or boolean) as a bigint, or null. */
function integerOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (BN.isBN(value)) return BigInt((value as BN).toString());
  return null;
}

/**
 * The spec fields of a config read from the chain, when no spec is given. They must be values a
 * FORGE spec can hold: a linear fee schedule ending on a whole client fee (50..200 bps), a creator
 * share within the client bounds and a client pool creation fee. Problems are pushed to
 * `problems`; a placeholder is returned for an impossible field so that every other field is still
 * compared.
 */
function inferSpecFields(
  config: PoolConfig,
  kind: ConfigKind,
  expectedFeeLamports: bigint | undefined,
  problems: string[],
): { fields: ConfigSpecFields; poolCreationFeeLamports: bigint } {
  const { tradingFeeBps: feeBounds, coinCreatorSharePct: shareBounds } = CLIENT_BOUNDS;
  const baseFee = config.poolFees?.baseFee;
  const cliff = integerOf(baseFee?.cliffFeeNumerator);
  const periods = integerOf(baseFee?.firstFactor);
  const reduction = integerOf(baseFee?.thirdFactor);
  let tradingFeeBps: number = feeBounds.min;
  let antiSniper = false;
  if (
    baseFee?.baseFeeMode !== ANTI_SNIPER_FEE_SCHEDULE.baseFeeMode ||
    cliff === null ||
    periods === null ||
    reduction === null
  ) {
    problems.push('base fee is not a linear fee scheduler');
  } else {
    antiSniper = periods > 0n;
    const ending = cliff - periods * reduction;
    const bps = ending / FEE_NUMERATOR_PER_BPS;
    if (
      ending % FEE_NUMERATOR_PER_BPS !== 0n ||
      bps < BigInt(feeBounds.min) ||
      bps > BigInt(feeBounds.max)
    ) {
      problems.push(
        `trading fee (fee numerator ${ending}) is not a whole fee between ${feeBounds.min} and ${feeBounds.max} bps`,
      );
    } else {
      tradingFeeBps = Number(bps);
    }
  }

  let coinCreatorSharePct: number = shareBounds.default;
  if (kind === 'launchpad') {
    const share = config.creatorTradingFeePercentage;
    if (Number.isInteger(share) && share >= shareBounds.min && share <= shareBounds.max) {
      coinCreatorSharePct = share;
    } else {
      problems.push(
        `creator trading fee ${share}% is not between ${shareBounds.min}% and ${shareBounds.max}%`,
      );
    }
  }

  let poolCreationFeeLamports = 0n;
  if (kind === 'launchpad') {
    const onchain = integerOf(config.poolCreationFee);
    const { min, max, allowZero } = CLIENT_POOL_CREATION_FEE_LAMPORTS;
    if (expectedFeeLamports !== undefined) {
      poolCreationFeeLamports = expectedFeeLamports;
    } else if (
      onchain !== null &&
      ((onchain === 0n && allowZero) || (onchain >= min && onchain <= max))
    ) {
      poolCreationFeeLamports = onchain;
    } else {
      problems.push(`pool creation fee ${String(onchain)} lamports is outside the client bounds`);
    }
  }

  return {
    fields: {
      tradingFeeBps,
      antiSniper,
      coinCreatorSharePct,
      poolCreationFeeSol: Number(poolCreationFeeLamports) / Number(LAMPORTS_PER_SOL_BIGINT),
    },
    poolCreationFeeLamports,
  };
}

/** Every field of `onchain` that differs from what core sends for `params` (`createConfig`). */
function compareWithParams(onchain: PoolConfig, params: LaunchpadConfigParams): string[] {
  const problems: string[] = [];
  const same = (field: string, actual: unknown, expected: unknown) => {
    const a = integerOf(actual);
    const e = integerOf(expected);
    if (a === null || e === null || a !== e) {
      problems.push(`${field} is ${String(a ?? actual)}, expected ${String(e ?? expected)}`);
    }
  };
  const sameKey = (field: string, actual: PublicKey, expected: PublicKey) => {
    if (!actual.equals(expected))
      problems.push(`${field} is ${actual.toBase58()}, expected ${expected.toBase58()}`);
  };

  // Accounts and token.
  sameKey('quoteMint', onchain.quoteMint, params.quoteMint);
  same('quoteTokenFlag', onchain.quoteTokenFlag, 0);
  sameKey('feeClaimer', onchain.feeClaimer, params.feeClaimer);
  sameKey('leftoverReceiver', onchain.leftoverReceiver, params.leftoverReceiver);
  same('tokenType', onchain.tokenType, params.tokenType);
  same('tokenDecimal', onchain.tokenDecimal, params.tokenDecimal);
  same('tokenUpdateAuthority', onchain.tokenUpdateAuthority, params.tokenUpdateAuthority);

  // Fees.
  const base = onchain.poolFees.baseFee;
  const expectedBase = params.poolFees.baseFee;
  same('baseFee.baseFeeMode', base.baseFeeMode, expectedBase.baseFeeMode);
  same('baseFee.cliffFeeNumerator', base.cliffFeeNumerator, expectedBase.cliffFeeNumerator);
  same('baseFee.numberOfPeriod', base.firstFactor, expectedBase.firstFactor);
  same('baseFee.periodFrequency', base.secondFactor, expectedBase.secondFactor);
  same('baseFee.reductionFactor', base.thirdFactor, expectedBase.thirdFactor);
  // FORGE never enables the dynamic fee (validate.ts refuses it).
  same('dynamicFee.initialized', onchain.poolFees.dynamicFee.initialized, 0);
  same('collectFeeMode', onchain.collectFeeMode, params.collectFeeMode);
  same(
    'creatorTradingFeePercentage',
    onchain.creatorTradingFeePercentage,
    params.creatorTradingFeePercentage,
  );
  same('poolCreationFee', onchain.poolCreationFee, params.poolCreationFee);
  same(
    'enableFirstSwapWithMinFee',
    onchain.enableFirstSwapWithMinFee,
    params.enableFirstSwapWithMinFee,
  );
  same('activationType', onchain.activationType, params.activationType);

  // Liquidity after migration.
  same(
    'partnerLiquidityPercentage',
    onchain.partnerLiquidityPercentage,
    params.partnerLiquidityPercentage,
  );
  same(
    'partnerPermanentLockedLiquidityPercentage',
    onchain.partnerPermanentLockedLiquidityPercentage,
    params.partnerPermanentLockedLiquidityPercentage,
  );
  same(
    'creatorLiquidityPercentage',
    onchain.creatorLiquidityPercentage,
    params.creatorLiquidityPercentage,
  );
  same(
    'creatorPermanentLockedLiquidityPercentage',
    onchain.creatorPermanentLockedLiquidityPercentage,
    params.creatorPermanentLockedLiquidityPercentage,
  );
  for (const name of ['partnerLiquidityVestingInfo', 'creatorLiquidityVestingInfo'] as const) {
    const actual = onchain[name];
    const expected = params[name];
    const fields = [
      'vestingPercentage',
      'bpsPerPeriod',
      'numberOfPeriods',
      'frequency',
      'cliffDurationFromMigrationTime',
    ] as const;
    const empty = !expected || fields.every((f) => integerOf(expected[f]) === 0n);
    same(`${name}.isInitialized`, actual.isInitialized, empty ? 0 : 1);
    for (const f of fields) same(`${name}.${f}`, actual[f], expected ? expected[f] : 0);
  }

  // Migration.
  same('migrationOption', onchain.migrationOption, params.migrationOption);
  same('migrationFeeOption', onchain.migrationFeeOption, params.migrationFeeOption);
  same('migrationQuoteThreshold', onchain.migrationQuoteThreshold, params.migrationQuoteThreshold);
  same('migrationFeePercentage', onchain.migrationFeePercentage, params.migrationFee.feePercentage);
  same(
    'creatorMigrationFeePercentage',
    onchain.creatorMigrationFeePercentage,
    params.migrationFee.creatorFeePercentage,
  );
  const migrated = params.migratedPoolFee;
  same('migratedCollectFeeMode', onchain.migratedCollectFeeMode, migrated?.collectFeeMode ?? 0);
  same('migratedDynamicFee', onchain.migratedDynamicFee, migrated?.dynamicFee ?? 0);
  same('migratedPoolFeeBps', onchain.migratedPoolFeeBps, migrated?.poolFeeBps ?? 0);
  same(
    'migratedPoolBaseFeeMode',
    onchain.migratedPoolBaseFeeMode,
    params.migratedPoolBaseFeeMode ?? 0,
  );
  same(
    'migratedCompoundingFeeBps',
    onchain.migratedCompoundingFeeBps,
    params.compoundingFeeBps ?? 0,
  );
  const marketCap = params.migratedPoolMarketCapFeeSchedulerParams;
  const marketCapOff =
    !marketCap ||
    [
      marketCap.numberOfPeriod,
      marketCap.sqrtPriceStepBps,
      marketCap.schedulerExpirationDuration,
      marketCap.reductionFactor,
    ].every((v) => integerOf(v) === 0n);
  if (!marketCapOff) {
    problems.push(
      'the expected config has a migrated pool market cap fee scheduler (not supported)',
    );
  } else if (!onchain.migratedPoolBaseFeeBytes.every((byte) => byte === 0)) {
    problems.push('migratedPoolBaseFeeBytes is set, expected none (no market cap fee scheduler)');
  }

  // Supply: locked vesting, fixed supply, curve.
  const vesting = onchain.lockedVestingConfig;
  const expectedVesting = params.lockedVesting;
  same('lockedVesting.amountPerPeriod', vesting.amountPerPeriod, expectedVesting.amountPerPeriod);
  same(
    'lockedVesting.cliffDurationFromMigrationTime',
    vesting.cliffDurationFromMigrationTime,
    expectedVesting.cliffDurationFromMigrationTime,
  );
  same('lockedVesting.frequency', vesting.frequency, expectedVesting.frequency);
  same('lockedVesting.numberOfPeriod', vesting.numberOfPeriod, expectedVesting.numberOfPeriod);
  same(
    'lockedVesting.cliffUnlockAmount',
    vesting.cliffUnlockAmount,
    expectedVesting.cliffUnlockAmount,
  );
  const supply = params.tokenSupply;
  same('fixedTokenSupplyFlag', onchain.fixedTokenSupplyFlag, supply ? 1 : 0);
  same(
    'preMigrationTokenSupply',
    onchain.preMigrationTokenSupply,
    supply?.preMigrationTokenSupply ?? 0,
  );
  same(
    'postMigrationTokenSupply',
    onchain.postMigrationTokenSupply,
    supply?.postMigrationTokenSupply ?? 0,
  );
  same('sqrtStartPrice', onchain.sqrtStartPrice, params.sqrtStartPrice);
  // The account stores a fixed-size curve (unused points are zero); the params hold at most
  // MAX_CURVE_POINT points.
  const curve = onchain.curve;
  if (curve.length < params.curve.length || params.curve.length > MAX_CURVE_POINT) {
    problems.push(`curve has ${curve.length} points, expected ${params.curve.length} and zeros`);
  } else {
    curve.forEach((point, i) => {
      const expected = params.curve[i];
      same(`curve[${i}].sqrtPrice`, point.sqrtPrice, expected ? expected.sqrtPrice : 0);
      same(`curve[${i}].liquidity`, point.liquidity, expected ? expected.liquidity : 0);
    });
  }
  return problems;
}

/**
 * Compares a config read from the chain with the parameters core builds for it, field by field:
 * accounts, token, base fee (cliff, periods, period, reduction, mode), dynamic fee, creator share,
 * pool creation fee, first swap at the minimum fee, activation, liquidity split and vesting,
 * migration (option, fee option, threshold, migration fee percentages, migrated pool fee), locked
 * vesting, token supply, start price and curve. The values the program derives from these
 * (`swapBaseAmount`, `migrationBaseThreshold`, `migrationSqrtPrice`) are not compared.
 *
 * With `expected.spec`, the reference is `buildConfigParams(spec, kind)`. Without it, the spec
 * fields are read from the config itself (`inferSpecFields`: they must be values a FORGE spec can
 * hold) and every other field must be FORGE's fixed setting; the fee claimer and leftover receiver
 * must be `expected.owner` (or, without it, the same key).
 *
 * @returns every mismatch, as readable messages (on-chain values are public); empty when the config
 *   is exactly a FORGE config of this kind.
 */
export function onchainConfigMismatches(
  config: PoolConfig,
  kind: ConfigKind,
  expected: OnchainConfigExpectation = {},
): string[] {
  if (kind !== 'launchpad' && kind !== 'launchpadCoin') {
    throw new TypeError(`unknown config kind: ${String(kind)}`);
  }
  const problems: string[] = [];
  let params: LaunchpadConfigParams;
  if (expected.spec !== undefined) {
    try {
      params = buildConfigParams(expected.spec, kind);
    } catch (error) {
      return [
        `the spec does not build a valid ${kind} config: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    if (expected.owner && !expected.owner.equals(params.feeClaimer)) {
      problems.push('the expected owner is not spec.ownerWallet');
    }
    if (
      expected.poolCreationFeeLamports !== undefined &&
      expected.poolCreationFeeLamports !== integerOf(params.poolCreationFee)
    ) {
      problems.push('the expected pool creation fee is not the one the spec builds');
    }
  } else {
    const owner = expected.owner ?? config.feeClaimer;
    const inferred = inferSpecFields(config, kind, expected.poolCreationFeeLamports, problems);
    let curve: ConfigParameters;
    try {
      curve = buildCurve(curveParamsFor(inferred.fields, kind));
    } catch (error) {
      return [
        ...problems,
        `SDK buildCurve: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    params = {
      ...curve,
      // Exact lamports: the SOL figure above only feeds buildCurve.
      poolCreationFee: new BN(inferred.poolCreationFeeLamports.toString()),
      feeClaimer: owner,
      leftoverReceiver: owner,
      quoteMint: SOL_QUOTE_MINT,
    };
  }
  problems.push(...compareWithParams(config, params));
  return problems;
}

// ---------------------------------------------------------------------------------------------
// First buy quote
// ---------------------------------------------------------------------------------------------

export interface FirstBuyQuote {
  /** Raw base units (6 decimals) delivered by the first buy. */
  tokensOut: bigint;
  /** `tokensOut` minus the slippage tolerance: the swap's `minimumAmountOut`. */
  minimumTokensOut: bigint;
  /** Fee charged on the first buy (trading + protocol + referral), in lamports. */
  feeLamports: bigint;
}

export type FirstBuyQuoteResult =
  | ({ ok: true } & FirstBuyQuote)
  | { ok: false; reason: 'EXCEEDS_CURVE' | 'TOO_SMALL' | 'FAILED'; message: string };

/**
 * Quote of the first buy of a pool that does not exist yet, at the minimum (ending) fee
 * (`enableFirstSwapWithMinFee`), on a config given either as built here (`ConfigParameters`) or
 * as read from the chain (see `quoteConfigFromPoolConfig`). Pure: it replays the SDK's
 * `getQuoteFromInputAmount` (fresh pool at the start price, empty reserves) with
 * `swapQuoteExactIn`. Exact on devnet (scripts/devnet-tests/reports/core-config-pool.md).
 */
export function quoteFirstBuyOnConfig(
  config: SwapQuoteConfig,
  firstBuyLamports: bigint,
  options: { slippageBps?: number; hasReferral?: boolean } = {},
): FirstBuyQuoteResult {
  if (firstBuyLamports <= 0n) {
    return { ok: false, reason: 'TOO_SMALL', message: 'the first buy must be positive' };
  }
  const dynamicFee = config.poolFees.dynamicFee;
  const quoteConfig = {
    ...config,
    migrationSqrtPrice:
      config.migrationSqrtPrice ??
      getMigrationThresholdPrice(
        config.migrationQuoteThreshold,
        config.sqrtStartPrice,
        config.curve,
      ),
    poolFees: {
      ...config.poolFees,
      dynamicFee: dynamicFee
        ? { ...dynamicFee, initialized: dynamicFee.initialized ?? 1 }
        : { initialized: 0, binStep: 0, variableFeeControl: 0 },
    },
  };
  const freshPool = {
    poolState: {
      sqrtPrice: new BN(config.sqrtStartPrice),
      baseReserve: new BN(0),
      quoteReserve: new BN(0),
      activationPoint: new BN(0),
      volatilityTracker: {
        lastUpdateTimestamp: new BN(0),
        sqrtPriceReference: new BN(0),
        volatilityAccumulator: new BN(0),
        volatilityReference: new BN(0),
        padding: [],
      },
    },
  };
  let result;
  try {
    result = swapQuoteExactIn(
      freshPool as unknown as VirtualPool,
      quoteConfig as unknown as PoolConfig,
      false,
      new BN(firstBuyLamports.toString()),
      options.slippageBps ?? 0,
      options.hasReferral ?? false,
      new BN(0),
      true,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient liquidity|completed/i.test(message)) {
      return {
        ok: false,
        reason: 'EXCEEDS_CURVE',
        message: `a first buy of ${firstBuyLamports} lamports does not fit in the curve before migration (threshold ${CLIENT_BOUNDS.migrationThresholdSol} SOL plus the fee)`,
      };
    }
    return { ok: false, reason: 'FAILED', message: `first buy quote failed: ${message}` };
  }
  const tokensOut = BigInt(result.outputAmount.toString());
  const minimumTokensOut = BigInt((result.minimumAmountOut ?? result.outputAmount).toString());
  if (tokensOut <= 0n || minimumTokensOut <= 0n) {
    return {
      ok: false,
      reason: 'TOO_SMALL',
      message: 'the first buy is too small to receive any token',
    };
  }
  return {
    ok: true,
    tokensOut,
    minimumTokensOut,
    feeLamports:
      BigInt(result.tradingFee.toString()) +
      BigInt(result.protocolFee.toString()) +
      BigInt(result.referralFee.toString()),
  };
}

// ---------------------------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------------------------

/** Compute unit limit of the create-config transaction (36,524 CU measured on devnet). */
export const CREATE_CONFIG_COMPUTE_UNITS = 100_000;

export type CreateConfigErrorCode = 'CONFIG_EXISTS' | 'INVALID_ACCOUNTS';

/** The create-config transaction cannot be built. */
export class CreateConfigError extends Error {
  readonly code: CreateConfigErrorCode;

  constructor(code: CreateConfigErrorCode, message: string) {
    super(message);
    this.name = 'CreateConfigError';
    this.code = code;
  }
}

export interface BuildCreateConfigTxParams {
  connection: Connection;
  /** The spec the config is built from (re-validated here). */
  spec: LaunchpadSpec;
  kind: ConfigKind;
  /** Metadata URI of the launchpad coin, when known (see `ConfigParamsOptions`). */
  metadataUri?: string;
  /**
   * The config keypair (or its public key). Generated and stored by the caller (apps/signer),
   * never here; only its public key is read. It signs the transaction later.
   */
  config: PublicKey | { publicKey: PublicKey };
  /** Pays the config rent and the fee; signs. */
  payer: PublicKey;
  /** Priority fee, in micro-lamports per compute unit (default 0). */
  computeUnitPriceMicroLamports?: number;
  /**
   * Priority fee read from the cluster for the payer and the config account, bounded by this
   * setting (priority-fee.ts). Not with `computeUnitPriceMicroLamports`.
   */
  priority?: PriorityFeeSetting;
  /** Blockhash to use; fetched from the cluster when absent. */
  recentBlockhash?: { blockhash: string; lastValidBlockHeight: number };
}

export interface CreateConfigTx {
  /** Unsigned: the payer and the config keypair sign it (apps/signer). */
  transaction: Transaction;
  configAddress: PublicKey;
  /** Exactly what is sent on-chain (validated). */
  params: LaunchpadConfigParams;
  /** Rent deposit of the config account, read from the cluster. */
  rentLamports: bigint;
  lastValidBlockHeight: number;
  /** Who must sign: the payer (fee payer) and the config keypair. */
  signers: PublicKey[];
  /** The priority fee (price, fee, cap; `fixed` without a `priority` setting). */
  priorityFee: PriorityFeeQuote;
}

/**
 * Unsigned transaction creating one of the two configs (`createConfig`). The parameters are
 * rebuilt from the spec and validated, so nothing unvalidated can be sent. Refuses when the
 * config account already exists (idempotency is the caller's: it keeps the keypair per job).
 */
export async function buildCreateConfigTx(
  params: BuildCreateConfigTxParams,
): Promise<CreateConfigTx> {
  const configAddress =
    params.config instanceof PublicKey ? params.config : params.config.publicKey;
  if (params.priority !== undefined) {
    if (params.computeUnitPriceMicroLamports !== undefined) {
      throw new RangeError('pass either priority or computeUnitPriceMicroLamports, not both');
    }
    resolvePriorityFeePolicy(params.priority);
  }
  const configParams = buildConfigParams(
    params.spec,
    params.kind,
    params.metadataUri !== undefined ? { metadataUri: params.metadataUri } : {},
  );

  if (
    configAddress.equals(params.payer) ||
    configAddress.equals(configParams.feeClaimer) ||
    configAddress.equals(SOL_QUOTE_MINT)
  ) {
    throw new CreateConfigError(
      'INVALID_ACCOUNTS',
      'the config address must be a fresh keypair, distinct from the payer and the fee claimer',
    );
  }

  const { connection } = params;
  if (await connection.getAccountInfo(configAddress, 'confirmed')) {
    throw new CreateConfigError(
      'CONFIG_EXISTS',
      `config ${configAddress.toBase58()} already exists on-chain`,
    );
  }

  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const sdkTx = await client.partner.createConfig({
    ...configParams,
    config: configAddress,
    payer: params.payer,
  });

  const rentLamports = BigInt(
    await connection.getMinimumBalanceForRentExemption(
      client.partner.getProgram().account.poolConfig.size,
    ),
  );
  const { blockhash, lastValidBlockHeight } =
    params.recentBlockhash ?? (await connection.getLatestBlockhash('confirmed'));

  const priorityFee =
    params.priority === undefined
      ? fixedPriorityFee(CREATE_CONFIG_COMPUTE_UNITS, params.computeUnitPriceMicroLamports ?? 0)
      : await estimatePriorityFee({
          connection,
          writableAccounts: [params.payer, configAddress],
          computeUnitLimit: CREATE_CONFIG_COMPUTE_UNITS,
          setting: params.priority,
        });
  const transaction = new Transaction({ feePayer: params.payer, blockhash, lastValidBlockHeight });
  transaction.add(...priorityFeeInstructions(priorityFee), ...sdkTx.instructions);

  return {
    transaction,
    configAddress,
    params: configParams,
    rentLamports,
    lastValidBlockHeight,
    signers: [params.payer, configAddress],
    priorityFee,
  };
}
