/**
 * Swap with the FORGE Meteora referral and the platform fee (docs/METEORA.md, tasks/01-ONCHAIN.md).
 *
 * `buildBuyTx` / `buildSellTx` return an UNSIGNED v0 transaction that the user signs in their wallet.
 * One transaction contains, in this order:
 *
 *   1. compute budget: `setComputeUnitLimit`, then `setComputeUnitPrice` (only when a priority fee
 *      is given);
 *   2. token accounts: the user's wrapped SOL ATA is always created (idempotent) and, on a buy, the
 *      user's coin ATA when it does not exist yet;
 *   3. buy only: SOL transfer of `amountInLamports` into the wrapped SOL ATA + `SyncNative` (wrap);
 *   4. the DBC `swap` instruction (exact in), with `referralTokenAccount` = the FORGE Meteora referral
 *      account (`FORGE_METEORA_REFERRAL_ACCOUNT`, read through addresses.ts);
 *   5. `CloseAccount` of the wrapped SOL ATA back to the user (unwrap; any wrapped SOL the user already
 *      held in that ATA is unwrapped too);
 *   6. the platform fee: SOL transfer from the user to `FORGE_PLATFORM_FEE_WALLET`. It comes last so
 *      that, on a sell, it can be paid out of the proceeds.
 *
 * Platform fee (`PLATFORM_FEE_BPS` = `FEES.platformFeeBps` = 30 bps):
 *   - buy: 30 bps of the SOL spent (`amountInLamports`), paid on top of it;
 *   - sell: 30 bps of the QUOTED SOL out (`expectedAmountOut`, net of the pool fees), not of the
 *     minimum. If the price moves within the slippage tolerance, the effective rate on what the
 *     user actually receives is at most `30 bps / (1 - slippage)` ("same tolerance as the slippage").
 *   - rounding: always rounded UP to the next lamport, i.e. in FORGE's favour by strictly less than
 *     1 lamport (`ceil(amount * bps / 10_000)`). It is 0 only when the amount is 0.
 *
 * Refusals (typed `SwapError`, never a silent fallback):
 *   - the pool is migrated or its curve is complete (`POOL_GRADUATED`): the template trades through
 *     Jupiter in that case;
 *   - the platform fee wallet does not exist or is not rent-exempt
 *     (`PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT`): the whole swap would fail on-chain (devnet finding);
 *   - the referral account is not an initialized wrapped SOL token account (`REFERRAL_ACCOUNT_INVALID`);
 *   - the pool is not a plain SOL-quoted DBC pool (`UNSUPPORTED_POOL`; transfer-hook pools excluded);
 *   - the serialized transaction exceeds 1,232 bytes (`TRANSACTION_TOO_LARGE`).
 *
 * Transaction size: measured on devnet (scripts/devnet-tests/reports/core-swap.md) at 819 bytes for a
 * buy and 797 bytes for a sell with this exact layout, far below the 1,232-byte limit (a buy that
 * also creates the coin ATA adds 10 bytes). If a future layout does not fit, the builders throw
 * `TRANSACTION_TOO_LARGE` unless the caller passes `addressLookupTables` (already fetched
 * `AddressLookupTableAccount`s, e.g. one holding the DBC program, the pool authority, the event
 * authority, the token programs, the wrapped SOL mint and the two FORGE fee accounts); the message
 * is then compiled against those tables and checked again.
 *
 * Layering: `fetchSwapContext` does all the network reads (with retries); everything else is pure
 * and unit-tested without network (`buildSwapTransaction`, `computeSwapQuote`, fee math).
 */
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type AccountMeta,
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAccountLen,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  ActivationType,
  BaseFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  TradeDirection,
  createDbcProgram,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
  getFeeMode,
  getTokenProgram,
  isRateLimiterApplied,
  swapQuote,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { requireAddresses, type AddressEnv } from './addresses.js';
import { FEES } from './constants.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Platform fee on swaps built by @forge/core, in bps (`FEES.platformFeeBps` from @forge/shared). */
export const PLATFORM_FEE_BPS: number = FEES.platformFeeBps;

/** Highest slippage tolerance accepted by the builders (50%), whether given in bps or as a minimum. */
export const MAX_SWAP_SLIPPAGE_BPS = 5_000;

/**
 * Default compute unit limit. Measured on devnet: ~51,000 CU for a buy (~66,500 when it also creates
 * the coin ATA), ~49,000 CU for a sell; the default leaves about 2x headroom (fee scheduler,
 * Token-2022).
 */
export const DEFAULT_SWAP_COMPUTE_UNIT_LIMIT = 150_000;

/** Solana's per-transaction compute ceiling. */
export const MAX_SWAP_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Guard against a fat-fingered priority fee: 10 lamports per CU (0.0015 SOL at 150,000 CU). */
export const MAX_SWAP_PRIORITY_FEE_MICRO_LAMPORTS = 10_000_000;

/** Solana's base fee per signature (protocol constant, not rent). The user is the only signer. */
export const SWAP_BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/** Serialized transaction size limit (`PACKET_DATA_SIZE` = 1,232 bytes). */
export const SWAP_MAX_TRANSACTION_BYTES: number = PACKET_DATA_SIZE;

const BPS_DENOMINATOR = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const DEFAULT_COMMITMENT: Commitment = 'confirmed';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const SWAP_ERROR_CODES = [
  'INVALID_PARAMS',
  'POOL_NOT_FOUND',
  'UNSUPPORTED_POOL',
  'POOL_GRADUATED',
  'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
  'REFERRAL_ACCOUNT_INVALID',
  'INSUFFICIENT_LIQUIDITY',
  'QUOTE_FAILED',
  'AMOUNT_TOO_SMALL',
  'MIN_AMOUNT_OUT_ABOVE_QUOTE',
  'SLIPPAGE_TOO_HIGH',
  'INSUFFICIENT_SOL_BALANCE',
  'INSUFFICIENT_TOKEN_BALANCE',
  'TRANSACTION_TOO_LARGE',
  'RPC_ERROR',
] as const;

export type SwapErrorCode = (typeof SWAP_ERROR_CODES)[number];

/** Public data attached to a `SwapError` (addresses, amounts as decimal strings). Never secrets. */
export type SwapErrorDetails = Readonly<Record<string, string | number | boolean>>;

