/**
 * On-chain reads of Meteora DBC pools (docs/METEORA.md, "SDK functions to use").
 *
 * Accounts are fetched through the SDK state fetchers (`StateService`, pinned 1.5.13); everything
 * computed from them (graduation, curve progress, fee metrics) is a pure function of the decoded
 * state, so it is unit-tested with real devnet account data as fixtures.
 *
 * Amounts are `bigint` raw units (lamports for the SOL quote side); progress is in basis points.
 */
import type { Commitment, Connection, PublicKey } from '@solana/web3.js';
import {
  PROTOCOL_POOL_CREATION_FEE_PERCENT,
  StateService,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

/** Commitment used by every read of this module unless overridden. */
export const READ_COMMITMENT: Commitment = 'confirmed';

/** `migrationProgress` values of the DBC program (`MigrationProgress` enum, not exported by the SDK). */
export const DBC_MIGRATION_PROGRESS = {
  /** The bonding curve is still trading. */
  preBondingCurve: 0,
  /** The curve reached the migration threshold: no more swaps on the DBC pool. */
  postBondingCurve: 1,
  lockedVesting: 2,
  /** The DAMM pool has been created. */
  createdPool: 3,
} as const;

/** Basis points of a full curve (100%). */
export const CURVE_PROGRESS_FULL_BPS = 10_000;

/** A DBC pool and its config, as decoded by the SDK. */
export interface DbcPoolState {
  address: PublicKey;
  virtualPool: VirtualPool;
  config: PoolConfig;
}

export type DbcReadErrorCode = 'pool_not_found' | 'config_not_found';

/** Thrown when an account does not exist (or is not a DBC account). */
export class DbcReadError extends Error {
  readonly code: DbcReadErrorCode;

  constructor(code: DbcReadErrorCode, message: string) {
    super(message);
    this.name = 'DbcReadError';
    this.code = code;
  }
}

export interface RetryOptions {
  /** Total attempts, including the first (default 3). */
  attempts?: number;
  /** Delay before the first retry, doubled at each retry (default 500 ms). */
  baseDelayMs?: number;
}

export interface ReadOptions {
  commitment?: Commitment;
  retry?: RetryOptions;
}

const TRANSIENT_ERROR =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|timeout|Too Many Requests|\b429\b|\b502\b|\b503\b|\b504\b/i;

/** True for network/RPC availability errors worth retrying (never for program or decode errors). */
export function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR.test(message);
}

/**
 * Runs an RPC call, retrying transient network errors with exponential backoff. Any other error
 * (and the last transient one) is rethrown unchanged: on-chain errors are never swallowed.
 */
