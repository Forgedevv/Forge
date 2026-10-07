/**
 * Helpers around @meteora-ag/dynamic-bonding-curve-sdk 1.5.13 (see docs/METEORA.md).
 * All functions here build and send transactions with the throwaway wallets of the tests.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  U64_MAX,
  buildCurve,
  deriveDbcPoolAddress,
  getCurrentPoint,
  type ConfigParameters,
  type PoolConfig,
  type SwapQuoteConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { COMMITMENT, getConnection, sendAndConfirm, sleep } from './solana.js';
import { base58Decode } from './base58.js';
import type { Json, State } from './state.js';

let client: DynamicBondingCurveClient | undefined;

export function getDbc(): DynamicBondingCurveClient {
  if (!client) client = DynamicBondingCurveClient.create(getConnection(), COMMITMENT);
  return client;
}

export const bn = (v: bigint | number | string): BN => new BN(v.toString());
export const big = (v: BN | bigint | number | string): bigint => BigInt(v.toString());

/** Converts an SDK/anchor object (BN, PublicKey, nested) into plain JSON for the state file. */
export function jsonify(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(jsonify);
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonify(v);
    return out;
  }
  return String(value);
}

export interface CurveOptions {
  /** Flat trading fee in bps (or the ending fee when `antiSniper` is set). */
  feeBps: number;
  /** Decreasing fee at launch: starts at `startingFeeBps`, reaches `feeBps` after `totalDurationSeconds`. */
  antiSniper?: { startingFeeBps: number; numberOfPeriod: number; totalDurationSeconds: number };
  creatorTradingFeePercentage: number;
  /** In SOL; 0 to test whether the program accepts "no creation fee". */
  poolCreationFeeSol: number;
  enableFirstSwapWithMinFee: boolean;
  /** In SOL. Production uses 10; the tests use less to keep the devnet budget small. */
  migrationQuoteThresholdSol: number;
  partnerPermanentLockedLiquidityPercentage: number;
  partnerLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
}

export const TOKEN_SUPPLY = 1_000_000_000; // 1B tokens, 6 decimals
export const TOKEN_DECIMALS = TokenDecimal.SIX;

/** Builds the `ConfigParameters` of a SOL-quoted, SPL-token, DAMM v2-migrating config. */
export function buildTestCurve(o: CurveOptions): ConfigParameters {
  const baseFeeParams = o.antiSniper
    ? {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear as const,
        feeSchedulerParam: {
          startingFeeBps: o.antiSniper.startingFeeBps,
          endingFeeBps: o.feeBps,
          numberOfPeriod: o.antiSniper.numberOfPeriod,
          totalDuration: o.antiSniper.totalDurationSeconds,
        },
      }
    : {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear as const,
        feeSchedulerParam: {
          startingFeeBps: o.feeBps,
          endingFeeBps: o.feeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      };
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TOKEN_DECIMALS,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: TOKEN_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams,
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorTradingFeePercentage,
      poolCreationFee: o.poolCreationFeeSol,
      enableFirstSwapWithMinFee: o.enableFirstSwapWithMinFee,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: o.partnerPermanentLockedLiquidityPercentage,
      partnerLiquidityPercentage: o.partnerLiquidityPercentage,
      creatorPermanentLockedLiquidityPercentage: o.creatorPermanentLockedLiquidityPercentage,
      creatorLiquidityPercentage: o.creatorLiquidityPercentage,
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
    migrationQuoteThreshold: o.migrationQuoteThresholdSol,
  });
}

export interface CreateConfigArgs {
  payer: Keypair;
  configKeypair: Keypair;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  params: ConfigParameters;
}

export async function createConfigOnChain(a: CreateConfigArgs): Promise<string> {
  const tx = await getDbc().partner.createConfig({
    config: a.configKeypair.publicKey,
    feeClaimer: a.feeClaimer,
    leftoverReceiver: a.leftoverReceiver,
    quoteMint: NATIVE_MINT,
    payer: a.payer.publicKey,
    ...a.params,
  });
  return sendAndConfirm(tx, a.payer, { signers: [a.configKeypair], label: 'createConfig' });
}

export interface CreatePoolArgs {
  config: PublicKey;
  payer: Keypair;
  poolCreator: Keypair;
  mint: Keypair;
  name: string;
  symbol: string;
  uri: string;
}

export function poolAddress(config: PublicKey, mint: PublicKey): PublicKey {
  return deriveDbcPoolAddress(NATIVE_MINT, mint, config);
}

export async function createPoolOnChain(a: CreatePoolArgs): Promise<{ pool: string; signature: string }> {
  const tx = await getDbc().creator.createPool({
    name: a.name,
    symbol: a.symbol,
    uri: a.uri,
    payer: a.payer.publicKey,
    poolCreator: a.poolCreator.publicKey,
    config: a.config,
    baseMint: a.mint.publicKey,
  });
  const signers = a.poolCreator.publicKey.equals(a.payer.publicKey) ? [a.mint] : [a.mint, a.poolCreator];
  const signature = await sendAndConfirm(tx, a.payer, { signers, label: 'createPool' });
  return { pool: poolAddress(a.config, a.mint.publicKey).toBase58(), signature };
}

