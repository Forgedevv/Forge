/**
 * LOCKED ZONE. Adapter between the trade panel and the swap functions of `@forge/core`
 * (`quoteSwap`, `buildBuyTx`, `buildSellTx`, `getDbcPoolState` / `isGraduated`).
 *
 * The default implementation is a thin wrapper: every quote, fee and transaction comes from
 * `@forge/core`, nothing about a swap is computed here. The wrapper only maps parameter shapes
 * (the panel works with `amountIn` / `minAmountOut`), and turns core errors into `TradeError`s
 * with a user-safe message. Two things it does not let anyone change:
 *
 * - the FORGE fee accounts (platform fee wallet, Meteora referral, revenue wallet) are read HERE,
 *   from the build-time public environment, and nowhere else: there is no parameter to override
 *   them, so no code of the site can redirect the 0.3% platform fee or the referral;
 * - every pool is checked against this launchpad's configs (`allowedConfigs` of @forge/core,
 *   `launchpadConfigs()`): a coin of another launchpad is refused before any quote;
 * - the priority fee of a trade is `SITE_PRIORITY_FEE` (../priority-fee.ts): priced by core from
 *   the recent fees of the accounts the swap writes, at most `SWAP_MAX_PRIORITY_FEE_LAMPORTS`.
 *
 * Tests inject `createMockSwapCore()` from `./core-adapter.mock` through `setSwapCore`, which is a
 * no-op outside the test environment (`NODE_ENV === 'test'`).
 */