/** Every refusal of the swap builders. `code` is stable and meant for the UI. */
export class SwapError extends Error {
  readonly code: SwapErrorCode;
  readonly details: SwapErrorDetails;

  constructor(
    code: SwapErrorCode,
    message: string,
    options: { details?: SwapErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SwapError';
    this.code = code;
    this.details = options.details ?? {};
  }
}

function invalid(message: string, details?: SwapErrorDetails): SwapError {
  return new SwapError('INVALID_PARAMS', message, details ? { details } : {});
}

// ---------------------------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------------------------

function assertU64(name: string, value: bigint, min = 0n): void {
  if (typeof value !== 'bigint') throw invalid(`${name} must be a bigint`);
  if (value < min || value > U64_MAX) {
    throw invalid(`${name} must be between ${min} and 2^64 - 1`, { [name]: value.toString() });
  }
}

function assertBps(name: string, bps: number, max = 10_000): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) {
    throw invalid(`${name} must be an integer between 0 and ${max}`, { [name]: String(bps) });
  }
}

/**
 * Platform fee in lamports: `ceil(amountLamports * bps / 10_000)`. Rounded up, i.e. in FORGE's
 * favour by strictly less than 1 lamport. Exact for any u64 amount (bigint arithmetic).
 */
export function platformFeeLamports(
  amountLamports: bigint,
  bps: number = PLATFORM_FEE_BPS,
): bigint {
  assertU64('amountLamports', amountLamports);
  assertBps('bps', bps);
  return (amountLamports * BigInt(bps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

/** Minimum output for a slippage tolerance, rounded down (same formula as the SDK's quote). */
export function minAmountOutForSlippage(expectedAmountOut: bigint, slippageBps: number): bigint {
  assertU64('expectedAmountOut', expectedAmountOut);
  assertBps('slippageBps', slippageBps);
  return (expectedAmountOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

/** Estimated network fee: base fee for one signature + `ceil(limit * microLamports / 10^6)`. */
export function estimateSwapNetworkFeeLamports(
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
): bigint {
  const priority =
    (BigInt(computeUnitLimit) * BigInt(priorityFeeMicroLamports) +
      MICRO_LAMPORTS_PER_LAMPORT -
      1n) /
    MICRO_LAMPORTS_PER_LAMPORT;
  return SWAP_BASE_FEE_LAMPORTS_PER_SIGNATURE + priority;
}

export interface SwapSolRequirementInput {
  side: SwapSide;
  /** Lamports into the swap (buy) — ignored on a sell. */
  amountIn: bigint;
  platformFee: bigint;
  /** Lamports the user is guaranteed to receive from the swap (sell) — ignored on a buy. */
  minAmountOut: bigint;
  networkFee: bigint;
  /** Rent of the wrapped SOL ATA if it is created by this transaction (returned at the close). */
  wrappedSolAtaRent: bigint;
  /** Rent of the coin ATA if it is created by this transaction (kept in the new account). */
  coinAtaRent: bigint;
  /** Rent-exempt minimum of a system account: the user's balance must not end below it. */
  systemAccountRent: bigint;
}

/**
 * Lowest SOL balance the user needs for the transaction to succeed, following the instruction
 * order: the peak debit happens before the wrapped SOL ATA is closed, and the final balance must
 * stay rent-exempt. Pre-existing wrapped SOL (refunded at the close) is ignored, so this is exact or
 * slightly conservative, never optimistic.
 */
export function requiredSwapLamports(i: SwapSolRequirementInput): bigint {
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  if (i.side === 'buy') {
    const peak = i.networkFee + i.wrappedSolAtaRent + i.coinAtaRent + i.amountIn;
    const final = i.networkFee + i.coinAtaRent + i.amountIn + i.platformFee + i.systemAccountRent;
    return max(peak, final);
  }
  const peak = i.networkFee + i.wrappedSolAtaRent;
  const final = i.networkFee + i.platformFee + i.systemAccountRent - i.minAmountOut;
  return max(peak, final);
}

// ---------------------------------------------------------------------------------------------
// Pool status and quotes (pure)
// ---------------------------------------------------------------------------------------------

export type SwapSide = 'buy' | 'sell';

/** `tradable`: on the curve. `curve_complete`: threshold reached, awaiting migration. `migrated`: on DAMM. */
export type PoolSwapStatus = 'tradable' | 'curve_complete' | 'migrated';

/** Where a pool stands for our builders. Anything but `tradable` must go through Jupiter. */
export function poolSwapStatus(virtualPool: VirtualPool, config: PoolConfig): PoolSwapStatus {
  const state = virtualPool.poolState;
  if (state.isMigrated !== 0) return 'migrated';
  if (state.migrationProgress !== 0) return 'curve_complete';
  if (state.quoteReserve.gte(config.migrationQuoteThreshold)) return 'curve_complete';
  return 'tradable';
}

/** Decoded on-chain state needed to quote a swap. */
export interface SwapPoolState {
  pool: PublicKey;
  virtualPool: VirtualPool;
  config: PoolConfig;
  /** Current slot or unix timestamp, depending on `config.activationType`. */
  currentPoint: BN;
}

/** Throws unless the pool is a SOL-quoted DBC pool still on its curve. */
export function assertPoolTradable(state: SwapPoolState): void {
  const { config, virtualPool, pool } = state;
  if (!config.quoteMint.equals(NATIVE_MINT) || config.quoteTokenFlag !== 0) {
    throw new SwapError('UNSUPPORTED_POOL', 'The pool is not quoted in SOL', {
      details: { pool: pool.toBase58(), quoteMint: config.quoteMint.toBase58() },
    });
  }
  const status = poolSwapStatus(virtualPool, config);
  if (status !== 'tradable') {
    throw new SwapError(
      'POOL_GRADUATED',
      `The pool has graduated (${status}): trade it through Jupiter, not through @forge/core`,
      { details: { pool: pool.toBase58(), status } },
    );
  }
}

/** Slippage protection: a tolerance in bps, or an explicit minimum output. Exactly one. */
export type SlippageInput =
  | { slippageBps: number; minAmountOut?: undefined }
  | { minAmountOut: bigint; slippageBps?: undefined };

export interface SwapFeeBreakdown {
  /** Token the pool fees below are charged in (always the quote, SOL, for FORGE configs). */
  poolFeeToken: 'quote' | 'base';
  /** Partner + creator share of the pool fee (`tradingFee` of the SDK quote and of `evtSwap`). */
  tradingFee: bigint;
  /** Meteora protocol share, after the referral cut. */
  protocolFee: bigint;
  /** FORGE Meteora referral share (20% of the protocol share), paid to the referral account. */
  referralFee: bigint;
  /** `tradingFee + protocolFee + referralFee`. */
  totalPoolFee: bigint;
  /** FORGE platform fee in lamports (separate SOL transfer). */
  platformFee: bigint;
  platformFeeBps: number;
}

export interface SwapQuote {
  side: SwapSide;
  pool: PublicKey;
  baseMint: PublicKey;
  /** Into the DBC swap: lamports on a buy, raw coin units on a sell. */
  amountIn: bigint;
  /** From the SDK quote: raw coin units on a buy, lamports on a sell (net of the pool fees). */
  expectedAmountOut: bigint;
  /** Minimum accepted by the swap instruction (slippage protection). */
  minAmountOut: bigint;
  /** The tolerance used, or `null` when an explicit `minAmountOut` was given. */
  slippageBps: number | null;
  fees: SwapFeeBreakdown;
  /**
   * Change of the user's SOL balance from the swap and the platform fee, excluding the network fee
   * and the rent of a new coin account: negative on a buy (`-(amountIn + platformFee)`).
   */
  expectedSolDelta: bigint;
  /** Same, with the swap returning only `minAmountOut` (equal to `expectedSolDelta` on a buy). */
  worstCaseSolDelta: bigint;
  /** Point (slot or unix time) the quote was computed at. */
  currentPoint: bigint;
}

export interface SwapQuoteRequest {
  side: SwapSide;
  amountIn: bigint;
  slippage: SlippageInput;
}

function readSlippage(slippage: SlippageInput | undefined): SlippageInput {
  if (!slippage || typeof slippage !== 'object') {
    throw invalid('Give either slippageBps or minAmountOut');
  }
  const hasBps = slippage.slippageBps !== undefined;
  const hasMin = slippage.minAmountOut !== undefined;
  if (hasBps === hasMin) throw invalid('Give exactly one of slippageBps or minAmountOut');
  if (hasBps) {
    assertBps('slippageBps', slippage.slippageBps as number, MAX_SWAP_SLIPPAGE_BPS);
    return { slippageBps: slippage.slippageBps as number };
  }
  assertU64('minAmountOut', slippage.minAmountOut as bigint, 1n);
  return { minAmountOut: slippage.minAmountOut as bigint };
}

const toBigInt = (value: BN): bigint => BigInt(value.toString());

/**
 * Quotes a swap with the SDK quote function (`swapQuote`, exact in, with referral) and adds the
 * platform fee. Pure: the caller provides the decoded pool state and the current point.
 */
export function computeSwapQuote(state: SwapPoolState, request: SwapQuoteRequest): SwapQuote {
  if (request.side !== 'buy' && request.side !== 'sell') throw invalid('side must be buy or sell');
  assertU64('amountIn', request.amountIn, 1n);
  const slippage = readSlippage(request.slippage);
  assertPoolTradable(state);

  const swapBaseForQuote = request.side === 'sell';
  let result;
  try {
    result = swapQuote(
      state.virtualPool,
      state.config,
      swapBaseForQuote,
      new BN(request.amountIn.toString()),
      0,
      true, // with the FORGE referral
      state.currentPoint,
      false, // never the pool's first swap: that one is built by pool.ts
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = { pool: state.pool.toBase58(), side: request.side };
    if (/completed/i.test(message)) {
      throw new SwapError('POOL_GRADUATED', 'The pool curve is complete', {
        details: { ...details, status: 'curve_complete' },
        cause: error,
      });
    }
    if (/liquidity/i.test(message)) {
      throw new SwapError(
        'INSUFFICIENT_LIQUIDITY',
        'The amount exceeds what is left on the curve before graduation',
        { details, cause: error },
      );
    }
    throw new SwapError('QUOTE_FAILED', `The SDK quote failed: ${message}`, {
      details,
      cause: error,
    });
  }

  const expectedAmountOut = toBigInt(result.outputAmount);
  if (expectedAmountOut <= 0n) {
    throw new SwapError('AMOUNT_TOO_SMALL', 'The swap would return nothing', {
      details: { amountIn: request.amountIn.toString() },
    });
  }
  const floor = minAmountOutForSlippage(expectedAmountOut, MAX_SWAP_SLIPPAGE_BPS);
  let minAmountOut: bigint;
  if (slippage.slippageBps !== undefined) {
    minAmountOut = minAmountOutForSlippage(expectedAmountOut, slippage.slippageBps);
  } else {
    minAmountOut = slippage.minAmountOut as bigint;
    if (minAmountOut > expectedAmountOut) {
      throw new SwapError('MIN_AMOUNT_OUT_ABOVE_QUOTE', 'minAmountOut is above the quoted output', {
        details: {
          minAmountOut: minAmountOut.toString(),
          expectedAmountOut: expectedAmountOut.toString(),
        },
      });
    }
    if (minAmountOut < floor) {
      throw new SwapError(
        'SLIPPAGE_TOO_HIGH',
        `minAmountOut implies more than ${MAX_SWAP_SLIPPAGE_BPS} bps of slippage`,
        { details: { minAmountOut: minAmountOut.toString(), lowestAllowed: floor.toString() } },
      );
    }
  }
  if (minAmountOut <= 0n) {
    throw new SwapError('AMOUNT_TOO_SMALL', 'The minimum output rounds down to zero', {
      details: { expectedAmountOut: expectedAmountOut.toString() },
    });
  }

  const solBase = swapBaseForQuote ? expectedAmountOut : request.amountIn;
  const platformFee = platformFeeLamports(solBase, PLATFORM_FEE_BPS);
  let expectedSolDelta: bigint;
  let worstCaseSolDelta: bigint;
  if (swapBaseForQuote) {
    expectedSolDelta = expectedAmountOut - platformFee;
    worstCaseSolDelta = minAmountOut - platformFee;
    if (worstCaseSolDelta <= 0n) {
      throw new SwapError('AMOUNT_TOO_SMALL', 'The sale would not cover the platform fee', {
        details: { minAmountOut: minAmountOut.toString(), platformFee: platformFee.toString() },
      });
    }
  } else {
    expectedSolDelta = -(request.amountIn + platformFee);
    worstCaseSolDelta = expectedSolDelta;
  }

  const tradeDirection = swapBaseForQuote ? TradeDirection.BaseToQuote : TradeDirection.QuoteToBase;
  const feeMode = getFeeMode(state.config.collectFeeMode, tradeDirection, true);
  const tradingFee = toBigInt(result.tradingFee);
  const protocolFee = toBigInt(result.protocolFee);
  const referralFee = toBigInt(result.referralFee);
  return {
    side: request.side,
    pool: state.pool,
    baseMint: state.virtualPool.poolState.baseMint,
    amountIn: request.amountIn,
    expectedAmountOut,
    minAmountOut,
    slippageBps: slippage.slippageBps ?? null,
    fees: {
      poolFeeToken: feeMode.feesOnBaseToken ? 'base' : 'quote',
      tradingFee,
      protocolFee,
      referralFee,
      totalPoolFee: tradingFee + protocolFee + referralFee,
      platformFee,
      platformFeeBps: PLATFORM_FEE_BPS,
    },
    expectedSolDelta,
    worstCaseSolDelta,
    currentPoint: toBigInt(state.currentPoint),
  };
}

// ---------------------------------------------------------------------------------------------
// Instructions (pure)
// ---------------------------------------------------------------------------------------------

const SWAP_IDL_INSTRUCTION = DynamicBondingCurveIdl.instructions.find((ix) => ix.name === 'swap');
if (!SWAP_IDL_INSTRUCTION) throw new Error('DBC IDL has no swap instruction');
/** Anchor discriminator of the DBC `swap` instruction, read from the SDK IDL (not retyped). */
const SWAP_DISCRIMINATOR = Buffer.from(SWAP_IDL_INSTRUCTION.discriminator);

export interface DbcSwapInstructionAccounts {
  config: PublicKey;
  pool: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  payer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  referralTokenAccount: PublicKey;
}

/**
 * DBC `swap` instruction (exact in), encoded from the SDK IDL: same accounts, in the same order, as
 * the SDK's `PoolService.swap`, plus the instructions sysvar as remaining account when the pool needs
 * it (rate limiter active or `enableFirstSwapWithMinFee`). Unit tests compare it with the SDK's
 * Anchor encoding.
 */
export function buildDbcSwapInstruction(
  accounts: DbcSwapInstructionAccounts,
  amountIn: bigint,
  minimumAmountOut: bigint,
  includeInstructionsSysvar: boolean,
): TransactionInstruction {
  assertU64('amountIn', amountIn, 1n);
  assertU64('minimumAmountOut', minimumAmountOut);
  const data = Buffer.alloc(SWAP_DISCRIMINATOR.length + 16);
  SWAP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountIn, SWAP_DISCRIMINATOR.length);
  data.writeBigUInt64LE(minimumAmountOut, SWAP_DISCRIMINATOR.length + 8);
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const keys: AccountMeta[] = [
    ro(deriveDbcPoolAuthority()),
    ro(accounts.config),
    rw(accounts.pool),
    rw(accounts.inputTokenAccount),
    rw(accounts.outputTokenAccount),
    rw(accounts.baseVault),
    rw(accounts.quoteVault),
    ro(accounts.baseMint),
    ro(accounts.quoteMint),
    { pubkey: accounts.payer, isSigner: true, isWritable: false },
    ro(accounts.tokenBaseProgram),
    ro(accounts.tokenQuoteProgram),
    rw(accounts.referralTokenAccount),
    ro(deriveDbcEventAuthority()),
    ro(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
  ];
  if (includeInstructionsSysvar) keys.push(ro(SYSVAR_INSTRUCTIONS_PUBKEY));
  return new TransactionInstruction({ programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID, keys, data });
}

/** Same rule as the SDK's `swap`: the program reads the instructions sysvar in these cases. */
export function needsInstructionsSysvar(state: SwapPoolState, side: SwapSide): boolean {
  const { config, virtualPool, currentPoint } = state;
  if (config.enableFirstSwapWithMinFee) return true;
  const baseFee = config.poolFees.baseFee;
  if (baseFee.baseFeeMode !== BaseFeeMode.RateLimiter) return false;
  return isRateLimiterApplied(
    currentPoint,
    virtualPool.poolState.activationPoint,
    side === 'sell' ? TradeDirection.BaseToQuote : TradeDirection.QuoteToBase,
    baseFee.secondFactor,
    baseFee.thirdFactor,
    new BN(baseFee.firstFactor),
  );
}

/** Token program of the pool's coin (SPL Token or Token-2022). */
export function coinTokenProgram(virtualPool: VirtualPool): PublicKey {
  return getTokenProgram(virtualPool.poolState.poolType);
}

/** Size of the user's coin ATA: 165 bytes (SPL Token) or 170 bytes (Token-2022, immutable owner). */
function coinAtaSize(tokenProgram: PublicKey): number {
  return tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? getAccountLen([ExtensionType.ImmutableOwner])
    : ACCOUNT_SIZE;
}

// ---------------------------------------------------------------------------------------------
// Context (network reads) and pure transaction building
// ---------------------------------------------------------------------------------------------

/** On-chain account snapshot (lamports as bigint). */
export interface SwapAccountSnapshot {
  lamports: bigint;
  owner: PublicKey;
  data: Buffer;
}

/** Everything the pure builder needs, read by `fetchSwapContext`. */
export interface SwapContext extends SwapPoolState {
  configAddress: PublicKey;
  user: PublicKey;
  /** 0 when the user account does not exist. */
  userLamports: bigint;
  userCoinAta: PublicKey;
  userCoinAtaAccount: SwapAccountSnapshot | null;
  userWrappedSolAta: PublicKey;
  userWrappedSolAtaAccount: SwapAccountSnapshot | null;
  platformFeeWallet: PublicKey;
  platformFeeWalletAccount: SwapAccountSnapshot | null;
  /** Rent-exempt minimum for the platform fee wallet's data size, read from the cluster. */
  platformFeeWalletRentExemptMinimum: bigint;
  referralTokenAccount: PublicKey;
  referralTokenAccountInfo: SwapAccountSnapshot | null;
  /** Rent-exempt minimum of a 0-byte system account, read from the cluster. */
  systemAccountRent: bigint;
  /** Rent of a wrapped SOL token account (165 bytes), read from the cluster. */
  wrappedSolAtaRent: bigint;
  /** Rent of the user's coin ATA (165 or 170 bytes), read from the cluster. */
  coinAtaRent: bigint;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

/** Throws unless the platform fee wallet exists and holds at least its rent-exempt minimum. */
export function assertPlatformFeeWalletReady(
  wallet: PublicKey,
  account: SwapAccountSnapshot | null,
  rentExemptMinimum: bigint,
): void {
  const lamports = account?.lamports ?? 0n;
  if (!account || lamports < rentExemptMinimum) {
    throw new SwapError(
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
      'FORGE_PLATFORM_FEE_WALLET must exist and be rent-exempt, otherwise every swap fails on-chain',
      {
        details: {
          platformFeeWallet: wallet.toBase58(),
          lamports: lamports.toString(),
          rentExemptMinimum: rentExemptMinimum.toString(),
        },
      },
    );
  }
}

/** Throws unless the referral account is an initialized wrapped SOL token account (SPL Token). */
export function assertReferralAccountReady(
  address: PublicKey,
  account: SwapAccountSnapshot | null,
): void {
  const fail = (reason: string, cause?: unknown) =>
    new SwapError('REFERRAL_ACCOUNT_INVALID', `FORGE_METEORA_REFERRAL_ACCOUNT ${reason}`, {
      details: { referralTokenAccount: address.toBase58() },
      cause,
    });
  if (!account) throw fail('does not exist');
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) throw fail('is not an SPL token account');
  let token;
  try {
    token = unpackAccount(
      address,
      { data: account.data, executable: false, lamports: 0, owner: account.owner },
      TOKEN_PROGRAM_ID,
    );
  } catch (error) {
    throw fail('is not a valid token account', error);
  }
  if (!token.mint.equals(NATIVE_MINT)) throw fail('is not a wrapped SOL account');
  if (!token.isInitialized || token.isFrozen) throw fail('is not usable (uninitialized or frozen)');
}

function tokenBalance(
  address: PublicKey,
  account: SwapAccountSnapshot | null,
  tokenProgram: PublicKey,
): bigint {
  if (!account || !account.owner.equals(tokenProgram)) return 0n;
  try {
    const token = unpackAccount(
      address,
      { data: account.data, executable: false, lamports: 0, owner: account.owner },
      tokenProgram,
    );
    return token.isFrozen ? 0n : token.amount;
  } catch {
    // Not a token account: treated as holding nothing (the sell is then refused).
    return 0n;
  }
}

export interface SwapBuildOptions {
  /** Compute unit limit (default `DEFAULT_SWAP_COMPUTE_UNIT_LIMIT`). */
  computeUnitLimit?: number;
  /** Priority fee in micro-lamports per CU (default 0: no `setComputeUnitPrice` instruction). */
  priorityFeeMicroLamports?: number;
  /**
   * Address lookup tables to compile the v0 message with, if the transaction would exceed 1,232
   * bytes without them (it does not with the current layout). Fetch them with
   * `connection.getAddressLookupTable(address)`.
   */
  addressLookupTables?: AddressLookupTableAccount[];
}

export interface SwapBuildRequest extends SwapQuoteRequest, SwapBuildOptions {}

/** Result of `buildBuyTx` / `buildSellTx`. */
export interface BuiltSwapTransaction {
  /** Unsigned v0 transaction; the user (fee payer) is the only signer. */
  transaction: VersionedTransaction;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  quote: SwapQuote;
  sizeBytes: number;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  /** Base fee + priority fee, in lamports. */
  estimatedNetworkFeeLamports: bigint;
  /** Rent locked in a coin ATA created by a buy (0 when it already existed or on a sell). */
  newCoinAccountRentLamports: bigint;
  /** Lowest SOL balance the user needs (see `requiredSwapLamports`). */
  requiredLamports: bigint;
  platformFeeWallet: PublicKey;
  referralTokenAccount: PublicKey;
}

function readBuildOptions(o: SwapBuildOptions): Required<SwapBuildOptions> {
  const computeUnitLimit = o.computeUnitLimit ?? DEFAULT_SWAP_COMPUTE_UNIT_LIMIT;
  const priorityFeeMicroLamports = o.priorityFeeMicroLamports ?? 0;
  if (
    !Number.isInteger(computeUnitLimit) ||
    computeUnitLimit < 1 ||
    computeUnitLimit > MAX_SWAP_COMPUTE_UNIT_LIMIT
  ) {
    throw invalid(
      `computeUnitLimit must be an integer between 1 and ${MAX_SWAP_COMPUTE_UNIT_LIMIT}`,
    );
  }
  if (
    !Number.isInteger(priorityFeeMicroLamports) ||
    priorityFeeMicroLamports < 0 ||
    priorityFeeMicroLamports > MAX_SWAP_PRIORITY_FEE_MICRO_LAMPORTS
  ) {
    throw invalid(
      `priorityFeeMicroLamports must be an integer between 0 and ${MAX_SWAP_PRIORITY_FEE_MICRO_LAMPORTS}`,
    );
  }
  const addressLookupTables = o.addressLookupTables ?? [];
  if (!Array.isArray(addressLookupTables)) throw invalid('addressLookupTables must be an array');
  return { computeUnitLimit, priorityFeeMicroLamports, addressLookupTables };
}

/**
 * Compiles the instructions into an unsigned v0 transaction paid by `payer` and checks its
 * serialized size (signature placeholders included) against 1,232 bytes.
 */
export function compileSwapTransaction(args: {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
  addressLookupTables?: AddressLookupTableAccount[];
}): { transaction: VersionedTransaction; sizeBytes: number } {
  const tables = args.addressLookupTables ?? [];
  const tooLarge = (sizeBytes: number | null, cause?: unknown) =>
    new SwapError(
      'TRANSACTION_TOO_LARGE',
      tables.length > 0
        ? 'The swap transaction exceeds 1,232 bytes even with the given address lookup tables'
        : 'The swap transaction exceeds 1,232 bytes: pass addressLookupTables',
      {
        details: {
          sizeBytes: sizeBytes === null ? 'over limit' : sizeBytes,
          limit: SWAP_MAX_TRANSACTION_BYTES,
          lookupTables: tables.length,
        },
        cause,
      },
    );
  let transaction: VersionedTransaction;
  let sizeBytes: number;
  try {
    const message = new TransactionMessage({
      payerKey: args.payer,
      recentBlockhash: args.recentBlockhash,
      instructions: args.instructions,
    }).compileToV0Message(tables);
    transaction = new VersionedTransaction(message);
    sizeBytes = transaction.serialize().length;
  } catch (error) {
    // web3.js throws while encoding a message larger than the packet size.
    if (error instanceof RangeError || /overrun|too large|out of range/i.test(String(error))) {
      throw tooLarge(null, error);
    }
    throw error;
  }
  if (sizeBytes > SWAP_MAX_TRANSACTION_BYTES) throw tooLarge(sizeBytes);
  return { transaction, sizeBytes };
}

/**
 * Pure transaction builder: validates the context (pool on its curve, fee accounts ready, balances),
 * quotes, and assembles the instructions in the order documented at the top of this file.
 */
export function buildSwapTransaction(
  ctx: SwapContext,
  request: SwapBuildRequest,
): BuiltSwapTransaction {
  const options = readBuildOptions(request);
  assertPlatformFeeWalletReady(
    ctx.platformFeeWallet,
    ctx.platformFeeWalletAccount,
    ctx.platformFeeWalletRentExemptMinimum,
  );
  assertReferralAccountReady(ctx.referralTokenAccount, ctx.referralTokenAccountInfo);
  const quote = computeSwapQuote(ctx, request);
  const side = request.side;

  const coinProgram = coinTokenProgram(ctx.virtualPool);
  const expectedCoinAta = getAssociatedTokenAddressSync(
    ctx.virtualPool.poolState.baseMint,
    ctx.user,
    true,
    coinProgram,
  );
  const expectedWrappedSolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    ctx.user,
    true,
    TOKEN_PROGRAM_ID,
  );
  if (
    !ctx.userCoinAta.equals(expectedCoinAta) ||
    !ctx.userWrappedSolAta.equals(expectedWrappedSolAta)
  ) {
    throw invalid('The context token accounts are not the user ATAs');
  }

  const createCoinAta = side === 'buy' && ctx.userCoinAtaAccount === null;
  const createWrappedSolAta = ctx.userWrappedSolAtaAccount === null;
  if (side === 'sell') {
    const held = tokenBalance(ctx.userCoinAta, ctx.userCoinAtaAccount, coinProgram);
    if (held < request.amountIn) {
      throw new SwapError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'The wallet holds fewer coins than the sale',
        {
          details: { held: held.toString(), amountIn: request.amountIn.toString() },
        },
      );
    }
  }

  const estimatedNetworkFeeLamports = estimateSwapNetworkFeeLamports(
    options.computeUnitLimit,
    options.priorityFeeMicroLamports,
  );
  const newCoinAccountRentLamports = createCoinAta ? ctx.coinAtaRent : 0n;
  const requiredLamports = requiredSwapLamports({
    side,
    amountIn: request.amountIn,
    platformFee: quote.fees.platformFee,
    minAmountOut: quote.minAmountOut,
    networkFee: estimatedNetworkFeeLamports,
    wrappedSolAtaRent: createWrappedSolAta ? ctx.wrappedSolAtaRent : 0n,
    coinAtaRent: newCoinAccountRentLamports,
    systemAccountRent: ctx.systemAccountRent,
  });
  if (ctx.userLamports < requiredLamports) {
    throw new SwapError('INSUFFICIENT_SOL_BALANCE', 'The wallet does not hold enough SOL', {
      details: {
        balance: ctx.userLamports.toString(),
        required: requiredLamports.toString(),
      },
    });
  }

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }),
  ];
  if (options.priorityFeeMicroLamports > 0) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.priorityFeeMicroLamports }),
    );
  }
  // The wrapped SOL ATA only lives for this transaction: always (idempotently) created, then closed.
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      ctx.user,
      ctx.userWrappedSolAta,
      ctx.user,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );
  if (createCoinAta) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.user,
        ctx.userCoinAta,
        ctx.user,
        ctx.virtualPool.poolState.baseMint,
        coinProgram,
      ),
    );
  }
  if (side === 'buy') {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: ctx.user,
        toPubkey: ctx.userWrappedSolAta,
        lamports: request.amountIn,
      }),
      createSyncNativeInstruction(ctx.userWrappedSolAta, TOKEN_PROGRAM_ID),
    );
  }
  const poolState = ctx.virtualPool.poolState;
  instructions.push(
    buildDbcSwapInstruction(
      {
        config: poolState.config,
        pool: ctx.pool,
        inputTokenAccount: side === 'buy' ? ctx.userWrappedSolAta : ctx.userCoinAta,
        outputTokenAccount: side === 'buy' ? ctx.userCoinAta : ctx.userWrappedSolAta,
        baseVault: poolState.baseVault,
        quoteVault: poolState.quoteVault,
        baseMint: poolState.baseMint,
        quoteMint: ctx.config.quoteMint,
        payer: ctx.user,
        tokenBaseProgram: coinProgram,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: ctx.referralTokenAccount,
      },
      request.amountIn,
      quote.minAmountOut,
      needsInstructionsSysvar(ctx, side),
    ),
    createCloseAccountInstruction(ctx.userWrappedSolAta, ctx.user, ctx.user, [], TOKEN_PROGRAM_ID),
  );
  if (quote.fees.platformFee > 0n) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: ctx.user,
        toPubkey: ctx.platformFeeWallet,
        lamports: quote.fees.platformFee,
      }),
    );
  }

  const { transaction, sizeBytes } = compileSwapTransaction({
    payer: ctx.user,
    instructions,
    recentBlockhash: ctx.recentBlockhash,
    addressLookupTables: options.addressLookupTables,
  });
  return {
    transaction,
    recentBlockhash: ctx.recentBlockhash,
    lastValidBlockHeight: ctx.lastValidBlockHeight,
    quote,
    sizeBytes,
    computeUnitLimit: options.computeUnitLimit,
    priorityFeeMicroLamports: options.priorityFeeMicroLamports,
    estimatedNetworkFeeLamports,
    newCoinAccountRentLamports,
    requiredLamports,
    platformFeeWallet: ctx.platformFeeWallet,
    referralTokenAccount: ctx.referralTokenAccount,
  };
}

