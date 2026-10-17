// @vitest-environment jsdom
import '../helpers/dom-setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cluster: 'mainnet-beta',
  holders: { data: undefined as unknown, isError: false, refetch: vi.fn() },
  getTokenTxs: vi.fn(),
}));

vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Moon Pad',
    slug: 'moon-pad',
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'About the moon.' },
    mode: 'live',
  },
  onchainConfig: undefined,
  get cluster() {
    return h.cluster;
  },
}));
vi.mock('@/hooks/queries', () => ({
  useTokenAddress: () => 'So11111111111111111111111111111111111111112',
  useTokenInfo: (select?: (pool: unknown) => unknown) => {
    const pool = { baseAsset: { symbol: 'MOON' } };
    return { data: select ? select(pool) : pool, isError: false, refetch: vi.fn() };
  },
  useHolders: () => h.holders,
}));
vi.mock('@jup-ag/wallet-adapter', () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock('@/forge/data/client', () => ({
  ApeClient: { getTokenTxs: h.getTokenTxs },
}));
vi.mock('@/contexts/TokenChartProvider', () => ({
  useTokenChart: () => {
    const ref = () => ({ current: undefined });
    return {
      resolutionRef: ref(),
      chartTypeRef: ref(),
      showDevTradesRef: ref(),
      showUserTradesRef: ref(),
      baseAssetRef: ref(),
      resolutionToMostRecentBarRef: { current: {} },
      onNewMarksRef: ref(),
      onNewSwapTxsRef: ref(),
      userAddressRef: ref(),
    };
  },
}));

import { content } from '@/content';
import { DataUnavailable } from '@/components/ui/DataUnavailable';
import { HoldersTab } from '@/components/TokenTable/HoldersTab';
import { TxnsTab } from '@/components/TokenTable/TxnsTab';
import { retryQuery } from '@/forge/AppProviders';
import { CHART_UNAVAILABLE_COPY, ChartUnavailable } from '@/forge/chart/ChartUnavailable';
import { TokenChart } from '@/forge/chart/TokenChart';
import { DataUnavailableError } from '@/forge/data/source';

function withQueries(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: retryQuery } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  h.cluster = 'mainnet-beta';
  h.holders = { data: undefined, isError: false, refetch: vi.fn() };
  h.getTokenTxs.mockReset();
});

describe('query retry policy', () => {
  it('does not retry unavailable coin data, retries anything else up to 3 times', () => {
    expect(retryQuery(0, new DataUnavailableError())).toBe(false);
    expect(retryQuery(0, new Error('boom'))).toBe(true);
    expect(retryQuery(3, new Error('boom'))).toBe(false);
  });
});

describe('unavailable states', () => {
  it('DataUnavailable shows its copy and a retry button', () => {
    const onRetry = vi.fn();
    render(<DataUnavailable title="Down" body="Try later" onRetry={onRetry} retryLabel="Retry" />);
    expect(screen.getByRole('status')).toHaveTextContent('Down');
    expect(screen.getByRole('status')).toHaveTextContent('Try later');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('the holders tab shows the unavailable state when the holders cannot be loaded', () => {
    h.holders = { data: undefined, isError: true, refetch: vi.fn() };
    render(<HoldersTab />);
    expect(screen.getByRole('status')).toHaveTextContent(content.strings.unavailableHolders);
    fireEvent.click(screen.getByRole('button', { name: content.strings.retry }));
    expect(h.holders.refetch).toHaveBeenCalled();
  });

  it('the transactions tab shows the unavailable state when the data API is down', async () => {
    h.getTokenTxs.mockRejectedValue(new DataUnavailableError());
    withQueries(<TxnsTab />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(content.strings.unavailableTxns),
    );
    // Not retried at once (DataUnavailableError).
    expect(h.getTokenTxs).toHaveBeenCalledTimes(1);
  });

  it('on devnet, the holders and transactions tabs say why, with no retry and no data call', async () => {
    h.cluster = 'devnet';
    h.holders = { data: undefined, isError: true, refetch: vi.fn() };
    const { unmount } = render(<HoldersTab />);
    expect(screen.getByRole('status')).toHaveTextContent(content.strings.devnetHolders);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    h.getTokenTxs.mockRejectedValue(new DataUnavailableError());
    withQueries(<TxnsTab />);
    expect(screen.getByRole('status')).toHaveTextContent(content.strings.devnetTxns);
    expect(screen.queryByRole('button')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.getTokenTxs).not.toHaveBeenCalled();
  });

  it('the chart panel has a retry on mainnet and none on devnet', () => {
    const onRetry = vi.fn();
    const { unmount } = render(<ChartUnavailable onRetry={onRetry} />);
    expect(screen.getByTestId('chart-unavailable')).toHaveTextContent(
      CHART_UNAVAILABLE_COPY.unavailable.title,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalled();
    unmount();
    render(<ChartUnavailable devnet onRetry={onRetry} />);
    expect(screen.getByTestId('chart-unavailable')).toHaveTextContent(
      CHART_UNAVAILABLE_COPY.devnet.title,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the chart never loads the charting library on devnet', () => {
    h.cluster = 'devnet';
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const appendChild = vi.spyOn(document.head, 'appendChild');
    withQueries(<TokenChart renderingId="test" />);
    expect(screen.getByTestId('chart-unavailable')).toHaveTextContent(
      CHART_UNAVAILABLE_COPY.devnet.title,
    );
    expect(appendChild).not.toHaveBeenCalled();
  });
});
