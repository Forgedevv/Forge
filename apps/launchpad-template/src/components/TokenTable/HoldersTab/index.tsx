import { memo } from 'react';

import { HolderCount } from './HolderCount';
import { TopHolderCount } from './TopHolderCount';
import { HolderContentTable } from './HolderContent';
import { DataUnavailable } from '../../ui/DataUnavailable';
import { useHolders } from '@/hooks/queries';
import { content } from '@/content';

export const HoldersTab: React.FC = memo(() => {
  const { data, isError, refetch } = useHolders();

  // The market data service is down (or the site runs on devnet): no holder list to show.
  if (isError && !data) {
    return (
      <DataUnavailable
        title={content.strings.unavailableHolders}
        body={content.strings.unavailableHoldersBody}
        retryLabel={content.strings.retry}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-neutral-850 p-1 text-xs">
        <HoldersSummary />
      </div>
      <HolderContentTable />
    </>
  );
});

HoldersTab.displayName = 'HoldersTab';

const HoldersSummary: React.FC = () => {
  return (
    <div className="flex items-center gap-2 pl-1">
      <div>
        <span className="text-neutral-500">Holders:</span> <HolderCount />
      </div>
      <div>
        <span className="text-neutral-500">Top 10 holders:</span> <TopHolderCount />
      </div>
    </div>
  );
};