// ---------------------------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------------------------

const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 400;
const TRANSIENT_RPC_ERROR =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timed? ?out|Too Many Requests|\b429\b|\b502\b|\b503\b|\b504\b/i;

/** Runs an RPC call, retrying transient network errors with exponential backoff. */
async function rpc<T>(label: string, call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const transient = TRANSIENT_RPC_ERROR.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!transient || attempt === RPC_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RPC_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
  throw new SwapError('RPC_ERROR', `RPC call failed: ${label}`, { cause: lastError });
}

type DbcProgram = ReturnType<typeof createDbcProgram>['program'];
const programs = new WeakMap<Connection, DbcProgram>();

function dbcProgram(connection: Connection): DbcProgram {
  let program = programs.get(connection);
  if (!program) {
    program = createDbcProgram(connection).program;
    programs.set(connection, program);
  }
  return program;
}

function snapshot(info: AccountInfo<Buffer> | null | undefined): SwapAccountSnapshot | null {
  if (!info) return null;
  return { lamports: BigInt(info.lamports), owner: info.owner, data: Buffer.from(info.data) };
}

function toPublicKey(name: string, value: PublicKey | string): PublicKey {
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(value);
  } catch (error) {
    throw new SwapError('INVALID_PARAMS', `${name} is not a valid public key`, { cause: error });
  }
}

