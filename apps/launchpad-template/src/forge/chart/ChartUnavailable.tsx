import { CHART_UNAVAILABLE_COPY } from './copy';

/**
 * LOCKED ZONE. Shown in place of the chart when its price history cannot be loaded: the Jupiter
 * data API is unavailable, or the site runs on devnet (Jupiter does not index it). Prices, curve
 * progress and the FORGE trade panel keep working from on-chain data. Styled with the theme's
 * empty-state classes (`launchpad-market-empty`).
 */
/** Texts of this state; they live in `chart/copy.ts`. */
export { CHART_UNAVAILABLE_COPY };

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