export interface PoolSnapshot {
  partnerQuoteFee: string;
  protocolQuoteFee: string;
  creatorQuoteFee: string;
  totalTradingQuoteFee: string;
  totalProtocolQuoteFee: string;
  quoteReserve: string;
  baseReserve: string;
  isMigrated: number;
  migrationProgress: number;
  creator: string;
  [key: string]: Json;
}

export async function getPoolState(pool: PublicKey): Promise<{ virtualPool: VirtualPool; config: PoolConfig }> {
  const dbc = getDbc();
  const virtualPool = await dbc.state.getPool(pool);
  if (!virtualPool) throw new Error(`Pool ${pool.toBase58()} not found`);
  const config = await dbc.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error(`Config ${virtualPool.poolState.config.toBase58()} not found`);
  return { virtualPool, config };
}

export async function snapshotPool(pool: PublicKey): Promise<PoolSnapshot> {
  const { virtualPool } = await getPoolState(pool);
  const p = virtualPool.poolState;
  return {
    partnerQuoteFee: p.partnerQuoteFee.toString(),
    protocolQuoteFee: p.protocolQuoteFee.toString(),
    creatorQuoteFee: p.creatorQuoteFee.toString(),
    totalTradingQuoteFee: p.metrics.totalTradingQuoteFee.toString(),
    totalProtocolQuoteFee: p.metrics.totalProtocolQuoteFee.toString(),
    quoteReserve: p.quoteReserve.toString(),
    baseReserve: p.baseReserve.toString(),
    isMigrated: p.isMigrated,
    migrationProgress: p.migrationProgress,
    creator: p.creator.toBase58(),
  };
}

export interface SwapArgs {
  pool: PublicKey;
  owner: Keypair;
  amountIn: bigint;
  swapBaseForQuote: boolean;
  referralTokenAccount: PublicKey | null;
  slippageBps?: number;
  /** Extra instructions prepended to the swap (test 4: platform fee transfer). */
  preInstructions?: Transaction['instructions'];
}

export interface SwapOutcome {
  signature: string;
  quote: { amountIn: string; outputAmount: string; tradingFee: string; protocolFee: string; referralFee: string };
  txBytes: number;
}

/** Quote + swap through the SDK (same path @forge/core will use), returning the on-chain signature. */
export async function swapOnChain(a: SwapArgs): Promise<SwapOutcome> {
  const dbc = getDbc();
  const { virtualPool, config } = await getPoolState(a.pool);
  const currentPoint = await getCurrentPoint(getConnection(), config.activationType);
  const quote = dbc.pool.swapQuote({
    virtualPool,
    config,
    swapBaseForQuote: a.swapBaseForQuote,
    amountIn: bn(a.amountIn),
    slippageBps: a.slippageBps ?? 100,
    hasReferral: a.referralTokenAccount !== null,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  const tx = await dbc.pool.swap({
    owner: a.owner.publicKey,
    pool: a.pool,
    amountIn: bn(a.amountIn),
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote: a.swapBaseForQuote,
    referralTokenAccount: a.referralTokenAccount,
  });
  if (a.preInstructions?.length) tx.instructions.unshift(...a.preInstructions);
  const signature = await sendAndConfirm(tx, a.owner, { label: a.swapBaseForQuote ? 'sell' : 'buy' });
  return {
    signature,
    quote: {
      amountIn: a.amountIn.toString(),
      outputAmount: quote.outputAmount.toString(),
      tradingFee: quote.tradingFee.toString(),
      protocolFee: quote.protocolFee.toString(),
      referralFee: quote.referralFee.toString(),
    },
    txBytes: tx.serialize({ requireAllSignatures: false }).length,
  };
}

/** Partial-fill buy (swap2): used to fill the curve exactly up to the migration threshold. */
export async function buyPartialFillOnChain(a: Omit<SwapArgs, 'swapBaseForQuote' | 'preInstructions'>): Promise<SwapOutcome> {
  const dbc = getDbc();
  const { virtualPool, config } = await getPoolState(a.pool);
  const currentPoint = await getCurrentPoint(getConnection(), config.activationType);
  const quote = dbc.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote: false,
    hasReferral: a.referralTokenAccount !== null,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: a.slippageBps ?? 100,
    swapMode: SwapMode.PartialFill,
    amountIn: bn(a.amountIn),
  });
  const slippage = BigInt(a.slippageBps ?? 100);
  const minimumAmountOut = (big(quote.outputAmount) * (10_000n - slippage)) / 10_000n;
  const tx = await dbc.pool.swap2({
    owner: a.owner.publicKey,
    pool: a.pool,
    swapBaseForQuote: false,
    referralTokenAccount: a.referralTokenAccount,
    swapMode: SwapMode.PartialFill,
    amountIn: bn(a.amountIn),
    minimumAmountOut: bn(minimumAmountOut),
  });
  const signature = await sendAndConfirm(tx, a.owner, { label: 'buy (partial fill)' });
  return {
    signature,
    quote: {
      amountIn: a.amountIn.toString(),
      outputAmount: quote.outputAmount.toString(),
      tradingFee: quote.tradingFee.toString(),
      protocolFee: quote.protocolFee.toString(),
      referralFee: quote.referralFee.toString(),
    },
    txBytes: tx.serialize({ requireAllSignatures: false }).length,
  };
}

