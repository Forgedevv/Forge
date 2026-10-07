/**
 * On-chain parameter validation (PLANEXECUTE.md rule 8, docs/METEORA.md, docs/INTERFACES.md §1-2).
 *
 * Every config goes through one of these pure functions right before `createConfig`. They never
 * throw on bad input: they return every violation found, so a caller sees all problems at once.
 * Each one checks:
 *  - the SDK bounds (fees 25..9900 bps, migrated pool fee 10..1000 bps, locked liquidity >= 10%,
 *    pool creation fee 0 or 0.001..100 SOL, ...), using the SDK constants and helpers;
 *  - FORGE's stricter bounds (client trading fee 50..200 bps, pool creation fee 0 or 0.001..1 SOL,
 *    migration threshold exactly 10 SOL, SOL quote, immutable metadata, ...);
 *  - that the parameters match the spec they were built from;
 *  - finally, the SDK's own `validateConfigParameters`, as a catch-all for curve-level rules.
 * Lamport amounts are compared as `bigint`.
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
  bpsToFeeNumerator,
  calculateLockedLiquidityBpsAtTime,
  getFeeSchedulerMinBaseFeeNumerator,
  validateConfigParameters,
  validateFeeScheduler,
  validateLPPercentages,
  validateLiquidityVestingInfo,
  validateMigratedPoolFee,
  validateMigrationFee,
  validateMigrationFeeOption,
  validatePoolCreationFee,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import type { LaunchpadSpec } from '@forge/shared';
import {
  CLIENT_BOUNDS,
  CLIENT_POOL_CREATION_FEE_LAMPORTS,
  FEE_DENOMINATOR,
  FEES,
  MAX_ANTI_SNIPER_DURATION_SECONDS,
  MAX_ANTI_SNIPER_DURATION_SLOTS,
  MAX_ANTI_SNIPER_STARTING_FEE_BPS,
  MAX_BASIS_POINT,
  MAX_FEE_BPS,
  MAX_FEE_NUMERATOR,
  MAX_MIGRATED_POOL_FEE_BPS,
  MAX_POOL_CREATION_FEE,
  MIGRATION_THRESHOLD_LAMPORTS,
  MIN_FEE_BPS,
  MIN_FEE_NUMERATOR,
  MIN_LOCKED_LIQUIDITY_BPS,
  MIN_MIGRATED_POOL_FEE_BPS,
  MIN_POOL_CREATION_FEE,
  SECONDS_PER_DAY,
  SOL_QUOTE_MINT,
  solToLamports,
} from './constants.js';

export type ViolationCode =
  | 'INVALID_ADDRESS'
  | 'QUOTE_NOT_SOL'
  | 'FEE_CLAIMER_MISMATCH'
  | 'LEFTOVER_RECEIVER_MISMATCH'
  | 'FEE_MODE_NOT_ALLOWED'
  | 'FEE_OUT_OF_SDK_BOUNDS'
  | 'FEE_OUT_OF_CLIENT_BOUNDS'
  | 'FEE_MISMATCH'
  | 'FEE_SCHEDULER_INVALID'
  | 'FEE_SCHEDULER_TOO_LONG'
  | 'ANTI_SNIPER_MISMATCH'
  | 'DYNAMIC_FEE_NOT_ALLOWED'
  | 'COLLECT_FEE_MODE_NOT_ALLOWED'
  | 'MIGRATION_OPTION_NOT_ALLOWED'
  | 'MIGRATION_FEE_OPTION_INVALID'
  | 'MIGRATION_FEE_INVALID'
  | 'MIGRATED_POOL_FEE_OUT_OF_BOUNDS'
  | 'MIGRATED_POOL_FEE_INVALID'
  | 'MIGRATION_THRESHOLD_MISMATCH'
  | 'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS'
  | 'POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS'
  | 'POOL_CREATION_FEE_MISMATCH'
  | 'CREATOR_TRADING_FEE_OUT_OF_BOUNDS'
  | 'CREATOR_TRADING_FEE_MISMATCH'
  | 'LP_PERCENTAGES_INVALID'
  | 'LIQUIDITY_VESTING_INVALID'
  | 'LOCKED_LIQUIDITY_TOO_LOW'
  | 'CREATOR_LOCKED_LIQUIDITY_REQUIRED'
  | 'TOKEN_UPDATE_AUTHORITY_NOT_IMMUTABLE'
  | 'TOKEN_TYPE_INVALID'
  | 'TOKEN_DECIMAL_INVALID'
  | 'ACTIVATION_TYPE_INVALID'
  | 'FIRST_SWAP_MIN_FEE_REQUIRED'
  | 'SPEC_INVALID'
  | 'SDK_REJECTED';

export interface Violation {
  /** Dotted path of the offending field, e.g. `poolFees.baseFee.cliffFeeNumerator`. */
  field: string;
  code: ViolationCode;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