import {
  ForgeAddressError,
  SwapError,
  assertPoolConfigAllowed,
  computeSwapQuote,
  buildBuyTx as coreBuildBuyTx,
  buildSellTx as coreBuildSellTx,
  fetchSwapPoolState,
  getDbcPoolState,
  isGraduated as coreIsGraduated,
  type AddressEnv,
  type SwapPoolState,
  type SwapQuote as CoreSwapQuote,
  type SwapQuoteRequest,
} from '@forge/core';
import { SITE_PRIORITY_FEE } from '../priority-fee';
import { TradeError, type TradeErrorCode } from './errors';
import { launchpadConfigs } from './launchpad-pool';
import type { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export type TradeSide = 'buy' | 'sell';

/**
 * Amounts are raw units: lamports of SOL for a buy input / sell output, token base units for a
 * buy output / sell input.
 */
export interface SwapQuote {
  side: TradeSide;
  /** Echo of the requested input amount. */
  amountIn: bigint;
  /** Expected output. */
  amountOut: bigint;
  /** Output below which the transaction fails on-chain (slippage applied). */
  minAmountOut: bigint;
  /** Price impact in basis points (>= 0). */
  priceImpactBps: number;
  /** Pool trading fee (partner + creator + protocol + referral), in lamports of SOL. */
  tradingFee: bigint;
  /** FORGE platform fee, in lamports of SOL, as it will be added to the transaction. */
  platformFee: bigint;
  /** Platform fee rate; must equal 30. */
  platformFeeBps: number;
  /** Epoch milliseconds when the quote was computed. */
  quotedAt: number;
}

export interface QuoteSwapParams {
  connection: Connection;
  pool: PublicKey;
  side: TradeSide;
  amountIn: bigint;
  slippageBps: number;
}

export interface BuildSwapParams {
  connection: Connection;
  pool: PublicKey;
  /** Wallet that signs and pays. */
  user: PublicKey;
  amountIn: bigint;
  /** Output floor the user saw before signing; enforced on-chain. */
  minAmountOut: bigint;
}

export interface IsGraduatedParams {
  connection: Connection;
  pool: PublicKey;
}

export type BuiltTransaction = Transaction | VersionedTransaction;

export interface SwapCore {
  isGraduated(params: IsGraduatedParams): Promise<boolean>;
  quoteSwap(params: QuoteSwapParams): Promise<SwapQuote>;
  /** Must refuse a graduated pool. Includes the referral and the 0.3% platform fee transfer. */
  buildBuyTx(params: BuildSwapParams): Promise<BuiltTransaction>;
  /** Must refuse a graduated pool. Includes the referral and the 0.3% platform fee transfer. */
  buildSellTx(params: BuildSwapParams): Promise<BuiltTransaction>;
}

const SWAP_ERROR_MAP: Record<string, { code: TradeErrorCode; message?: string }> = {
  POOL_GRADUATED: { code: 'pool_graduated' },
  POOL_NOT_ALLOWED: { code: 'not_on_launchpad' },
  PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT: { code: 'not_configured' },
  PLATFORM_FEE_WALLET_MISMATCH: { code: 'not_configured' },
  REFERRAL_ACCOUNT_INVALID: { code: 'not_configured' },
  UNSUPPORTED_POOL: { code: 'quote_invalid' },
  POOL_NOT_FOUND: { code: 'quote_invalid' },
  INVALID_PARAMS: { code: 'quote_invalid' },
  QUOTE_FAILED: { code: 'quote_invalid' },
  INSUFFICIENT_LIQUIDITY: {
    code: 'quote_invalid',
    message: 'This amount is more than the curve can sell before graduation. Try a smaller amount.',
  },
  AMOUNT_TOO_SMALL: { code: 'quote_invalid', message: 'This amount is too small to trade.' },
  MIN_AMOUNT_OUT_ABOVE_QUOTE: { code: 'price_moved' },
  SLIPPAGE_TOO_HIGH: { code: 'slippage_exceeded' },
  INSUFFICIENT_SOL_BALANCE: { code: 'insufficient_funds' },
  INSUFFICIENT_TOKEN_BALANCE: { code: 'insufficient_funds' },
  TRANSACTION_TOO_LARGE: { code: 'quote_invalid' },
  RPC_ERROR: { code: 'network' },
};

/** Core errors become `TradeError`s; anything else is left for `mapTradeError`. */
export function translateCoreError(error: unknown): unknown {
  if (error instanceof SwapError) {
    const mapped = SWAP_ERROR_MAP[error.code] ?? { code: 'unknown' as const };
    return new TradeError(mapped.code, mapped.message, { cause: error });
  }
  if (error instanceof ForgeAddressError) {
    // The FORGE fee accounts are missing from the public environment of this site.
    return new TradeError('not_configured', undefined, { cause: error });
  }
  return error;
}

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateCoreError(error);
  }
}

/**
 * The FORGE addresses `@forge/core` needs, from the public environment, read here only. Core
 * reads `process.env` by default, which the browser bundle does not have, so they are handed over
 * explicitly: literal `NEXT_PUBLIC_*` reads, which Next.js replaces by their build-time values,
 * so nothing at runtime can change them. `FORGE_REVENUE_WALLET` is optional: when FORGE provides
 * it, core also checks that the Meteora referral account is held by the revenue wallet and that
 * the platform fee wallet is that wallet (D34).
 */
function forgeAddressEnv(): AddressEnv {
  const revenue = process.env.NEXT_PUBLIC_FORGE_REVENUE_WALLET;
  return {
    FORGE_PLATFORM_FEE_WALLET: process.env.NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET,
    FORGE_METEORA_REFERRAL_ACCOUNT: process.env.NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT,
    ...(revenue ? { FORGE_REVENUE_WALLET: revenue } : {}),
  };
}

/**
 * Display-only price impact, in bps: how much worse the average price of this trade is than the
 * average price of a small reference trade (1% of the size) quoted by the same core function on the
 * same pool state. Both numbers come from `computeSwapQuote`; no swap math lives here. Zero when
 * the trade is too small for a reference quote.
 */
