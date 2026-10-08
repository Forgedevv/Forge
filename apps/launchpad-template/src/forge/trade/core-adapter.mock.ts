/**
 * Deterministic in-memory swap core for tests and previews. Never used by the production bundle
 * (nothing imports it outside tests). Constant-product style numbers, no network.
 */
import { Transaction } from '@solana/web3.js';
import { PLATFORM_FEE_BPS } from './constants';
import { applyBps, minAfterSlippage } from './amounts';
import type { BuildSwapParams, SwapCore, SwapQuote } from './core-adapter';

export interface MockSwapCoreOptions {
  graduated?: boolean;
  /** Tokens received per 1 SOL on a buy (raw units / lamport ratio is derived from it). */
  tokensPerSol?: bigint;
  priceImpactBps?: number;
  /** Pool trading fee in bps of the SOL leg. */
  tradingFeeBps?: number;
  /** Override the announced platform fee (to test the consistency guard). */
  platformFeeOverride?: bigint;
}

export interface MockSwapCore extends SwapCore {
  calls: { quote: number; buy: number; sell: number; graduated: number };
  options: MockSwapCoreOptions;
}

export function createMockSwapCore(options: MockSwapCoreOptions = {}): MockSwapCore {
  const state: MockSwapCoreOptions = { tokensPerSol: BigInt(1_000_000_000), ...options };
  const calls = { quote: 0, buy: 0, sell: 0, graduated: 0 };

  const quoteFor = (side: 'buy' | 'sell', amountIn: bigint, slippageBps: number): SwapQuote => {
    // buy: lamports -> tokens (6 decimals); sell: tokens -> lamports.
    const rate = state.tokensPerSol ?? BigInt(1_000_000_000);
    const solLeg = side === 'buy' ? amountIn : (amountIn * BigInt(1_000_000_000)) / rate;
    const amountOut = side === 'buy' ? (amountIn * rate) / BigInt(1_000_000_000) : solLeg;
    const minAmountOut = minAfterSlippage(amountOut, slippageBps);
    const platformFee =
      state.platformFeeOverride ??
      applyBps(side === 'buy' ? amountIn : amountOut, PLATFORM_FEE_BPS);
    return {
      side,
      amountIn,
      amountOut,
      minAmountOut,
      priceImpactBps: state.priceImpactBps ?? 42,
      tradingFee: applyBps(solLeg, state.tradingFeeBps ?? 100),
      platformFee,
      platformFeeBps: PLATFORM_FEE_BPS,
      quotedAt: Date.now(),
    };
  };

  // Instruction-free transaction: the mock only has to carry the fee payer.
  const build = (params: BuildSwapParams) => {
    const tx = new Transaction();
    tx.feePayer = params.user;
    return tx;
  };

  return {
    calls,
    options: state,
    async isGraduated() {
      calls.graduated += 1;
      return state.graduated === true;
    },
    async quoteSwap(p) {
      calls.quote += 1;
      return quoteFor(p.side, p.amountIn, p.slippageBps);
    },
    async buildBuyTx(p) {
      calls.buy += 1;
      return build(p);
    },
    async buildSellTx(p) {
      calls.sell += 1;
      return build(p);
    },
  };
}