/** A public key, or its base58 string. */
export type PublicKeyLike = PublicKey | string;

/**
 * What is sent to `createConfig` (minus the `config` keypair and the payer): the SDK's
 * `ConfigParameters` plus the accounts that decide where the money goes. A full
 * `CreateConfigParams` object is accepted as is.
 */
export type ConfigCandidate = ConfigParameters & {
  feeClaimer: PublicKeyLike;
  leftoverReceiver: PublicKeyLike;
  quoteMint: PublicKeyLike;
};

/** Thrown by `assertValid` when a result has violations. */
export class ValidationError extends Error {
  readonly violations: readonly Violation[];

  constructor(label: string, violations: readonly Violation[]) {
    const lines = violations.map((v) => `- ${v.field} [${v.code}]: ${v.message}`);
    super(`${label} failed validation (${violations.length} violation(s)):\n${lines.join('\n')}`);
    this.name = 'ValidationError';
    this.violations = violations;
  }
}

/** Throws a `ValidationError` listing every violation when `result` is not ok. */
export function assertValid(result: ValidationResult, label: string): void {
  if (!result.ok) throw new ValidationError(label, result.violations);
}

class Collector {
  readonly violations: Violation[] = [];

  add(field: string, code: ViolationCode, message: string): void {
    this.violations.push({ field, code, message });
  }

