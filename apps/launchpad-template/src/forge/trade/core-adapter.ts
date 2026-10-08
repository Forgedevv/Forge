/**
 * Local adapter over the swap functions of `@forge/core` (tasks/01-ONCHAIN.md: `swap.ts` and
 * `reads.ts`).
 *
 * SWITCH TO @forge/core AT MERGE: once `@forge/core` exports `buildBuyTx`, `buildSellTx`,
 * `quoteSwap` and `isGraduated`, replace `unlinkedSwapCore` below with thin wrappers around them
 * (the parameter objects here are the contract the panel needs; map them to the published
 * signatures). The panel never reimplements a swap: it only calls this module.
 *
 * Until then the default implementation REFUSES to quote or build anything. A fake quote must never
 * reach a wallet, so the unlinked core throws `SwapCoreNotLinkedError`. Tests and previews inject
 * `createMockSwapCore()` from `./core-adapter.mock` through `setSwapCore`.
 */
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
  /** Pool trading fee (partner + creator + protocol), in lamports of SOL. */
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

export class SwapCoreNotLinkedError extends Error {
  constructor() {
    super('The swap core is not linked yet.');
    this.name = 'SwapCoreNotLinkedError';
  }
}

const unlinkedSwapCore: SwapCore = {
  async isGraduated() {
    throw new SwapCoreNotLinkedError();
  },
  async quoteSwap() {
    throw new SwapCoreNotLinkedError();
  },
  async buildBuyTx() {
    throw new SwapCoreNotLinkedError();
  },
  async buildSellTx() {
    throw new SwapCoreNotLinkedError();
  },
};

let current: SwapCore = unlinkedSwapCore;

/** Replaces the implementation (tests, previews). Returns a function restoring the previous one. */
export function setSwapCore(core: SwapCore): () => void {
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
