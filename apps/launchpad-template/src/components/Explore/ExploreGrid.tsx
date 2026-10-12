import { useDataStream } from '@/forge/data/DataStreamProvider';
import { useEffect } from 'react';
import { ExploreTab } from './types';
import { ExploreColumn } from './ExploreColumn';
import { cn } from '@/lib/utils';
import { MobileExploreTabs } from './MobileExploreTabs';
import { useExplore } from '@/contexts/ExploreProvider';
import { useBreakpoint } from '@/lib/device';
import { useExploreGemsTokenList } from '@/hooks/useExploreGemsTokenList';
import { isMarketEmpty } from './market-state';
import { MarketEmpty } from './MarketEmpty';

type ExploreGridProps = {
  className?: string;
};

const ExploreGrid = ({ className }: ExploreGridProps) => {
  const { subscribeRecentTokenList, unsubscribeRecentTokenList } = useDataStream();
  const { mobileTab } = useExplore();
  const breakpoint = useBreakpoint();

  useEffect(() => {
    subscribeRecentTokenList();
    return () => {
      unsubscribeRecentTokenList();
    };
  }, [subscribeRecentTokenList, unsubscribeRecentTokenList]);

  const { data, status } = useExploreGemsTokenList();

  const isMobile = breakpoint === 'md' || breakpoint === 'sm' || breakpoint === 'xs';

  // Day one: no coin in any list yet. One compact panel instead of three empty columns.
  if (isMarketEmpty(status, data)) {
    return (
      <div className={cn('launchpad-market-grid launchpad-market-grid-empty', className)}>
        <MarketEmpty />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'launchpad-market-grid grid grid-cols-1 border-neutral-850 lg:grid-cols-3 lg:border lg:rounded-xl',
        className,
      )}
    >
      <MobileExploreTabs />

      <div className="contents divide-x divide-neutral-850">
        <ExploreColumn tab={isMobile ? mobileTab : ExploreTab.NEW} />
        {!isMobile && <ExploreColumn tab={ExploreTab.GRADUATING} />}
        {!isMobile && <ExploreColumn tab={ExploreTab.GRADUATED} />}
      </div>
    </div>
  );
};

export default ExploreGrid;