/** Decodes a DBC account, refusing other owners and other account types (e.g. transfer-hook pools). */
function decodeDbcAccount<T>(
  program: DbcProgram,
  kind: 'virtualPool' | 'poolConfig',
  address: PublicKey,
  account: SwapAccountSnapshot | null,
): T {
  if (!account) {
    throw new SwapError('POOL_NOT_FOUND', `${kind} account not found`, {
      details: { address: address.toBase58() },
    });
  }
  if (!account.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    throw new SwapError('UNSUPPORTED_POOL', `${kind} account is not owned by the DBC program`, {
      details: { address: address.toBase58(), owner: account.owner.toBase58() },
    });
  }
  try {
    return program.coder.accounts.decode<T>(kind, account.data);
  } catch (error) {
    throw new SwapError('UNSUPPORTED_POOL', `Account is not a plain DBC ${kind}`, {
      details: { address: address.toBase58() },
      cause: error,
    });
  }
}

async function getCurrentPointRobust(
  connection: Connection,
  activationType: number,
  commitment: Commitment,
): Promise<BN> {
  const slot = await rpc('getSlot', () => connection.getSlot(commitment));
  if (activationType === ActivationType.Slot) return new BN(slot);
  const blockTime = await rpc('getBlockTime', () => connection.getBlockTime(slot));
  // Only used for the quote (fee scheduler); the program uses its own clock.
  return new BN(blockTime ?? Math.floor(Date.now() / 1000));
}

