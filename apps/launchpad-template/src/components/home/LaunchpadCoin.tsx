import Link from 'next/link';
import { content } from '@/content';
import { onchainConfig } from '@/forge/config';
import { cn } from '@/lib/utils';

/**
 * Highlight of the launchpad's own coin (FREE ZONE, presentational). The coin page link appears
 * once FORGE has written the coin into `forge.config.json#onchain`; before that (preview), a note
 * says trading opens at launch. Copy: `content.launchpadCoin`.
 */
export function LaunchpadCoin({ className }: { className?: string }) {
  const copy = content.launchpadCoin;
  const mint = onchainConfig?.launchpadCoinMint;
  const ticker = copy.symbol ? `$${copy.symbol}` : '';
  return (
    <section
      className={cn('launchpad-section launchpad-coin', className)}
      aria-labelledby="launchpad-coin-title"
    >
      <div className="launchpad-coin-card">
        <div className="launchpad-coin-badge" aria-hidden="true">
          <span>{(copy.symbol || content.name).slice(0, 1)}</span>
        </div>
        <div className="launchpad-coin-copy">
          <p className="launchpad-eyebrow">{copy.eyebrow}</p>
          <h2 id="launchpad-coin-title">
            {copy.name}
            {ticker ? <span className="launchpad-coin-ticker">{ticker}</span> : null}
          </h2>
          <p className="launchpad-coin-description">{copy.description}</p>
        </div>
        <div className="launchpad-coin-action">
          {mint ? (
            <Link
              href={`/token/${encodeURIComponent(mint)}`}
              className="launchpad-button launchpad-button-primary"
            >
              {copy.tradeAction}
              <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            <p className="launchpad-coin-pending">{copy.pendingNote}</p>
          )}
        </div>
      </div>
    </section>
  );
}

export default LaunchpadCoin;
