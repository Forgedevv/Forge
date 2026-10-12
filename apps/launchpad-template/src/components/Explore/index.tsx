import ExploreGrid from './ExploreGrid';
import { DataStreamProvider } from '@/forge/data/DataStreamProvider';
import { ExploreMsgHandler } from './ExploreMsgHandler';
import { ExploreProvider } from '@/contexts/ExploreProvider';
import { PropsWithChildren, ReactNode } from 'react';
import { content } from '@/content';
import { cn } from '@/lib/utils';

type ExploreProps = {
  className?: string;
  /** Optional replacement for the default market heading. */
  heading?: ReactNode;
};

/**
 * The market (FREE ZONE layout around the FORGE data stream): live coin lists of this launchpad.
 * On day one, when no coin exists yet, the grid shows one compact panel (`MarketEmpty`). The home
 * page composes it with the other sections; keep the `markets` id (links point to `/#markets`).
 */
const Explore = ({ className, heading }: ExploreProps) => {
  return (
    <ExploreContext className={className} heading={heading}>
      <ExploreGrid className="flex-1" />
    </ExploreContext>
  );
};

const ExploreContext = ({ children, className, heading }: PropsWithChildren<ExploreProps>) => {
  return (
    <>
      <ExploreMsgHandler />
      <ExploreProvider>
        <DataStreamProvider>
          <section
            className={cn('launchpad-market', className)}
            id="markets"
            aria-labelledby="launchpad-market-title"
          >
            {heading ?? (
              <header className="launchpad-market-heading">
                <p className="launchpad-eyebrow">{content.strings.marketEyebrow}</p>
                <h2 id="launchpad-market-title">{content.strings.marketTitle}</h2>
                <span className="launchpad-market-network">
                  <i aria-hidden="true" />
                  {content.strings.network}
                </span>
              </header>
            )}
            {children}
          </section>
        </DataStreamProvider>
      </ExploreProvider>
    </>
  );
};

export default Explore;
