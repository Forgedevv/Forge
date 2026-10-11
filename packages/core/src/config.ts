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
 * `enableFirstSwapWithMinFee`, pool creation fee `spec.poolCreationFeeSol`, migration to DAMM v2
 * at exactly 10 SOL, immutable token metadata, all post-graduation liquidity permanently locked.
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
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
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
  FEES,
  MAX_ANTI_SNIPER_STARTING_FEE_BPS,
  SOL_DECIMALS,
  SOL_QUOTE_MINT,
  solToLamports,
} from './constants.js';
import { LaunchCoinError, assertSpecLaunchable } from './launch-metadata.js';
import { computeBudgetInstructions } from './tx.js';
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
 * Within the validate.ts bounds (starting fee <= 9900 bps, duration <= 300 s).
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

/** Which of the two configs. */
export type ConfigKind = 'launchpad' | 'launchpadCoin';

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
export function creatorTradingFeePercentageFor(spec: LaunchpadSpec, kind: ConfigKind): number {
  return kind === 'launchpadCoin' ? FEES.forgeCreatorSharePct : spec.coinCreatorSharePct;
}

/** The `buildCurve` input for a spec and a config kind (pure). */
export function curveParamsFor(spec: LaunchpadSpec, kind: ConfigKind): BuildCurveParams {
  const creatorShare = creatorTradingFeePercentageFor(spec, kind);
  const schedule = ANTI_SNIPER_FEE_SCHEDULE;
  return {
    token: { ...FORGE_TOKEN_SETTINGS },
    fee: {
      baseFeeParams: {
        baseFeeMode: schedule.baseFeeMode,
        feeSchedulerParam: spec.antiSniper
          ? {
              startingFeeBps: schedule.startingFeeBps,
              endingFeeBps: spec.tradingFeeBps,
              numberOfPeriod: schedule.numberOfPeriod,
              totalDuration: schedule.totalDurationSeconds,
            }
          : {
              startingFeeBps: spec.tradingFeeBps,
              endingFeeBps: spec.tradingFeeBps,
              numberOfPeriod: 0,
              totalDuration: 0,
            },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorShare,
      poolCreationFee: spec.poolCreationFeeSol,
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

  const transaction = new Transaction({ feePayer: params.payer, blockhash, lastValidBlockHeight });
  transaction.add(
    ...computeBudgetInstructions({
      units: CREATE_CONFIG_COMPUTE_UNITS,
      microLamports: params.computeUnitPriceMicroLamports ?? 0,
    }),
    ...sdkTx.instructions,
  );

  return {
    transaction,
    configAddress,
    params: configParams,
    rentLamports,
    lastValidBlockHeight,
    signers: [params.payer, configAddress],
  };
}
