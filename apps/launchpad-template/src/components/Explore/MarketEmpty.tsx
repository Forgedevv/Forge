import Link from 'next/link';
import { content } from '@/content';

/**
 * Day-one market (FREE ZONE): shown instead of the three columns while the launchpad has no coin
 * yet. Compact on purpose: it explains what the market will hold and invites the first launch.
 */
export function MarketEmpty() {
  const copy = content.market.empty;
  return (
    <div className="launchpad-market-day-one" role="status">
      <div className="launchpad-market-day-one-copy">
        <p className="launchpad-market-day-one-title">{copy.title}</p>
        <p className="launchpad-market-day-one-body">{copy.body}</p>
        <Link href="/create-pool" className="launchpad-button launchpad-button-primary">
          {copy.action}
          <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <ol className="launchpad-market-day-one-stages" aria-label={copy.stagesLabel}>
        {copy.stages.map((stage, index) => (
          <li key={stage.title}>
            <span className="launchpad-market-day-one-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="launchpad-market-day-one-stage">{stage.title}</span>
            <span className="launchpad-market-day-one-hint">{stage.body}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default MarketEmpty;