export async function retryRpc<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientRpcError(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function stateService(connection: Connection, commitment: Commitment): StateService {
  return new StateService(connection, commitment);
}

/** Fetches a pool and its config. @throws DbcReadError when either account is missing. */
export async function getDbcPoolState(
  connection: Connection,
  pool: PublicKey,
  options: ReadOptions = {},
): Promise<DbcPoolState> {
  const state = stateService(connection, options.commitment ?? READ_COMMITMENT);
  const virtualPool = await retryRpc(() => state.getPool(pool), options.retry);
  if (!virtualPool) {
    throw new DbcReadError('pool_not_found', `DBC pool not found: ${pool.toBase58()}`);
  }
  const configAddress = virtualPool.poolState.config;
  const config = await retryRpc(() => state.getPoolConfig(configAddress), options.retry);
  if (!config) {
    throw new DbcReadError('config_not_found', `DBC config not found: ${configAddress.toBase58()}`);
  }
  return { address: pool, virtualPool, config };
}

/**
 * Graduation status of a pool:
 * - `trading`: the bonding curve is still open for swaps;
 * - `curve_complete`: the curve reached its migration threshold, the DBC pool no longer swaps,
 *   but the DAMM pool is not created yet (migration pending);
 * - `migrated`: the pool migrated to DAMM; trading goes through Jupiter.
 */
export type GraduationStatus = 'trading' | 'curve_complete' | 'migrated';

export function graduationStatus(
  state: Pick<DbcPoolState, 'virtualPool' | 'config'>,
): GraduationStatus {
  const p = state.virtualPool.poolState;
  if (p.isMigrated !== 0 || p.migrationProgress >= DBC_MIGRATION_PROGRESS.createdPool) {
    return 'migrated';
  }
  if (
    p.migrationProgress >= DBC_MIGRATION_PROGRESS.postBondingCurve ||
    toBigint(p.quoteReserve) >= toBigint(state.config.migrationQuoteThreshold)
  ) {
    return 'curve_complete';
  }
  return 'trading';
}

/**
 * True once the curve is complete (migrated or about to be): swaps built by `@forge/core` must not
 * target a graduated pool (the template uses Jupiter instead).
 */
export function isGraduated(state: Pick<DbcPoolState, 'virtualPool' | 'config'>): boolean {
  return graduationStatus(state) !== 'trading';
}

export interface CurveProgress {
  /**
   * Quote-side progress in basis points, `0..10_000`: `floor(quoteReserve * 10_000 / threshold)`,
   * clamped, and exactly `10_000` once the pool is graduated (after migration the reserve leaves
   * the DBC pool, so the raw ratio would drop). Same measure as the SDK's
   * `getPoolQuoteTokenCurveProgress`, without floating point.
   */
  bps: number;
  /** Quote (SOL) currently in the curve, lamports. */
  quoteReserve: bigint;
  /** Migration threshold of the config, lamports. */
  migrationQuoteThreshold: bigint;
}

export function curveProgress(state: Pick<DbcPoolState, 'virtualPool' | 'config'>): CurveProgress {
  const quoteReserve = toBigint(state.virtualPool.poolState.quoteReserve);
  const migrationQuoteThreshold = toBigint(state.config.migrationQuoteThreshold);
  let bps: number;
  if (isGraduated(state) || migrationQuoteThreshold === 0n) {
    bps = CURVE_PROGRESS_FULL_BPS;
  } else {
    const raw = (quoteReserve * BigInt(CURVE_PROGRESS_FULL_BPS)) / migrationQuoteThreshold;
    bps = Number(raw > BigInt(CURVE_PROGRESS_FULL_BPS) ? BigInt(CURVE_PROGRESS_FULL_BPS) : raw);
  }
  return { bps, quoteReserve, migrationQuoteThreshold };
}

export interface TokenAmounts {
  /** Base token (the coin), raw units. */
  base: bigint;
  /** Quote token (SOL), lamports. */
  quote: bigint;
}

export interface FeeMetrics {
  /** Unclaimed fees, claimable now. */
  claimable: {
    /** Partner share: claimable by the config's `feeClaimer`. */
    partner: TokenAmounts;
    /** Creator share: claimable by the pool creator. */
    creator: TokenAmounts;
  };
  /** Unclaimed Meteora protocol fees (informative, not claimable by FORGE). */
  protocolUnclaimed: TokenAmounts;
  /** Lifetime totals since the pool was created. */
  lifetime: {
    /** Partner + creator trading fees (as in `evtSwap.tradingFee`). */
    trading: TokenAmounts;
    /** Meteora protocol fees (the referral share is paid out at swap time, not counted here). */
    protocol: TokenAmounts;
  };
  /** Creator share of the trading fees, percent (config `creatorTradingFeePercentage`). */
  creatorTradingFeePercentage: number;
}

export function feeMetrics(state: Pick<DbcPoolState, 'virtualPool' | 'config'>): FeeMetrics {
  const p = state.virtualPool.poolState;
  return {
    claimable: {
      partner: { base: toBigint(p.partnerBaseFee), quote: toBigint(p.partnerQuoteFee) },
      creator: { base: toBigint(p.creatorBaseFee), quote: toBigint(p.creatorQuoteFee) },
    },
    protocolUnclaimed: { base: toBigint(p.protocolBaseFee), quote: toBigint(p.protocolQuoteFee) },
    lifetime: {
      trading: {
        base: toBigint(p.metrics.totalTradingBaseFee),
        quote: toBigint(p.metrics.totalTradingQuoteFee),
      },
      protocol: {
        base: toBigint(p.metrics.totalProtocolBaseFee),
        quote: toBigint(p.metrics.totalProtocolQuoteFee),
      },
    },
    creatorTradingFeePercentage: state.config.creatorTradingFeePercentage,
  };
}

/** `creationFeeBits` flag set once the protocol claimed its share of the pool creation fee. */
export const PROTOCOL_POOL_CREATION_FEE_CLAIMED_BIT = 0b01;

/** `creationFeeBits` flag set once the partner claimed its share of the pool creation fee. */
export const PARTNER_POOL_CREATION_FEE_CLAIMED_BIT = 0b10;

/** Pure: partner share of a pool creation fee (the protocol keeps 10%, rounded down). */
export function partnerPoolCreationFeeShare(poolCreationFeeLamports: bigint): bigint {
  const protocol = (poolCreationFeeLamports * BigInt(PROTOCOL_POOL_CREATION_FEE_PERCENT)) / 100n;
  return poolCreationFeeLamports - protocol;
}

/** The pool creation fee a coin paid at launch, and what the partner can still claim of it. */
export interface PoolCreationFeeStatus {
  /** Fee paid when the pool was created (the config's `poolCreationFee`), lamports. */
  totalLamports: bigint;
  /** Partner (client) share: the fee minus the protocol's 10%, rounded down, lamports. */
  partnerShareLamports: bigint;
  /** True once the partner claimed its share for this pool (`creationFeeBits` & 0b10). */
  partnerClaimed: boolean;
  /**
   * Partner share still unclaimed, lamports: `partnerShareLamports`, or 0 once claimed (or when
   * the config charges no creation fee). What `buildPartnerPoolCreationFeeClaimTx` would claim.
   */
  partnerUnclaimedLamports: bigint;
}

/**
 * Pure: pool creation fee status of one pool, from the config's `poolCreationFee` (configs are
 * immutable, so every pool of a config paid it) and the pool's `creationFeeBits`.
 */
export function poolCreationFeeStatus(
  state: Pick<DbcPoolState, 'virtualPool' | 'config'>,
): PoolCreationFeeStatus {
  const totalLamports = toBigint(state.config.poolCreationFee);
  const partnerShareLamports = partnerPoolCreationFeeShare(totalLamports);
  const partnerClaimed =
    (state.virtualPool.poolState.creationFeeBits & PARTNER_POOL_CREATION_FEE_CLAIMED_BIT) !== 0;
  return {
    totalLamports,
    partnerShareLamports,
    partnerClaimed,
    partnerUnclaimedLamports: partnerClaimed ? 0n : partnerShareLamports,
  };
}

/** One coin (pool) launched on a config. */
export interface CoinOfConfig {
  pool: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
  graduation: GraduationStatus;
  progress: CurveProgress;
  fees: FeeMetrics;
  /**
   * Pool creation fee of this coin and the partner share still unclaimed
   * (`poolCreationFee.partnerUnclaimedLamports`): the dashboard can add it to the claimable total
   * without another read.
   */
  poolCreationFee: PoolCreationFeeStatus;
}

/** Pure: summary of one pool of a config. */
export function summarizeCoin(state: DbcPoolState): CoinOfConfig {
  const p = state.virtualPool.poolState;
  return {
    pool: state.address,
    config: p.config,
    baseMint: p.baseMint,
    creator: p.creator,
    graduation: graduationStatus(state),
    progress: curveProgress(state),
    fees: feeMetrics(state),
    poolCreationFee: poolCreationFeeStatus(state),
  };
}

/** Fetches one pool and summarizes it. @throws DbcReadError when the pool or config is missing. */
export async function readCoin(
  connection: Connection,
  pool: PublicKey,
  options: ReadOptions = {},
): Promise<CoinOfConfig> {
  return summarizeCoin(await getDbcPoolState(connection, pool, options));
}

/**
 * Lists the coins (pools) of a config, through the SDK's `getPoolsByConfig` (on-chain plan B when
 * the Jupiter data API is unavailable). Sorted by pool address for a deterministic order.
 * @throws DbcReadError when the config does not exist.
 */
export async function listCoinsOfConfig(
  connection: Connection,
  config: PublicKey,
  options: ReadOptions = {},
): Promise<CoinOfConfig[]> {
  const state = stateService(connection, options.commitment ?? READ_COMMITMENT);
  const configState = await retryRpc(() => state.getPoolConfig(config), options.retry);
  if (!configState) {
    throw new DbcReadError('config_not_found', `DBC config not found: ${config.toBase58()}`);
  }
  const pools = await retryRpc(() => state.getPoolsByConfig(config), options.retry);
  return pools
    .filter((p) => p.account.poolState.config.equals(config))
    .map((p) =>
      summarizeCoin({ address: p.publicKey, virtualPool: p.account, config: configState }),
    )
    .sort((a, b) => compareStrings(a.pool.toBase58(), b.pool.toBase58()));
}

/**
 * Byte offset of `creator` in a DBC pool account (`VirtualPool` and `TransferHookPool`: 8-byte
 * account discriminator, then `PoolState` with `config` at 72, `creator` at 104, `baseMint` at 136).
 * The SDK's `getPoolsByCreator` filters on it; the FORGE RPC relay accepts exactly that query.
 */
export const DBC_POOL_CREATOR_OFFSET = 104;

/** Byte offset of `config` in a DBC pool account (the SDK's `getPoolsByConfig` filter). */
export const DBC_POOL_CONFIG_OFFSET = 72;

/**
 * Lists the coins (pools) created by `creator` on any of `configs`, through the SDK's
 * `getPoolsByCreator` (one `getProgramAccounts` per pool account variant, filtered on the creator
 * at offset 104: the narrow query the FORGE RPC relay allows, unlike a whole-config listing).
 *
 * The decoded data is checked again: a pool is kept only when its `creator` is `creator` and its
 * `config` is one of `configs`, so a pool another launchpad (or a wrong RPC answer) hands back is
 * never shown. Only the configs that have such a pool are read. Sorted by pool address, without
 * duplicates. No RPC call when `configs` is empty.
 * @throws DbcReadError when the config of a matching pool does not exist.
 */
export async function listCoinsOfCreator(
  connection: Connection,
  creator: PublicKey,
  configs: readonly PublicKey[],
  options: ReadOptions = {},
): Promise<CoinOfConfig[]> {
  const wanted = new Set(configs.map((c) => c.toBase58()));
  if (wanted.size === 0) return [];
  const state = stateService(connection, options.commitment ?? READ_COMMITMENT);
  const pools = await retryRpc(() => state.getPoolsByCreator(creator), options.retry);

  const byPool = new Map<string, { address: PublicKey; virtualPool: VirtualPool }>();
  for (const p of pools) {
    const poolState = p.account.poolState;
    if (!poolState.creator.equals(creator)) continue;
    if (!wanted.has(poolState.config.toBase58())) continue;
    byPool.set(p.publicKey.toBase58(), { address: p.publicKey, virtualPool: p.account });
  }
  if (byPool.size === 0) return [];

  const configKeys = new Map<string, PublicKey>();
  for (const { virtualPool } of byPool.values()) {
    configKeys.set(virtualPool.poolState.config.toBase58(), virtualPool.poolState.config);
  }
  const configStates = new Map<string, PoolConfig>();
  for (const [id, address] of configKeys) {
    const configState = await retryRpc(() => state.getPoolConfig(address), options.retry);
    if (!configState) {
      throw new DbcReadError('config_not_found', `DBC config not found: ${id}`);
    }
    configStates.set(id, configState);
  }

  return [...byPool.values()]
    .map(({ address, virtualPool }) =>
      summarizeCoin({
        address,
        virtualPool,
        config: configStates.get(virtualPool.poolState.config.toBase58()) as PoolConfig,
      }),
    )
    .sort((a, b) => compareStrings(a.pool.toBase58(), b.pool.toBase58()));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** BN / number / bigint (anchor decodes u64 as BN) to bigint. */
export function toBigint(value: { toString(): string } | bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}