  result(): ValidationResult {
    return { ok: this.violations.length === 0, violations: this.violations };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function toBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
    if (BN.isBN(value)) {
      const text = String(value);
      return /^-?\d+$/.test(text) ? BigInt(text) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function toPublicKey(value: unknown): PublicKey | null {
  try {
    if (value instanceof PublicKey) return value;
    if (typeof value === 'string') {
      const key = new PublicKey(value);
      return key.toBase58() === value ? key : null;
    }
    if (value !== null && typeof value === 'object' && 'toBase58' in value) {
      return new PublicKey(String((value as { toBase58: () => string }).toBase58()));
    }
    return null;
  } catch {
    return null;
  }
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function enumValues(e: Record<string, string | number>): number[] {
  return Object.values(e).filter((v): v is number => typeof v === 'number');
}

/** Runs an SDK check that may either return false or throw; returns the failure reason or null. */
function sdkCheck(check: () => boolean): string | null {
  try {
    return check() ? null : 'rejected by the SDK';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const FEE_NUMERATOR_PER_BPS = BigInt(FEE_DENOMINATOR / MAX_BASIS_POINT);

function bpsToNumerator(bps: number): bigint {
  return BigInt(bpsToFeeNumerator(bps).toString());
}

/** Fee numerator to bps, rounded to the nearest bps (for messages and the bounds check). */
function numeratorToRoundedBps(numerator: bigint): number {
  return Number((numerator + FEE_NUMERATOR_PER_BPS / 2n) / FEE_NUMERATOR_PER_BPS);
}

// ---------------------------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------------------------

/**
 * Checks the on-chain values of a spec (trading fee, creator share, pool creation fee, first
 * buy, owner wallet, quote). `LaunchpadSpec` parsing already enforces most of these; this is a
 * second, independent check right before anything is sent.
 */
export function validateSpecOnchain(spec: LaunchpadSpec): ValidationResult {
  const c = new Collector();
  collectSpecViolations(spec, c, '');
  return c.result();
}

function collectSpecViolations(spec: LaunchpadSpec, c: Collector, prefix: string): void {
  const f = (name: string) => `${prefix}${name}`;
  if (spec === null || typeof spec !== 'object') {
    c.add(f('spec'), 'SPEC_INVALID', 'spec must be an object');
    return;
  }

  if (spec.quote !== 'SOL') c.add(f('quote'), 'QUOTE_NOT_SOL', 'quote must be SOL');

  if (toPublicKey(spec.ownerWallet) === null) {
    c.add(f('ownerWallet'), 'INVALID_ADDRESS', 'ownerWallet must be a valid Solana public key');
  }

  const { tradingFeeBps, coinCreatorSharePct } = CLIENT_BOUNDS;
  if (!isIntInRange(spec.tradingFeeBps, MIN_FEE_BPS, MAX_FEE_BPS)) {
    c.add(
      f('tradingFeeBps'),
      'FEE_OUT_OF_SDK_BOUNDS',
      `tradingFeeBps must be an integer between ${MIN_FEE_BPS} and ${MAX_FEE_BPS} (SDK)`,
    );
  }
  if (!isIntInRange(spec.tradingFeeBps, tradingFeeBps.min, tradingFeeBps.max)) {
    c.add(
      f('tradingFeeBps'),
      'FEE_OUT_OF_CLIENT_BOUNDS',
      `tradingFeeBps must be an integer between ${tradingFeeBps.min} and ${tradingFeeBps.max}`,
    );
  }

  if (!isIntInRange(spec.coinCreatorSharePct, coinCreatorSharePct.min, coinCreatorSharePct.max)) {
    c.add(
      f('coinCreatorSharePct'),
      'CREATOR_TRADING_FEE_OUT_OF_BOUNDS',
      `coinCreatorSharePct must be an integer between ${coinCreatorSharePct.min} and ${coinCreatorSharePct.max}`,
    );
  }

  const feeLamports = specPoolCreationFeeLamports(spec);
  if (feeLamports === null) {
    c.add(
      f('poolCreationFeeSol'),
      'POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS',
      'poolCreationFeeSol must be a non-negative SOL amount with at most 9 decimals',
    );
  } else {
    collectPoolCreationFeeBounds(feeLamports, c, f('poolCreationFeeSol'));
  }

  const firstBuy = spec.launchpadCoin?.firstBuySol;
  let firstBuyOk = typeof firstBuy === 'number' && firstBuy >= 0 && firstBuy <= 100;
  if (firstBuyOk) {
    try {
      solToLamports(firstBuy as number);
    } catch {
      firstBuyOk = false;
    }
  }
  if (!firstBuyOk) {
    c.add(
      f('launchpadCoin.firstBuySol'),
      'SPEC_INVALID',
      'launchpadCoin.firstBuySol must be between 0 and 100 SOL with at most 9 decimals',
    );
  }
}

function specPoolCreationFeeLamports(spec: LaunchpadSpec): bigint | null {
  if (typeof spec.poolCreationFeeSol !== 'number') return null;
  try {
    return solToLamports(spec.poolCreationFeeSol);
  } catch {
    return null;
  }
}

function collectPoolCreationFeeBounds(lamports: bigint, c: Collector, field: string): void {
  const sdkMin = BigInt(MIN_POOL_CREATION_FEE);
  const sdkMax = BigInt(MAX_POOL_CREATION_FEE);
  if (lamports !== 0n && (lamports < sdkMin || lamports > sdkMax)) {
    c.add(
      field,
      'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS',
      `pool creation fee must be 0 or between ${sdkMin} and ${sdkMax} lamports (SDK)`,
    );
  }
  const { min, max, allowZero } = CLIENT_POOL_CREATION_FEE_LAMPORTS;
  const zeroOk = lamports === 0n && allowZero;
  if (!zeroOk && (lamports < min || lamports > max)) {
    c.add(
      field,
      'POOL_CREATION_FEE_OUT_OF_CLIENT_BOUNDS',
      `pool creation fee must be ${allowZero ? '0 or ' : ''}between ${min} and ${max} lamports`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------------------------

interface ExpectedConfig {
  /** Expected `creatorTradingFeePercentage`. */
  creatorTradingFeePercentage: number;
  /** The coin config must give the creator (FORGE) permanently locked liquidity. */
  requireCreatorLockedLiquidity: boolean;
}

/**
 * Validates the launchpad config (the one all of the client's coins use) against its spec:
 * creator share = `spec.coinCreatorSharePct`, trading fee = `spec.tradingFeeBps`, pool creation
 * fee = `spec.poolCreationFeeSol`, fee claimer and leftover receiver = client wallet.
 */
export function validateLaunchpadConfigParams(
  config: ConfigCandidate,
  spec: LaunchpadSpec,
): ValidationResult {
  return validateConfig(config, spec, {
    creatorTradingFeePercentage: spec?.coinCreatorSharePct,
    requireCreatorLockedLiquidity: false,
  });
}

/**
 * Validates the launchpad coin config (e.g. $MOON): same rules as the launchpad config, except
 * the creator share is FORGE's (`FEES.forgeCreatorSharePct`) and part of the post-graduation
 * liquidity must be permanently locked for the creator.
 */
export function validateLaunchpadCoinConfigParams(
  config: ConfigCandidate,
  spec: LaunchpadSpec,
): ValidationResult {
  return validateConfig(config, spec, {
    creatorTradingFeePercentage: FEES.forgeCreatorSharePct,
    requireCreatorLockedLiquidity: true,
  });
}

function validateConfig(
  config: ConfigCandidate,
  spec: LaunchpadSpec,
  expected: ExpectedConfig,
): ValidationResult {
  const c = new Collector();
  collectSpecViolations(spec, c, 'spec.');
  if (config === null || typeof config !== 'object') {
    c.add('config', 'SDK_REJECTED', 'config must be an object');
    return c.result();
  }

  collectAccounts(config, spec, c);
  collectTradingFee(config, spec, c);
  collectModes(config, c);
  collectMigration(config, c);
  collectPoolCreationFee(config, spec, c);
  collectCreatorTradingFee(config, expected, c);
  collectLiquidity(config, expected, c);

  if (config.tokenUpdateAuthority !== TokenAuthorityOption.Immutable) {
    c.add(
      'tokenUpdateAuthority',
      'TOKEN_UPDATE_AUTHORITY_NOT_IMMUTABLE',
      'tokenUpdateAuthority must be TokenAuthorityOption.Immutable (non-modifiable metadata)',
    );
  }
  if (config.enableFirstSwapWithMinFee !== true) {
    c.add(
      'enableFirstSwapWithMinFee',
      'FIRST_SWAP_MIN_FEE_REQUIRED',
      'enableFirstSwapWithMinFee must be true (the first buy must not pay the anti-sniper fee)',
    );
  }

  // Catch-all: the SDK's own validation (curve, sqrt prices, vesting, token supply, ...).
  const sdkError = sdkCheck(() => {
    validateConfigParameters(config);
    return true;
  });
  if (sdkError !== null) {
    c.add('config', 'SDK_REJECTED', `SDK validateConfigParameters: ${sdkError}`);
  }

  return c.result();
}

function collectAccounts(config: ConfigCandidate, spec: LaunchpadSpec, c: Collector): void {
  const quoteMint = toPublicKey(config.quoteMint);
  if (quoteMint === null || !quoteMint.equals(SOL_QUOTE_MINT)) {
    c.add(
      'quoteMint',
      'QUOTE_NOT_SOL',
      `quoteMint must be the SOL mint (${SOL_QUOTE_MINT.toBase58()})`,
    );
  }

  const owner = toPublicKey(spec?.ownerWallet);
  const feeClaimer = toPublicKey(config.feeClaimer);
  if (feeClaimer === null) {
    c.add('feeClaimer', 'INVALID_ADDRESS', 'feeClaimer must be a valid Solana public key');
  } else if (owner === null || !feeClaimer.equals(owner)) {
    c.add(
      'feeClaimer',
      'FEE_CLAIMER_MISMATCH',
      'feeClaimer must be the client wallet (spec.ownerWallet)',
    );
  }
  const leftover = toPublicKey(config.leftoverReceiver);
  if (leftover === null) {
    c.add(
      'leftoverReceiver',
      'INVALID_ADDRESS',
      'leftoverReceiver must be a valid Solana public key',
    );
  } else if (owner === null || !leftover.equals(owner)) {
    c.add(
      'leftoverReceiver',
      'LEFTOVER_RECEIVER_MISMATCH',
      'leftoverReceiver must be the client wallet (spec.ownerWallet)',
    );
  }
}

function collectTradingFee(config: ConfigCandidate, spec: LaunchpadSpec, c: Collector): void {
  const baseFee = config.poolFees?.baseFee;
  const field = 'poolFees.baseFee';
  if (!baseFee) {
    c.add(field, 'FEE_SCHEDULER_INVALID', 'poolFees.baseFee is required');
    return;
  }

  const mode = baseFee.baseFeeMode;
  if (mode !== BaseFeeMode.FeeSchedulerLinear && mode !== BaseFeeMode.FeeSchedulerExponential) {
    c.add(
      `${field}.baseFeeMode`,
      'FEE_MODE_NOT_ALLOWED',
      'baseFeeMode must be FeeSchedulerLinear or FeeSchedulerExponential (RateLimiter is deprecated)',
    );
  }

  const cliff = toBigInt(baseFee.cliffFeeNumerator);
  const numberOfPeriod = baseFee.firstFactor;
  const periodFrequency = toBigInt(baseFee.secondFactor);
  const reductionFactor = toBigInt(baseFee.thirdFactor);
  if (
    cliff === null ||
    periodFrequency === null ||
    reductionFactor === null ||
    !isIntInRange(numberOfPeriod, 0, 0xffff)
  ) {
    c.add(field, 'FEE_SCHEDULER_INVALID', 'base fee numbers are not valid integers');
    return;
  }

  const minNumerator = BigInt(MIN_FEE_NUMERATOR);
  const maxNumerator = BigInt(MAX_FEE_NUMERATOR);
  if (cliff < minNumerator || cliff > maxNumerator) {
    c.add(
      `${field}.cliffFeeNumerator`,
      'FEE_OUT_OF_SDK_BOUNDS',
      `starting fee must be between ${MIN_FEE_BPS} and ${MAX_FEE_BPS} bps (SDK)`,
    );
  }
  // FORGE bound, kept explicit so it does not depend on the SDK's own maximum.
  if (cliff > bpsToNumerator(MAX_ANTI_SNIPER_STARTING_FEE_BPS)) {
    c.add(
      `${field}.cliffFeeNumerator`,
      'FEE_OUT_OF_CLIENT_BOUNDS',
      `starting fee must be at most ${MAX_ANTI_SNIPER_STARTING_FEE_BPS} bps`,
    );
  }

  const schedulerOff = numberOfPeriod === 0 && periodFrequency === 0n && reductionFactor === 0n;
  const schedulerOn = numberOfPeriod > 0 && periodFrequency > 0n && reductionFactor > 0n;
  if (!schedulerOff && !schedulerOn) {
    c.add(
      field,
      'FEE_SCHEDULER_INVALID',
      'fee scheduler periods, frequency and reduction factor must be all zero or all positive',
    );
    return;
  }
  if (mode === BaseFeeMode.FeeSchedulerLinear || mode === BaseFeeMode.FeeSchedulerExponential) {
    const reason = sdkCheck(() =>
      validateFeeScheduler(
        numberOfPeriod,
        new BN(periodFrequency.toString()),
        new BN(reductionFactor.toString()),
        new BN(cliff.toString()),
        mode,
      ),
    );
    if (reason !== null) c.add(field, 'FEE_SCHEDULER_INVALID', `fee scheduler: ${reason}`);
  }

  // The SDK does not cap the scheduler's length: a long one would keep the high starting fee
  // for as long as it runs. Its unit follows activationType (slots or seconds); an unknown
  // activationType is reported elsewhere and gets the stricter seconds cap.
  if (schedulerOn) {
    const slots = config.activationType === ActivationType.Slot;
    const maxDuration = BigInt(
      slots ? MAX_ANTI_SNIPER_DURATION_SLOTS : MAX_ANTI_SNIPER_DURATION_SECONDS,
    );
    if (BigInt(numberOfPeriod) * periodFrequency > maxDuration) {
      c.add(
        field,
        'FEE_SCHEDULER_TOO_LONG',
        `anti-sniper phase (numberOfPeriod * periodFrequency) must be at most ${maxDuration} ${
          slots ? 'slots' : 'seconds'
        } (${MAX_ANTI_SNIPER_DURATION_SECONDS} s)`,
      );
    }
  }

  // Ending fee = fee once the scheduler has run all its periods (= cliff when there is none).
  let ending: bigint | null = cliff;
  if (schedulerOn) {
    try {
      ending = BigInt(
        getFeeSchedulerMinBaseFeeNumerator(
          new BN(cliff.toString()),
          numberOfPeriod,
          new BN(reductionFactor.toString()),
          mode === BaseFeeMode.FeeSchedulerExponential
            ? BaseFeeMode.FeeSchedulerExponential
            : BaseFeeMode.FeeSchedulerLinear,
        ).toString(),
      );
    } catch {
      ending = null;
    }
  }
  if (ending === null || ending < minNumerator || ending > maxNumerator) {
    c.add(
      field,
      'FEE_OUT_OF_SDK_BOUNDS',
      `ending fee must be between ${MIN_FEE_BPS} and ${MAX_FEE_BPS} bps (SDK)`,
    );
    return;
  }

  // The ending fee is what traders pay after the anti-sniper phase: it must be the client's fee.
  // An exponential scheduler cannot always land exactly on it, so it is compared at bps
  // precision (rounded to the nearest bps).
  const endingBps = numeratorToRoundedBps(ending);
  const { min, max } = CLIENT_BOUNDS.tradingFeeBps;
  if (endingBps < min || endingBps > max) {
    c.add(
      field,
      'FEE_OUT_OF_CLIENT_BOUNDS',
      `ending trading fee must be between ${min} and ${max} bps (got ~${endingBps} bps)`,
    );
  }
  if (isIntInRange(spec?.tradingFeeBps, MIN_FEE_BPS, MAX_FEE_BPS)) {
    const target = bpsToNumerator(spec.tradingFeeBps);
    const diff = ending > target ? ending - target : target - ending;
    if (diff * 2n > FEE_NUMERATOR_PER_BPS || (schedulerOff && ending !== target)) {
      c.add(
        field,
        'FEE_MISMATCH',
        `ending trading fee must equal spec.tradingFeeBps (${spec.tradingFeeBps} bps = fee numerator ${target}, got ${ending})`,
      );
    }
  }

  if (spec?.antiSniper === true) {
    if (!schedulerOn || cliff <= ending) {
      c.add(
        field,
        'ANTI_SNIPER_MISMATCH',
        'spec.antiSniper is on: the fee scheduler must start above the trading fee and decrease',
      );
    }
  } else if (spec?.antiSniper === false && !schedulerOff) {
    c.add(
      field,
      'ANTI_SNIPER_MISMATCH',
      'spec.antiSniper is off: the fee scheduler must be disabled',
    );
  }

  if (config.poolFees.dynamicFee !== null && config.poolFees.dynamicFee !== undefined) {
    c.add(
      'poolFees.dynamicFee',
      'DYNAMIC_FEE_NOT_ALLOWED',
      'dynamic fee must be disabled (it would raise the fee above the client bounds)',
    );
  }
}

function collectModes(config: ConfigCandidate, c: Collector): void {
  if (config.collectFeeMode !== CollectFeeMode.QuoteToken) {
    c.add(
      'collectFeeMode',
      'COLLECT_FEE_MODE_NOT_ALLOWED',
      'collectFeeMode must be QuoteToken (fees and the referral are paid in SOL)',
    );
  }
  if (!enumValues(ActivationType).includes(config.activationType)) {
    c.add('activationType', 'ACTIVATION_TYPE_INVALID', 'activationType must be Slot or Timestamp');
  }
  if (!enumValues(TokenType).includes(config.tokenType)) {
    c.add('tokenType', 'TOKEN_TYPE_INVALID', 'tokenType must be SPLToken or Token2022');
  }
  if (!enumValues(TokenDecimal).includes(config.tokenDecimal)) {
    c.add('tokenDecimal', 'TOKEN_DECIMAL_INVALID', 'tokenDecimal must be between 6 and 9');
  }
}

function collectMigration(config: ConfigCandidate, c: Collector): void {
  if (config.migrationOption !== MigrationOption.MET_DAMM_V2) {
    c.add(
      'migrationOption',
      'MIGRATION_OPTION_NOT_ALLOWED',
      'migrationOption must be MET_DAMM_V2 (DAMM v1 is deprecated for new configs)',
    );
  }

  const threshold = toBigInt(config.migrationQuoteThreshold);
  if (threshold !== MIGRATION_THRESHOLD_LAMPORTS) {
    c.add(
      'migrationQuoteThreshold',
      'MIGRATION_THRESHOLD_MISMATCH',
      `migrationQuoteThreshold must be exactly ${MIGRATION_THRESHOLD_LAMPORTS} lamports (${CLIENT_BOUNDS.migrationThresholdSol} SOL)`,
    );
  }

  const optionReason = sdkCheck(() =>
    validateMigrationFeeOption(config.migrationFeeOption, config.migrationOption),
  );
  if (optionReason !== null) {
    c.add(
      'migrationFeeOption',
      'MIGRATION_FEE_OPTION_INVALID',
      `migrationFeeOption: ${optionReason}`,
    );
  }

  const feeReason = config.migrationFee
    ? sdkCheck(() => validateMigrationFee(config.migrationFee))
    : 'migrationFee is required';
  if (feeReason !== null) {
    c.add('migrationFee', 'MIGRATION_FEE_INVALID', `migrationFee: ${feeReason}`);
  }

  const pool = config.migratedPoolFee;
  if (!pool) {
    c.add('migratedPoolFee', 'MIGRATED_POOL_FEE_INVALID', 'migratedPoolFee is required');
    return;
  }
  // With a fixed migration fee option the SDK requires an all-zero migratedPoolFee; with the
  // customizable option the post-graduation fee is set here and must be within the SDK bounds.
  if (config.migrationFeeOption === MigrationFeeOption.Customizable) {
    if (!isIntInRange(pool.poolFeeBps, MIN_MIGRATED_POOL_FEE_BPS, MAX_MIGRATED_POOL_FEE_BPS)) {
      c.add(
        'migratedPoolFee.poolFeeBps',
        'MIGRATED_POOL_FEE_OUT_OF_BOUNDS',
        `migrated pool fee must be between ${MIN_MIGRATED_POOL_FEE_BPS} and ${MAX_MIGRATED_POOL_FEE_BPS} bps`,
      );
    }
  }
  const poolReason = sdkCheck(() =>
    validateMigratedPoolFee(
      pool,
      config.migrationOption,
      config.migrationFeeOption,
      config.migratedPoolMarketCapFeeSchedulerParams,
      config.compoundingFeeBps,
      config.migratedPoolBaseFeeMode,
    ),
  );
  if (poolReason !== null) {
    c.add('migratedPoolFee', 'MIGRATED_POOL_FEE_INVALID', `migratedPoolFee: ${poolReason}`);
  }
}

function collectPoolCreationFee(config: ConfigCandidate, spec: LaunchpadSpec, c: Collector): void {
  const field = 'poolCreationFee';
  const lamports = toBigInt(config.poolCreationFee);
  if (lamports === null || lamports < 0n) {
    c.add(field, 'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS', 'poolCreationFee must be a lamport amount');
    return;
  }
  collectPoolCreationFeeBounds(lamports, c, field);
  const sdkReason = sdkCheck(() => validatePoolCreationFee(new BN(lamports.toString())));
  if (
    sdkReason !== null &&
    !c.violations.some((v) => v.code === 'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS' && v.field === field)
  ) {
    c.add(field, 'POOL_CREATION_FEE_OUT_OF_SDK_BOUNDS', `poolCreationFee: ${sdkReason}`);
  }
  const expected = spec ? specPoolCreationFeeLamports(spec) : null;
  if (expected === null || lamports !== expected) {
    c.add(
      field,
      'POOL_CREATION_FEE_MISMATCH',
      'poolCreationFee must equal spec.poolCreationFeeSol in lamports',
    );
  }
}

function collectCreatorTradingFee(
  config: ConfigCandidate,
  expected: ExpectedConfig,
  c: Collector,
): void {
  const field = 'creatorTradingFeePercentage';
  const value = config.creatorTradingFeePercentage;
  if (!isIntInRange(value, 0, 100)) {
    c.add(
      field,
      'CREATOR_TRADING_FEE_OUT_OF_BOUNDS',
      'creatorTradingFeePercentage must be an integer between 0 and 100',
    );
    return;
  }
  if (value !== expected.creatorTradingFeePercentage) {
    c.add(
      field,
      'CREATOR_TRADING_FEE_MISMATCH',
      `creatorTradingFeePercentage must be ${String(expected.creatorTradingFeePercentage)}`,
    );
  }
}

function collectLiquidity(config: ConfigCandidate, expected: ExpectedConfig, c: Collector): void {
  const percentages = {
    partnerLiquidityPercentage: config.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: config.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: config.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: config.creatorPermanentLockedLiquidityPercentage,
  };
  let canCompute = true;
  for (const [name, value] of Object.entries(percentages)) {
    if (!isIntInRange(value, 0, 100)) {
      canCompute = false;
      c.add(name, 'LP_PERCENTAGES_INVALID', `${name} must be an integer between 0 and 100`);
    }
  }

  const vesting = [
    ['partnerLiquidityVestingInfo', config.partnerLiquidityVestingInfo],
    ['creatorLiquidityVestingInfo', config.creatorLiquidityVestingInfo],
  ] as const;
  for (const [name, info] of vesting) {
    if (info && sdkCheck(() => validateLiquidityVestingInfo(info)) !== null) {
      canCompute = false;
      c.add(name, 'LIQUIDITY_VESTING_INVALID', `${name} is invalid`);
    }
  }
  if (!canCompute) return;

  const partnerVesting = config.partnerLiquidityVestingInfo?.vestingPercentage ?? 0;
  const creatorVesting = config.creatorLiquidityVestingInfo?.vestingPercentage ?? 0;
  const sumOk =
    sdkCheck(() =>
      validateLPPercentages(
        percentages.partnerLiquidityPercentage,
        percentages.partnerPermanentLockedLiquidityPercentage,
        percentages.creatorLiquidityPercentage,
        percentages.creatorPermanentLockedLiquidityPercentage,
        partnerVesting,
        creatorVesting,
      ),
    ) === null;
  if (!sumOk) {
    c.add(
      'liquidity',
      'LP_PERCENTAGES_INVALID',
      'liquidity percentages (including vesting) must sum to 100',
    );
  }

  let lockedBps: number | null;
  try {
    lockedBps = calculateLockedLiquidityBpsAtTime(
      percentages.partnerPermanentLockedLiquidityPercentage,
      percentages.creatorPermanentLockedLiquidityPercentage,
      config.partnerLiquidityVestingInfo,
      config.creatorLiquidityVestingInfo,
      SECONDS_PER_DAY,
    );
  } catch {
    lockedBps = null;
  }
  if (lockedBps === null || !(lockedBps >= MIN_LOCKED_LIQUIDITY_BPS)) {
    c.add(
      'liquidity',
      'LOCKED_LIQUIDITY_TOO_LOW',
      `at least ${MIN_LOCKED_LIQUIDITY_BPS} bps of liquidity must be locked one day after migration (got ${String(lockedBps)})`,
    );
  }

  if (
    expected.requireCreatorLockedLiquidity &&
    percentages.creatorPermanentLockedLiquidityPercentage <= 0
  ) {
    c.add(
      'creatorPermanentLockedLiquidityPercentage',
      'CREATOR_LOCKED_LIQUIDITY_REQUIRED',
      'the coin config must give the creator (FORGE) a permanently locked share of the liquidity',
    );
  }
}
