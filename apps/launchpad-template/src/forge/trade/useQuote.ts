import type { Connection } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPlatformFeeConsistent } from './amounts';
import { quoteSwap, type SwapQuote, type TradeSide } from './core-adapter';
import { mapTradeError, TradeError, type TradeErrorCode } from './errors';
import { QUOTE_DEBOUNCE_MS, QUOTE_MAX_AGE_MS, QUOTE_REFRESH_MS } from './constants';
import { launchpadPoolKey, type LaunchpadPool } from './launchpad-pool';

/** A verified quote on screen. */
export interface ReadyQuote {
  status: 'ready';
  quote: SwapQuote;
  error: null;
  /** When the quote was received (ms since epoch). */
  receivedAt: number;
  /** A periodic or manual refresh of this same quote is in flight. */
  refreshing: boolean;
  /**
   * The last refresh failed with a transient error (network, rate limit): the previous good quote
   * stays on screen, marked stale, until it is replaced or too old.
   */
  refreshError: TradeError | null;
  /** Older than the signing limit (`maxAgeMs`): shown, but the trade waits for a new quote. */
  expired: boolean;
}

export type QuoteState =
  | { status: 'idle'; quote: null; error: null }
  | { status: 'loading'; quote: null; error: null }
  | ReadyQuote
  | { status: 'error'; quote: null; error: TradeError };

export interface UseQuoteParams {
  connection: Connection | null;
  /** A pool found by `findLaunchpadPool`; anything else is refused (`not_on_launchpad`). */
  launchpadPool: LaunchpadPool | null;
  side: TradeSide;
  /** Raw input amount, or null when the input is empty/invalid (no quote is requested). */
  amountIn: bigint | null;
  slippageBps: number | null;
  enabled: boolean;
  debounceMs?: number;
  refreshMs?: number;
  /** Age after which the quote on screen can no longer be signed. */
  maxAgeMs?: number;
}

/**
 * Errors of a refresh that keep the previous good quote on screen (stale): the network or the
 * relay hiccuped, nothing says the quote is wrong. Anything else (an unverifiable quote, a
 * graduated pool, a coin that is not on this launchpad...) drops it.
 */
const TRANSIENT_REFRESH_ERRORS: ReadonlySet<TradeErrorCode> = new Set<TradeErrorCode>([
  'network',
  'rate_limited',
  'pool_unavailable',
  'unknown',
]);

/**
 * Fetches a quote for the pre-sign summary. The quote is debounced on input changes, refreshed on
 * an interval, and every response is checked: a quote whose platform fee is not the documented
 * 0.3% is rejected (`quote_invalid`) and can never be signed.
 */
