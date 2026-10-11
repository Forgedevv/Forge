import ExploreGrid from './ExploreGrid';
import { DataStreamProvider } from '@/forge/data/DataStreamProvider';
import { ExploreMsgHandler } from './ExploreMsgHandler';
import { ExploreProvider } from '@/contexts/ExploreProvider';
import { PropsWithChildren } from 'react';
import Link from 'next/link';
import { content } from '@/content';
import { MintSculpture } from '../MintSculpture';

const Explore = () => {
  return (
    <ExploreContext>
      <ExploreGrid className="flex-1" />
    </ExploreContext>
  );
};

const ExploreContext = ({ children }: PropsWithChildren) => {
  return (
    <div className="launchpad-home flex flex-1 flex-col">
      <ExploreMsgHandler />

      <ExploreProvider>
        <DataStreamProvider>
          <section className="launchpad-hero" aria-labelledby="launchpad-home-title">
            <div className="launchpad-hero-copy">
              <p className="launchpad-eyebrow">{content.strings.homeEyebrow}</p>
              <h1 id="launchpad-home-title">{content.name}<span className="launchpad-title-period">.</span></h1>
              <p className="launchpad-hero-tagline">{content.tagline}</p>
              <div className="launchpad-hero-actions">
                <Link href="/create-pool" className="launchpad-hero-create">
                  {content.strings.createCoin}<span aria-hidden="true">↗</span>
                </Link>
                <Link href="#markets" className="launchpad-hero-link">
                  {content.strings.homeAction}<span aria-hidden="true">↓</span>
                </Link>
              </div>
            </div>
            <MintSculpture monogram={content.name.slice(0, 1)} />
          </section>
          <section className="launchpad-market" id="markets" aria-labelledby="launchpad-market-title">
            <header className="launchpad-market-heading">
              <p className="launchpad-eyebrow">{content.strings.marketEyebrow}</p>
              <h2 id="launchpad-market-title">{content.strings.marketTitle}</h2>
              <span className="launchpad-market-network"><i aria-hidden="true" />{content.strings.network}</span>
            </header>
            {children}
          </section>
        </DataStreamProvider>
      </ExploreProvider>
    </div>
  );
};

export default Explore;