export interface ClaimCreatorArgs {
  pool: PublicKey;
  creator: Keypair;
  receiver: PublicKey;
}

/** `claimCreatorTradingFeeToReceiver`: the creator signs, fees (SOL) land on `receiver`. */
export async function claimCreatorFeeToReceiver(a: ClaimCreatorArgs): Promise<string> {
  const tx = await getDbc().creator.claimCreatorTradingFeeToReceiver({
    creator: a.creator.publicKey,
    payer: a.creator.publicKey,
    pool: a.pool,
    maxBaseAmount: U64_MAX,
    maxQuoteAmount: U64_MAX,
    receiver: a.receiver,
  });
  return sendAndConfirm(tx, a.creator, { label: 'claimCreatorTradingFeeToReceiver' });
}

/** Quote config for a pool that does not exist yet (test 3: first buy inside the creation tx). */
export function quoteConfigFromPoolConfig(config: PoolConfig): SwapQuoteConfig {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: config.poolFees.baseFee.cliffFeeNumerator,
        firstFactor: config.poolFees.baseFee.firstFactor,
        secondFactor: config.poolFees.baseFee.secondFactor,
        thirdFactor: config.poolFees.baseFee.thirdFactor,
        baseFeeMode: config.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: config.poolFees.dynamicFee,
    },
    collectFeeMode: config.collectFeeMode,
    sqrtStartPrice: config.sqrtStartPrice,
    migrationQuoteThreshold: config.migrationQuoteThreshold,
    curve: config.curve,
    migrationSqrtPrice: config.migrationSqrtPrice,
  };
}

/** Anchor `emit_cpi!` instruction tag (sha256("anchor:event")[..8]). */
const EVENT_CPI_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

/**
 * Decodes the DBC program events of a confirmed transaction. The program emits events through a
 * self-CPI (`eventAuthority` account), so they live in the inner instructions, not in the logs.
 */
export async function decodeEvents(signature: string): Promise<Array<{ name: string; data: Json }>> {
  const conn = getConnection();
  let tx = null;
  for (let attempt = 0; attempt < 5 && !tx; attempt++) {
    tx = await conn.getTransaction(signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
    if (!tx) await sleep(1500);
  }
  if (!tx?.meta) return [];
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const coder = getDbc().pool.getProgram().coder;
  const out: Array<{ name: string; data: Json }> = [];
  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const program = keys.get(ix.programIdIndex);
      if (!program || !program.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) continue;
      const data = Buffer.from(base58Decode(ix.data));
      if (data.length <= 8 || !data.subarray(0, 8).equals(EVENT_CPI_TAG)) continue;
      try {
        const ev = coder.events.decode(data.subarray(8).toString('base64'));
        if (ev) out.push({ name: ev.name, data: jsonify(ev.data) });
      } catch {
        // Unknown event layout: ignored.
      }
    }
  }
  return out;
}

/**
 * Fills `step.event` from the chain when a stored step has none (steps saved by an earlier run that
 * could not decode events), and persists the repaired step.
 */
export async function withSwapEvent<T extends { signature: string; event: Record<string, Json> | null }>(
  state: State,
  key: string,
  step: T,
): Promise<T> {
  if (step.event) return step;
  const event = pickSwapEvent(await decodeEvents(step.signature));
  if (!event) return step;
  const repaired = { ...step, event };
  state.set(key, repaired as unknown as Json);
  return repaired;
}

/** The swap event of a transaction, flattened to the fields the reports use. */
export function pickSwapEvent(events: Array<{ name: string; data: Json }>): Record<string, Json> | null {
  const ev = events.find((e) => e.name === 'evtSwap' || e.name === 'evtSwap2');
  if (!ev || typeof ev.data !== 'object' || ev.data === null || Array.isArray(ev.data)) return null;
  const data = ev.data as Record<string, Json>;
  const result = data.swapResult as Record<string, Json> | undefined;
  return {
    name: ev.name,
    hasReferral: data.hasReferral ?? null,
    tradeDirection: data.tradeDirection ?? null,
    amountIn: data.amountIn ?? null,
    ...(result ?? {}),
  };
}