export function priceImpactBps(
  state: SwapPoolState,
  request: SwapQuoteRequest,
  quote: Pick<CoreSwapQuote, 'expectedAmountOut'>,
): number {
  const referenceIn = request.amountIn / BigInt(100);
  if (referenceIn <= BigInt(0)) return 0;
  let referenceOut: bigint;
  try {
    referenceOut = computeSwapQuote(state, { ...request, amountIn: referenceIn }).expectedAmountOut;
  } catch (error) {
    if (error instanceof SwapError) return 0;
    throw error;
  }
  if (referenceOut <= BigInt(0)) return 0;
  // 1 - (out / in) / (refOut / refIn), in bps.
  const ratio =
    (quote.expectedAmountOut * referenceIn * BigInt(10_000)) / (request.amountIn * referenceOut);
  const impact = BigInt(10_000) - ratio;
  return impact > BigInt(0) ? Number(impact) : 0;
}

/**
 * Swap core backed by `@forge/core`. It takes no option: the fee accounts come from
 * `forgeAddressEnv` and the allowed pools from `launchpadConfigs`, both fixed at build time.
 */
export function createCoreSwapCore(): SwapCore {
  const env = forgeAddressEnv;
  return {
    isGraduated: ({ connection, pool }) =>
      translated(async () => {
        const state = await getDbcPoolState(connection, pool);
        assertPoolConfigAllowed(pool, state.virtualPool.poolState.config, launchpadConfigs());
        return coreIsGraduated(state);
      }),

    quoteSwap: ({ connection, pool, side, amountIn, slippageBps }) =>
      translated(async () => {
        const state = await fetchSwapPoolState(connection, pool, 'confirmed', {
          allowedConfigs: launchpadConfigs(),
        });
        const request: SwapQuoteRequest = { side, amountIn, slippage: { slippageBps } };
        const quote = computeSwapQuote(state, request);
        return {
          side,
          amountIn: quote.amountIn,
          amountOut: quote.expectedAmountOut,
          minAmountOut: quote.minAmountOut,
          priceImpactBps: priceImpactBps(state, request, quote),
          tradingFee: quote.fees.totalPoolFee,
          platformFee: quote.fees.platformFee,
          platformFeeBps: quote.fees.platformFeeBps,
          quotedAt: Date.now(),
        };
      }),

    buildBuyTx: ({ connection, pool, user, amountIn, minAmountOut }) =>
      translated(
        async () =>
          (
            await coreBuildBuyTx({
              connection,
              pool,
              user,
              amountInLamports: amountIn,
              minAmountOut,
              env: env(),
              allowedConfigs: launchpadConfigs(),
              priority: SITE_PRIORITY_FEE,
            })
          ).transaction,
      ),

    buildSellTx: ({ connection, pool, user, amountIn, minAmountOut }) =>
      translated(
        async () =>
          (
            await coreBuildSellTx({
              connection,
              pool,
              user,
              amountInTokens: amountIn,
              minAmountOut,
              env: env(),
              allowedConfigs: launchpadConfigs(),
              priority: SITE_PRIORITY_FEE,
            })
          ).transaction,
      ),
  };
}

let current: SwapCore = createCoreSwapCore();

/** True only under the test runner: Next.js inlines `NODE_ENV` in every build. */
function swapCoreReplaceable(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Replaces the implementation, in tests only. Returns a function restoring the previous one. In
 * any build of the site (production or development) it does nothing: the swap core is always
 * `@forge/core`, with FORGE's fee accounts.
 */
export function setSwapCore(core: SwapCore): () => void {
  if (!swapCoreReplaceable()) return () => {};
  const previous = current;
  current = core;
  return () => {
    current = previous;
  };
}

export const isGraduated = (params: IsGraduatedParams) => current.isGraduated(params);
export const quoteSwap = (params: QuoteSwapParams) => current.quoteSwap(params);
export const buildBuyTx = (params: BuildSwapParams) => current.buildBuyTx(params);
export const buildSellTx = (params: BuildSwapParams) => current.buildSellTx(params);
