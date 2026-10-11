import type { Connection, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isPlatformFeeConsistent } from './amounts';
import { quoteSwap, type SwapQuote, type TradeSide } from './core-adapter';
import { mapTradeError, TradeError } from './errors';
import { QUOTE_DEBOUNCE_MS, QUOTE_REFRESH_MS } from './constants';

export type QuoteState =
  | { status: 'idle'; quote: null; error: null }
  | { status: 'loading'; quote: null; error: null }
  | { status: 'ready'; quote: SwapQuote; error: null }
  | { status: 'error'; quote: null; error: TradeError };

export interface UseQuoteParams {
  connection: Connection | null;
  pool: PublicKey | null;
  side: TradeSide;
  /** Raw input amount, or null when the input is empty/invalid (no quote is requested). */
  amountIn: bigint | null;
  slippageBps: number | null;
  enabled: boolean;
  debounceMs?: number;
  refreshMs?: number;
}

/**
 * Fetches a quote for the pre-sign summary. The quote is debounced on input changes, refreshed on
 * an interval, and every response is checked: a quote whose platform fee is not the documented
 * 0.3% is rejected (`quote_invalid`) and can never be signed.
 */
export function fetchVerifiedQuote(
  params: Pick<UseQuoteParams, 'connection' | 'pool' | 'side'> & {
    amountIn: bigint;
    slippageBps: number;
  },
): Promise<SwapQuote> {
  const { connection, pool, side, amountIn, slippageBps } = params;
  if (!connection || !pool) return Promise.reject(new TradeError('not_configured'));
  return quoteSwap({ connection, pool, side, amountIn, slippageBps }).then((quote) => {
    const ok =
      quote.side === side &&
      quote.amountIn === amountIn &&
      quote.amountOut > BigInt(0) &&
      quote.minAmountOut >= BigInt(0) &&
      quote.minAmountOut <= quote.amountOut &&
      quote.priceImpactBps >= 0 &&
      quote.tradingFee >= BigInt(0) &&
      isPlatformFeeConsistent({
        side,
        amountIn,
        amountOut: quote.amountOut,
        minAmountOut: quote.minAmountOut,
        platformFee: quote.platformFee,
        platformFeeBps: quote.platformFeeBps,
      });
    if (!ok) throw new TradeError('quote_invalid');
    return quote;
  });
}

export function useQuote(params: UseQuoteParams): QuoteState & { refresh: () => void } {
  const {
    connection,
    pool,
    side,
    amountIn,
    slippageBps,
    enabled,
    debounceMs = QUOTE_DEBOUNCE_MS,
    refreshMs = QUOTE_REFRESH_MS,
  } = params;
  const [state, setState] = useState<QuoteState>({ status: 'idle', quote: null, error: null });
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);
  const lastKey = useRef<string | null>(null);

  const active =
    enabled && connection !== null && pool !== null && amountIn !== null && slippageBps !== null;

  useEffect(() => {
    if (!active) {
      requestId.current += 1;
      lastKey.current = null;
      setState({ status: 'idle', quote: null, error: null });
      return;
    }
    const id = ++requestId.current;
    const key = `${pool.toBase58()}|${side}|${amountIn}|${slippageBps}`;
    // A new input invalidates the quote on screen. A periodic refresh keeps it until replaced.
    if (lastKey.current !== key) {
      lastKey.current = key;
      setState({ status: 'loading', quote: null, error: null });
    }

    const timer = setTimeout(() => {
      fetchVerifiedQuote({
        connection,
        pool,
        side,
        amountIn: amountIn as bigint,
        slippageBps: slippageBps as number,
      }).then(
        (quote) => {
          if (id === requestId.current) setState({ status: 'ready', quote, error: null });
        },
        (error: unknown) => {
          if (id === requestId.current) {
            setState({ status: 'error', quote: null, error: mapTradeError(error) });
          }
        },
      );
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [active, connection, pool, side, amountIn, slippageBps, debounceMs, tick]);

  // Periodic refresh while a quote is on screen.
  useEffect(() => {
    if (!active || refreshMs <= 0) return;
    const interval = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(interval);
  }, [active, refreshMs]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}
