import { cn } from '@/lib/utils';

type DataUnavailableProps = {
  title: string;
  body: string;
  /** Shown as a retry button when given. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

/**
 * Data that could not be loaded right now (FREE ZONE): the holder list or the transactions of a
 * coin when the market data service is down (they have no on-chain fallback, and none on devnet).
 * Prices and trading keep working. Uses the theme's empty-state classes.
 */
export function DataUnavailable({
  title,
  body,
  onRetry,
  retryLabel,
  className,
}: DataUnavailableProps) {
  return (
    <div
      className={cn('launchpad-market-empty launchpad-data-unavailable', className)}
      role="status"
    >
      <span className="launchpad-empty-mark" aria-hidden="true">
        ↻
      </span>
      <p>{title}</p>
      <span>{body}</span>
      {onRetry ? (
        <button type="button" className="launchpad-hero-link" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export default DataUnavailable;
