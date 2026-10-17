/**
 * LOCKED ZONE. Shown in place of the chart when its price history cannot be loaded: the Jupiter
 * data API is unavailable, or the site runs on devnet (Jupiter does not index it). Prices, curve
 * progress and the FORGE trade panel keep working from on-chain data. Styled with the theme's
 * empty-state classes (`launchpad-market-empty`).
 */
export const CHART_UNAVAILABLE_COPY = {
  unavailable: {
    title: 'Chart temporarily unavailable',
    body: 'Price history could not be loaded. Prices and trading still work.',
    retry: 'Retry',
  },
  devnet: {
    title: 'No chart on devnet',
    body: 'Price history comes from Jupiter, which does not index devnet. Prices and trading still work.',
  },
} as const;

type ChartUnavailableProps = {
  /** Devnet: no retry, the history never exists there. */
  devnet?: boolean;
  onRetry?: () => void;
};

export function ChartUnavailable({ devnet = false, onRetry }: ChartUnavailableProps) {
  const copy = devnet ? CHART_UNAVAILABLE_COPY.devnet : CHART_UNAVAILABLE_COPY.unavailable;
  return (
    <div
      className="launchpad-market-empty launchpad-chart-unavailable h-full w-full"
      role="status"
      data-testid="chart-unavailable"
    >
      <span className="launchpad-empty-mark" aria-hidden="true">
        ∿
      </span>
      <p>{copy.title}</p>
      <span>{copy.body}</span>
      {!devnet && onRetry ? (
        <button type="button" className="launchpad-hero-link" onClick={onRetry}>
          {CHART_UNAVAILABLE_COPY.unavailable.retry}
        </button>
      ) : null}
    </div>
  );
}
