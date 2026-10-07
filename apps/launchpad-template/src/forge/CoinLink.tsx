import type { ReactNode } from 'react';
import { onchainConfig } from './config';

/**
 * LOCKED ZONE. Link to the launchpad coin on Jupiter. Used by the static sleeping page, which
 * must not load any data. Renders nothing while the on-chain setup is not done.
 */
export function CoinLink({ className, children }: { className?: string; children: ReactNode }) {
  const mint = onchainConfig?.launchpadCoinMint;
  if (!mint) return null;
  return (
    <a
      className={className}
      href={`https://jup.ag/tokens/${encodeURIComponent(mint)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