/** Reads and decodes a pool and its config, plus the current point. */
export async function fetchSwapPoolState(
  connection: Connection,
  poolAddress: PublicKey | string,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<SwapPoolState & { configAddress: PublicKey }> {
  const pool = toPublicKey('pool', poolAddress);
  const program = dbcProgram(connection);
  const poolInfo = await rpc('getAccountInfo(pool)', () =>
    connection.getAccountInfo(pool, commitment),
  );
  const virtualPool = decodeDbcAccount<VirtualPool>(
    program,
    'virtualPool',
    pool,
    snapshot(poolInfo),
  );
  const configAddress = virtualPool.poolState.config;
  const configInfo = await rpc('getAccountInfo(config)', () =>
    connection.getAccountInfo(configAddress, commitment),
  );
  const config = decodeDbcAccount<PoolConfig>(
    program,
    'poolConfig',
    configAddress,
    snapshot(configInfo),
  );
  const currentPoint = await getCurrentPointRobust(connection, config.activationType, commitment);
  return { pool, virtualPool, config, configAddress, currentPoint };
}

export interface FetchSwapContextParams {
  connection: Connection;
  pool: PublicKey | string;
  user: PublicKey | string;
  platformFeeWallet: PublicKey;
  referralTokenAccount: PublicKey;
  commitment?: Commitment;
}

/** All network reads of a swap build: pool, config, user accounts, fee accounts, rent, blockhash. */
export async function fetchSwapContext(p: FetchSwapContextParams): Promise<SwapContext> {
  const { connection } = p;
  const commitment = p.commitment ?? DEFAULT_COMMITMENT;
  const user = toPublicKey('user', p.user);
  const pool = toPublicKey('pool', p.pool);
  const program = dbcProgram(connection);

  const [first, latest, slot] = await Promise.all([
    rpc('getMultipleAccountsInfo', () =>
      connection.getMultipleAccountsInfo(
        [pool, p.platformFeeWallet, p.referralTokenAccount, user],
        commitment,
      ),
    ),
    rpc('getLatestBlockhash', () => connection.getLatestBlockhash(commitment)),
    rpc('getSlot', () => connection.getSlot(commitment)),
  ]);
  const [poolInfo, platformInfo, referralInfo, userInfo] = first.map(snapshot);
  const virtualPool = decodeDbcAccount<VirtualPool>(program, 'virtualPool', pool, poolInfo ?? null);
  const configAddress = virtualPool.poolState.config;
  const coinProgram = coinTokenProgram(virtualPool);
  const userCoinAta = getAssociatedTokenAddressSync(
    virtualPool.poolState.baseMint,
    user,
    true,
    coinProgram,
  );
  const userWrappedSolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    user,
    true,
    TOKEN_PROGRAM_ID,
  );

  const second = await rpc('getMultipleAccountsInfo', () =>
    connection.getMultipleAccountsInfo([configAddress, userCoinAta, userWrappedSolAta], commitment),
  );
  const [configInfo, coinAtaInfo, wrappedSolAtaInfo] = second.map(snapshot);
  const config = decodeDbcAccount<PoolConfig>(
    program,
    'poolConfig',
    configAddress,
    configInfo ?? null,
  );

  const rent = (size: number) =>
    rpc('getMinimumBalanceForRentExemption', () =>
      connection.getMinimumBalanceForRentExemption(size, commitment),
    ).then(BigInt);
  const platformDataSize = platformInfo?.data.length ?? 0;
  const [systemAccountRent, platformRent, wrappedSolAtaRent, coinAtaRent, currentPoint] =
    await Promise.all([
      rent(0),
      platformDataSize === 0 ? null : rent(platformDataSize),
      rent(ACCOUNT_SIZE),
      rent(coinAtaSize(coinProgram)),
      config.activationType === ActivationType.Slot
        ? Promise.resolve(new BN(slot))
        : rpc('getBlockTime', () => connection.getBlockTime(slot)).then(
            (t) => new BN(t ?? Math.floor(Date.now() / 1000)),
          ),
    ]);

  return {
    pool,
    virtualPool,
    config,
    configAddress,
    currentPoint,
    user,
    userLamports: userInfo?.lamports ?? 0n,
    userCoinAta,
    userCoinAtaAccount: coinAtaInfo ?? null,
    userWrappedSolAta,
    userWrappedSolAtaAccount: wrappedSolAtaInfo ?? null,
    platformFeeWallet: p.platformFeeWallet,
    platformFeeWalletAccount: platformInfo ?? null,
    platformFeeWalletRentExemptMinimum: platformRent ?? systemAccountRent,
    referralTokenAccount: p.referralTokenAccount,
    referralTokenAccountInfo: referralInfo ?? null,
    systemAccountRent,
    wrappedSolAtaRent,
    coinAtaRent,
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

/** FORGE fee accounts used by the swap, resolved through addresses.ts (never hard-coded). */
export function swapFeeAddresses(env?: AddressEnv): {
  platformFeeWallet: PublicKey;
  referralTokenAccount: PublicKey;
} {
  const a = requireAddresses(['FORGE_PLATFORM_FEE_WALLET', 'FORGE_METEORA_REFERRAL_ACCOUNT'], env);
  return {
    platformFeeWallet: a.FORGE_PLATFORM_FEE_WALLET,
    referralTokenAccount: a.FORGE_METEORA_REFERRAL_ACCOUNT,
  };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

interface SwapCommonParams extends SwapBuildOptions {
  connection: Connection;
  pool: PublicKey | string;
  /** The trader: fee payer, signer and owner of the token accounts. */
  user: PublicKey | string;
  /** Environment to read the FORGE addresses from (defaults to `process.env`). */
  env?: AddressEnv;
  commitment?: Commitment;
}

export type BuildBuyTxParams = SwapCommonParams & {
  /** SOL into the swap, in lamports. The platform fee is paid on top of it. */
  amountInLamports: bigint;
} & SlippageInput;

export type BuildSellTxParams = SwapCommonParams & {
  /** Coins to sell, in raw units. */
  amountInTokens: bigint;
} & SlippageInput;

function slippageOf(p: Partial<SlippageInput>): SlippageInput {
  return { slippageBps: p.slippageBps, minAmountOut: p.minAmountOut } as SlippageInput;
}

async function buildSide(
  side: SwapSide,
  amountIn: bigint,
  p: SwapCommonParams & Partial<SlippageInput>,
): Promise<BuiltSwapTransaction> {
  // Validate the request before any network call.
  assertU64(side === 'buy' ? 'amountInLamports' : 'amountInTokens', amountIn, 1n);
  const slippage = readSlippage(slippageOf(p));
  const options = readBuildOptions(p);
  const { platformFeeWallet, referralTokenAccount } = swapFeeAddresses(p.env);
  const ctx = await fetchSwapContext({
    connection: p.connection,
    pool: p.pool,
    user: p.user,
    platformFeeWallet,
    referralTokenAccount,
    ...(p.commitment ? { commitment: p.commitment } : {}),
  });
  return buildSwapTransaction(ctx, { side, amountIn, slippage, ...options });
}

/** Unsigned buy transaction (SOL -> coin) with the FORGE referral and the platform fee. */
export async function buildBuyTx(params: BuildBuyTxParams): Promise<BuiltSwapTransaction> {
  return buildSide('buy', params.amountInLamports, params);
}

/** Unsigned sell transaction (coin -> SOL) with the FORGE referral and the platform fee. */
export async function buildSellTx(params: BuildSellTxParams): Promise<BuiltSwapTransaction> {
  return buildSide('sell', params.amountInTokens, params);
}

export type QuoteSwapParams = {
  connection: Connection;
  pool: PublicKey | string;
  side: SwapSide;
  /** Lamports on a buy, raw coin units on a sell. */
  amountIn: bigint;
  commitment?: Commitment;
} & (SlippageInput | { slippageBps?: undefined; minAmountOut?: undefined });

/**
 * Quote for display before signing: amounts (bigint), pool fees (trading, protocol, referral) and
 * the platform fee. Without slippage input, `minAmountOut` equals the expected output.
 */
export async function quoteSwap(params: QuoteSwapParams): Promise<SwapQuote> {
  assertU64('amountIn', params.amountIn, 1n);
  const slippage: SlippageInput =
    params.slippageBps === undefined && params.minAmountOut === undefined
      ? { slippageBps: 0 }
      : readSlippage(slippageOf(params));
  const state = await fetchSwapPoolState(params.connection, params.pool, params.commitment);
  return computeSwapQuote(state, { side: params.side, amountIn: params.amountIn, slippage });
}

/**
 * Startup / pre-build check of the FORGE fee accounts: the platform fee wallet must be rent-exempt
 * and the referral account must be a wrapped SOL token account. Throws `SwapError`.
 */
export async function assertSwapFeeAccountsReady(params: {
  connection: Connection;
  env?: AddressEnv;
  commitment?: Commitment;
}): Promise<void> {
  const commitment = params.commitment ?? DEFAULT_COMMITMENT;
  const { platformFeeWallet, referralTokenAccount } = swapFeeAddresses(params.env);
  const [platformInfo, referralInfo] = (
    await rpc('getMultipleAccountsInfo', () =>
      params.connection.getMultipleAccountsInfo(
        [platformFeeWallet, referralTokenAccount],
        commitment,
      ),
    )
  ).map(snapshot);
  const rentMinimum = BigInt(
    await rpc('getMinimumBalanceForRentExemption', () =>
      params.connection.getMinimumBalanceForRentExemption(
        platformInfo?.data.length ?? 0,
        commitment,
      ),
    ),
  );
  assertPlatformFeeWalletReady(platformFeeWallet, platformInfo ?? null, rentMinimum);
  assertReferralAccountReady(referralTokenAccount, referralInfo ?? null);
}