export function fetchVerifiedQuote(
  params: Pick<UseQuoteParams, 'connection' | 'launchpadPool' | 'side'> & {
    amountIn: bigint;
    slippageBps: number;
  },
): Promise<SwapQuote> {
  const { connection, side, amountIn, slippageBps } = params;
  if (!connection) return Promise.reject(new TradeError('not_configured'));
  const pool = launchpadPoolKey(params.launchpadPool);
  if (!pool) return Promise.reject(new TradeError('not_on_launchpad'));
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

type InternalState =
  | { status: 'idle' | 'loading' }
  | {
      status: 'ready';
      quote: SwapQuote;
      receivedAt: number;
      refreshing: boolean;
      refreshError: TradeError | null;
    }
  | { status: 'error'; error: TradeError };

function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Quote of the trade form.
 *
 * - A new input (pool, side, amount, slippage) drops the quote on screen and fetches a new one.
 * - While a quote is on screen it is refreshed every `refreshMs`, only while the tab is visible
 *   (back on the tab, an old quote is refreshed at once).
 * - A refresh that fails on a transient error keeps the last good quote, marked stale
 *   (`refreshError`); any other failure replaces it with the error.
 * - A quote older than `maxAgeMs` is `expired`: still shown, never signable until replaced.
 */
export function useQuote(params: UseQuoteParams): QuoteState & { refresh: () => void } {
  const {
    connection,
    launchpadPool,
    side,
    amountIn,
    slippageBps,
    enabled,
    debounceMs = QUOTE_DEBOUNCE_MS,
    refreshMs = QUOTE_REFRESH_MS,
    maxAgeMs = QUOTE_MAX_AGE_MS,
  } = params;
  const [state, setState] = useState<InternalState>({ status: 'idle' });
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(() => !isTabHidden());
  // Re-renders the form when the quote on screen reaches its signing limit.
  const [, setClock] = useState(0);
  const requestId = useRef(0);
  const lastKey = useRef<string | null>(null);
  const receivedAt = useRef<number | null>(null);
  const pool = useMemo(() => launchpadPoolKey(launchpadPool), [launchpadPool]);

  const active =
    enabled && connection !== null && pool !== null && amountIn !== null && slippageBps !== null;

  useEffect(() => {
    if (!active) {
      requestId.current += 1;
      lastKey.current = null;
      receivedAt.current = null;
      setState({ status: 'idle' });
      return;
    }
    const id = ++requestId.current;
    const key = `${pool.toBase58()}|${side}|${amountIn}|${slippageBps}`;
    // A new input invalidates the quote on screen. A periodic refresh keeps it until replaced.
    if (lastKey.current !== key) {
      lastKey.current = key;
      receivedAt.current = null;
      setState({ status: 'loading' });
    } else {
      setState((prev) => (prev.status === 'ready' ? { ...prev, refreshing: true } : prev));
    }

    const timer = setTimeout(() => {
      fetchVerifiedQuote({
        connection,
        launchpadPool,
        side,
        amountIn: amountIn as bigint,
        slippageBps: slippageBps as number,
      }).then(
        (quote) => {
          if (id !== requestId.current) return;
          const now = Date.now();
          receivedAt.current = now;
          setState({
            status: 'ready',
            quote,
            receivedAt: now,
            refreshing: false,
            refreshError: null,
          });
        },
        (error: unknown) => {
          if (id !== requestId.current) return;
          const mapped = mapTradeError(error);
          setState((prev) =>
            prev.status === 'ready' && TRANSIENT_REFRESH_ERRORS.has(mapped.code)
              ? { ...prev, refreshing: false, refreshError: mapped }
              : { status: 'error', error: mapped },
          );
          if (!TRANSIENT_REFRESH_ERRORS.has(mapped.code)) receivedAt.current = null;
        },
      );
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [active, connection, launchpadPool, pool, side, amountIn, slippageBps, debounceMs, tick]);

  // Refreshes pause while the tab is hidden.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(!isTabHidden());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // Periodic refresh while a quote is on screen and the tab is visible.
  useEffect(() => {
    if (!active || refreshMs <= 0 || !visible) return;
    // Back on the tab with a quote older than one period: refresh at once.
    if (receivedAt.current !== null && Date.now() - receivedAt.current >= refreshMs) {
      setTick((n) => n + 1);
    }
    const interval = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(interval);
  }, [active, refreshMs, visible]);

  // Signing limit of the quote on screen.
  const readyAt = state.status === 'ready' ? state.receivedAt : null;
  useEffect(() => {
    if (readyAt === null) return;
    const wait = readyAt + maxAgeMs - Date.now();
    if (wait < 0) return;
    const timer = setTimeout(() => setClock((n) => n + 1), wait + 1);
    return () => clearTimeout(timer);
  }, [readyAt, maxAgeMs]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  switch (state.status) {
    case 'ready':
      return {
        ...state,
        error: null,
        expired: Date.now() - state.receivedAt > maxAgeMs,
        refresh,
      };
    case 'error':
      return { status: 'error', quote: null, error: state.error, refresh };
    default:
      return { status: state.status, quote: null, error: null, refresh };
  }
}
