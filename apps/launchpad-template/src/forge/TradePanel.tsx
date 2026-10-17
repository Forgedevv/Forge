import { useMemo } from 'react';
import { siteConfig } from './config';
import JupiterTrade from './JupiterTrade';
import { formatBps } from './trade/amounts';
import { JUPITER_REFERRAL_FEE_BPS } from './trade/constants';
import { getRelayConnection } from './trade/connection';
import { TradeForm } from './trade/TradeForm';
import { useGraduated } from './trade/useGraduated';
import { useLaunchpadPool } from './trade/useLaunchpadPool';
import { TRADE_TEXT } from './trade/copy';
import { TradeError } from './trade/errors';
import type { ConfirmOptions } from './trade/confirm';

export interface TradePanelProps {
  /**
   * Coin mint address (base58). There is no pool prop: the pool is derived from the mint and this
   * launchpad's two configs (`forge.config.json#onchain`), then looked up on-chain, so a coin of
   * any other launchpad cannot be traded here.
   */
  mint: string;
  /**
   * Ticker shown in labels (from the coin data: the data API, or the on-chain fallback). Without
   * one the labels stay neutral ("Buy", "Sell"): no placeholder ticker is ever shown.
   */
  symbol?: string;
  /**
   * Decimals from a data API, display fallback only: amounts use the on-chain mint decimals.
   */
  displayDecimals?: number;
  className?: string;
  /** Called with the signature once a trade is confirmed. */
  onTradeConfirmed?: (signature: string) => void;
  /** Tuning knobs, mostly for tests. */
  quoteDebounceMs?: number;
  quoteRefreshMs?: number;
  confirmOptions?: ConfirmOptions;
}

const TEXT = TRADE_TEXT.panel;

const shell =
  'w-full rounded-[var(--radius)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text)]';

/**
 * The trade panel of a coin page.
 *
 * - `sleeping` / `disabled` sites: a disabled notice only. No RPC, no wallet, no Jupiter script.
 * - The pool is looked up on this launchpad's configs (users' coins, then the launchpad's own
 *   coin). A coin with no pool there gets a notice and nothing can be traded.
 * - On the bonding curve: buy/sell form with the full quote and fees shown before signing; swaps
 *   are built by `@forge/core` (through `trade/core-adapter`, which checks the pool's config
 *   again on-chain).
 * - Graduated: the Jupiter plugin with the FORGE integrator fee.
 *
 * Styling uses the theme CSS variables (`--color-*`, `--radius`) so the free zone can restyle it
 * through the theme without touching this file.
 */
export function TradePanel(props: TradePanelProps) {
  if (siteConfig.mode !== 'live') {
    return (
      <section
        className={`${shell} ${props.className ?? ''}`}
        data-forge="trade-panel"
        data-mode={siteConfig.mode}
      >
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-[var(--radius)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-muted)] opacity-60"
          data-testid="trade-disabled"
        >
          {siteConfig.mode === 'sleeping' ? TEXT.paused : TEXT.unavailable}
        </button>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {siteConfig.mode === 'sleeping' ? TEXT.sleepingNote : TEXT.unavailableNote}
        </p>
      </section>
    );
  }
  return <LiveTradePanel {...props} />;
}

function LiveTradePanel(props: TradePanelProps) {
  const { mint, displayDecimals, className } = props;
  const symbol = props.symbol?.trim() || undefined;
  const connection = useMemo(() => getRelayConnection(), []);
  const { state: poolState, retry: retryPool } = useLaunchpadPool(connection, mint);
  const launchpadPool = poolState.status === 'ready' ? poolState.pool : null;
  const { state, retry, markGraduated } = useGraduated(connection, launchpadPool);

  const loading = (
    <p className="text-sm text-[var(--color-text-muted)]" data-testid="trade-loading">
      {TEXT.loading}
    </p>
  );
  const routeError = (message: string, onRetry: () => void) => (
    <div role="alert" className="flex flex-col gap-2 text-sm" data-testid="trade-route-error">
      <p className="text-[var(--color-danger)]">{message}</p>
      <button type="button" onClick={onRetry} className="self-start underline touch:min-h-[2.5rem]">
        {TEXT.retry}
      </button>
    </div>
  );

  let body;
  if (!connection) {
    body = (
      <p
        role="alert"
        className="text-sm text-[var(--color-text-muted)]"
        data-testid="trade-not-configured"
      >
        {new TradeError('not_configured').message}
      </p>
    );
  } else if (poolState.status === 'loading') {
    body = loading;
  } else if (poolState.status === 'error') {
    body = routeError(poolState.error.message, retryPool);
  } else if (!launchpadPool) {
    body = (
      <p
        role="alert"
        className="text-sm text-[var(--color-text-muted)]"
        data-testid="trade-not-on-launchpad"
      >
        {new TradeError('not_on_launchpad').message}
      </p>
    );
  } else if (state.status === 'loading') {
    body = loading;
  } else if (state.status === 'error') {
    body = routeError(state.error.message, retry);
  } else if (state.status === 'graduated') {
    body = (
      <div className="flex flex-col gap-3" data-testid="trade-jupiter">
        <p className="text-sm text-[var(--color-text-muted)]">
          {TEXT.graduated(formatBps(JUPITER_REFERRAL_FEE_BPS))}
        </p>
        <JupiterTrade launchpadPool={launchpadPool} />
      </div>
    );
  } else {
    body = (
      <TradeForm
        connection={connection}
        launchpadPool={launchpadPool}
        symbol={symbol}
        displayDecimals={displayDecimals}
        onConfirmed={props.onTradeConfirmed}
        onGraduated={markGraduated}
        quoteDebounceMs={props.quoteDebounceMs}
        quoteRefreshMs={props.quoteRefreshMs}
        confirmOptions={props.confirmOptions}
      />
    );
  }

  return (
    <section className={`${shell} ${className ?? ''}`} data-forge="trade-panel" data-mode="live">
      {body}
    </section>
  );
}

export default TradePanel;
