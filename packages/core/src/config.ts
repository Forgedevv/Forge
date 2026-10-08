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
  type BuildCurveParams,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { LaunchpadSpec } from '@forge/shared';
import {
  CLIENT_BOUNDS,
  FEES,
  MAX_ANTI_SNIPER_STARTING_FEE_BPS,
  SOL_DECIMALS,
  SOL_QUOTE_MINT,
} from './constants.js';
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
  return parsed.data;
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

/**
 * Builds and validates one of the two configs. Pure: same spec, same result.
 *
 * @throws ValidationError when the spec or the resulting parameters break a bound.
 */
export function buildConfigParams(spec: LaunchpadSpec, kind: ConfigKind): LaunchpadConfigParams {
  const parsed = parseLaunchpadSpec(spec);
  const owner = new PublicKey(parsed.ownerWallet);

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
  const configParams = buildConfigParams(params.spec, params.kind);

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
