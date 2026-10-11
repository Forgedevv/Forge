import { TokenPageMsgHandler } from '@/components/Token/TokenPageMsgHandler';
import { TokenChart } from '@/forge/chart/TokenChart';
import { TokenDetails } from '@/components/TokenHeader/TokenDetail';
import { TokenHeader } from '@/components/TokenHeader/TokenHeader';
import { TokenStats } from '@/components/TokenHeader/TokenStats';
import { TokenBottomPanel } from '@/components/TokenTable';
import Page from '@/components/ui/Page/Page';
import { DataStreamProvider, useDataStream } from '@/forge/data/DataStreamProvider';
import { TokenChartProvider } from '@/contexts/TokenChartProvider';
import { useTokenAddress, useTokenInfo } from '@/hooks/queries';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import Link from 'next/link';
import { content } from '@/content';

// FORGE trade panel: FORGE buy/sell (0.3% platform fee) before graduation, Jupiter after.
const CoinTradePanel = dynamic(() => import('@/forge/CoinTradePanel'), { ssr: false });

const SwapWidget = () => {
  const tokenId = useTokenAddress();
  const { data: baseAsset } = useTokenInfo((data) => data?.baseAsset);

  if (!tokenId) {
    return null;
  }

  return (
    <CoinTradePanel mint={tokenId} symbol={baseAsset?.symbol} tokenDecimals={baseAsset?.decimals} />
  );
};

export const TokenPageWithContext = () => {
  const tokenId = useTokenAddress();
  const { data: poolId } = useTokenInfo((data) => data?.id);
  const { subscribeTxns, unsubscribeTxns, subscribePools, unsubscribePools } = useDataStream();

  // Subscribe to token txns
  useEffect(() => {
    if (!tokenId) {
      return;
    }
    subscribeTxns([tokenId]);
    return () => {
      unsubscribeTxns([tokenId]);
    };
  }, [tokenId, subscribeTxns, unsubscribeTxns]);

  useEffect(() => {
    if (!poolId) {
      return;
    }

    subscribePools([poolId]);
    return () => {
      unsubscribePools([poolId]);
    };
    // dont track tokenId to prevent data mismatch
  }, [poolId, subscribePools, unsubscribePools]);

  return (
    <Page>
      <TokenPageMsgHandler />

      <div className="launchpad-token-page">
        <Link href="/#markets" className="launchpad-token-back"><span aria-hidden="true">←</span>{content.strings.backToMarket}</Link>
        <div className="launchpad-token-heading">
          <TokenHeader className="max-sm:order-1" />
        </div>

        <div className="launchpad-token-grid">
          <div className="launchpad-token-main">
            <div className="launchpad-token-stats">
              <TokenStats key={`token-stats-${poolId}`} />
            </div>

            <div className="launchpad-token-chart flex flex-col">
              <TokenChartProvider>
                <TokenChart />
              </TokenChartProvider>
            </div>

            <TokenBottomPanel className="launchpad-token-tables flex flex-col overflow-hidden" />
          </div>
          <aside className="launchpad-token-trade">
            <SwapWidget />
            <TokenDetails />
          </aside>
        </div>
      </div>
    </Page>
  );
};

export default function TokenPage() {
  return (
    <DataStreamProvider>
      <TokenPageWithContext />
    </DataStreamProvider>
  );
}
