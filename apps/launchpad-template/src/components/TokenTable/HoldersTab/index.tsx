import { memo } from 'react';

import { HolderCount } from './HolderCount';
import { TopHolderCount } from './TopHolderCount';
import { HolderContentTable } from './HolderContent';
import { DataUnavailable } from '../../ui/DataUnavailable';
import { useHolders } from '@/hooks/queries';
import { content } from '@/content';
import { cluster } from '@/forge/config';

export const HoldersTab: React.FC = memo(() => {
  const { data, isError, refetch } = useHolders();
  // Jupiter does not index devnet: there is never a holder list to load there.
  const devnet = cluster === 'devnet';

  // Devnet: nothing to retry, the holder list never exists there.
  if (devnet) {
    return (
      <DataUnavailable
        title={content.strings.devnetHolders}
        body={content.strings.devnetHoldersBody}
      />
    );
  }

  // The market data service is down: no holder list to show.
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
