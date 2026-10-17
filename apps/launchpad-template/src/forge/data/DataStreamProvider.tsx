import { ApeQueries, QueryData } from '@/components/Explore/queries';
import { atomMsgWithListeners } from '@/lib/jotai';
import { InfiniteData, useQueryClient } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StreamRequest, StreamResponse } from '@/contexts/TokenChart/msg';
import { delay } from '@/lib/utils';
import { listedConfigs } from '../trade/launchpad-pool';
import { launchpadStreamMessage } from './client';
import { noteSource, primarySource } from './source';

const WS_URL = 'wss://trench-stream.jup.ag/ws';

const RECONNECT_DELAY_MILLIS = 2_500;
/** Reconnection backoff ceiling while the stream stays unreachable. */
const MAX_RECONNECT_DELAY_MILLIS = 60_000;
/** A connection not open after this long counts as failed. */
const CONNECT_TIMEOUT_MILLIS = 10_000;
/** Failed connections in a row before the live data falls back to polling. */
export const FAILURES_BEFORE_POLLING = 2;
/** Polling interval of the fallback (paused while the tab is hidden). */
export const POLL_INTERVAL_MILLIS = 15_000;

/**
 * LOCKED ZONE. Live market data. On mainnet it comes from Jupiter's trench stream; when the stream
 * cannot be reached (`FAILURES_BEFORE_POLLING` failed connections in a row), and always on devnet
 * (Jupiter does not index it), the coin lists and coin info are polled instead every
 * `POLL_INTERVAL_MILLIS` while the tab is visible: their queries read the data API or, when it is
 * down, the chain (`source.ts`). The stream keeps reconnecting with a backoff and polling stops as
 * soon as it is back.
 */

/** True when the trench stream may be used (mainnet only). */
export function streamEnabled(): boolean {
  return primarySource() === 'jupiter';
}

/** The queries a poll refreshes: the coin lists and the coin info (data API shape keys). */
export function isPolledQuery(queryKey: readonly unknown[]): boolean {
  if (queryKey[0] !== 'explore') return false;
  return queryKey[1] === 'gems' || (queryKey[1] === 'token' && queryKey[3] === 'info');
}

/**
 * Calls `refresh` every `intervalMs` while `doc` is visible, and once when it becomes visible
 * again after at least `intervalMs`. Returns the stop function.
 */
export function startPolling(
  refresh: () => void,
  intervalMs = POLL_INTERVAL_MILLIS,
  doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  let last = Date.now();
  const tick = () => {
    if (doc.hidden) return;
    last = Date.now();
    refresh();
  };
  const timer = setInterval(tick, intervalMs);
  const onVisibility = () => {
    if (!doc.hidden && Date.now() - last >= intervalMs) tick();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

const [dataStreamMsgAtom, useDataStreamListener] = atomMsgWithListeners<StreamResponse | null>(
  null,
);
export { useDataStreamListener };

type DataStreamContextType = {
  subscribePools: (pools: string[]) => void;
  unsubscribePools: (pools: string[]) => void;
  subscribeRecentTokenList: () => void;
  unsubscribeRecentTokenList: () => void;
  subscribeTxns: (assets: string[]) => void;
  unsubscribeTxns: (assets: string[]) => void;
};

const DataStreamContext = createContext<DataStreamContextType | null>(null);

export const DataStreamProvider = ({ children }: { children: React.ReactNode }) => {
  const queryClient = useQueryClient();
  // This launchpad's configs only (never an empty filter: it would stream every new coin).
  const partnerConfigs = useMemo(() => listedConfigs(), []);
  const setDataStreamMsg = useSetAtom(dataStreamMsgAtom);

  const ws = useRef<WebSocket | null>(null);
  const shouldReconnect = useRef(true);
  const failures = useRef(0);
  const [polling, setPolling] = useState(() => !streamEnabled());
  const subRecentTokenList = useRef(false);
  const subPools = useRef<Set<string>>(new Set());
  const subTxnsAssets = useRef<Set<string>>(new Set());

  const subscribeRecentTokenList = useCallback(() => {
    if (partnerConfigs.length === 0) return;
    subRecentTokenList.current = true;

    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(
        createRequest({
          type: 'subscribe:recent',
          filters: {
            partnerConfigs,
          },
        }),
      );
    }
  }, [partnerConfigs]);

  const unsubscribeRecentTokenList = useCallback(() => {
    subRecentTokenList.current = false;

    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(createRequest({ type: 'unsubscribe:recent' }));
    }
  }, []);

  const subscribePools = useCallback((pools: string[]) => {
    for (const pool of pools) {
      subPools.current.add(pool);
    }

    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(createRequest({ type: 'subscribe:pool', pools: pools }));
    }
  }, []);

  const unsubscribePools = useCallback((pools: string[]) => {
    for (const pool of pools) {
      subPools.current.delete(pool);
    }
    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(createRequest({ type: 'unsubscribe:pool', pools: pools }));
    }
  }, []);

  const subscribeTxns = useCallback((assets: string[]) => {
    for (const asset of assets) {
      subTxnsAssets.current.add(asset);
    }
    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(createRequest({ type: 'subscribe:txns', assets: assets }));
    }
  }, []);

  const unsubscribeTxns = useCallback((assets: string[]) => {
    for (const asset of assets) {
      subTxnsAssets.current.delete(asset);
    }
    if (ws?.current?.readyState === WebSocket.OPEN) {
      ws.current.send(createRequest({ type: 'unsubscribe:txns', assets: assets }));
    }
  }, []);

  // const subscribePrices = useCallback((assets: string[]) => {
  //   for (const asset of assets) {
  //     subPricesAssets.current.add(asset);
  //     // TODO: refactor stream context to support decoupling this logic
  //     // Garbage collect unsubscribed asset prices
  //     assetPricesFamily.remove(asset);
  //   }
  //   if (ws?.current?.readyState === WebSocket.OPEN) {
  //     ws.current.send(createRequest({ type: 'subscribe:prices', assets: assets }));
  //   }
  // }, []);

  // const unsubscribePrices = useCallback((assets: string[]) => {
  //   for (const asset of assets) {
  //     subPricesAssets.current.delete(asset);
  //   }
  //   if (ws?.current?.readyState === WebSocket.OPEN) {
  //     ws.current.send(createRequest({ type: 'unsubscribe:prices', assets: assets }));
  //   }
  // }, []);

  const init = useCallback(() => {
    const initws = new WebSocket(WS_URL);
    ws.current = initws;
    let opened = false;
    const connectTimer = setTimeout(() => {
      if (!opened) initws.close();
    }, CONNECT_TIMEOUT_MILLIS);

    // Resubscribe to existing
    initws.onopen = () => {
      opened = true;
      clearTimeout(connectTimer);
      failures.current = 0;
      setPolling(false);
      noteSource('live updates', 'jupiter');
      if (subRecentTokenList.current) {
        subscribeRecentTokenList();
      }
      if (subPools.current) {
        subscribePools(Array.from(subPools.current));
      }
      if (subTxnsAssets.current) {
        subscribeTxns(Array.from(subTxnsAssets.current));
      }
      // if (subPricesAssets.current) {
      //   subscribePrices(Array.from(subPricesAssets.current));
      // }
    };

    initws.onmessage = (event) => {
      // Pool updates of look-alike coins (another mint on the launchpad coin config) are dropped.
      const msg: StreamResponse = launchpadStreamMessage(JSON.parse(event.data) as StreamResponse);

      setDataStreamMsg(msg);

      // We assume all actions are related to the subscribed token-tx-table
      if (msg.type === 'actions') {
        const tokenId = msg.data?.[0]?.asset;
        if (!tokenId) {
          return;
        }
        // Update token tx
        queryClient.setQueriesData(
          {
            type: 'active',
            queryKey: ApeQueries.tokenTxs({ id: tokenId }).queryKey,
          },
          (prev?: InfiniteData<QueryData<typeof ApeQueries.tokenTxs>>) => {
            if (!prev?.pages || prev.pages.length === 0) {
              return;
            }
            const firstPage = prev.pages[0];
            if (!firstPage) {
              return;
            }
            const next = firstPage.next;

            // Update first page data
            const firstPageTxs = firstPage ? [...firstPage.txs] : [];
            firstPageTxs.unshift(...msg.data);

            // Overwrite previous first page
            const newPages = prev.pages.slice(1);
            newPages.unshift({
              txs: firstPageTxs,
              next,
              args: { ...firstPage.args },
            });

            return {
              pages: newPages,
              pageParams: prev.pageParams,
            };
          },
        );
      }
    };

    initws.onerror = (err) => {
      console.error('WebSocket error:', err);
      initws.close();
    };

    initws.onclose = async () => {
      clearTimeout(connectTimer);
      if (!shouldReconnect.current) return;
      if (!opened) {
        failures.current += 1;
        if (failures.current >= FAILURES_BEFORE_POLLING) {
          setPolling(true);
          noteSource('live updates', 'chain', 'stream unreachable, polling');
        }
      }
      const backoff = Math.min(
        MAX_RECONNECT_DELAY_MILLIS,
        RECONNECT_DELAY_MILLIS * 2 ** Math.max(0, failures.current - 1),
      );
      await delay(backoff);
      if (!shouldReconnect.current) return;
      init();
    };
  }, [queryClient, setDataStreamMsg, subscribePools, subscribeRecentTokenList, subscribeTxns]);

  useEffect(() => {
    // Devnet: no stream (Jupiter does not index it), polling only.
    if (!streamEnabled()) {
      noteSource('live updates', 'chain', 'devnet, polling');
      return;
    }
    shouldReconnect.current = true;
    init();
    return () => {
      shouldReconnect.current = false;
      ws.current?.close();
    };
  }, [init]);

  // Polling fallback: refresh the coin lists and coin info while the stream is unavailable.
  useEffect(() => {
    if (!polling) return;
    return startPolling(() => {
      void queryClient.invalidateQueries({ predicate: (query) => isPolledQuery(query.queryKey) });
    });
  }, [polling, queryClient]);

  return (
    <DataStreamContext.Provider
      value={{
        subscribePools,
        unsubscribePools,
        subscribeRecentTokenList,
        unsubscribeRecentTokenList,
        subscribeTxns,
        unsubscribeTxns,
      }}
    >
      {children}
    </DataStreamContext.Provider>
  );
};

export const useDataStream = () => {
  const context = useContext(DataStreamContext);
  if (!context) {
    throw new Error('useDataStream must be used within DataStreamProvider');
  }
  return context;
};

function createRequest(req: StreamRequest): string {
  return JSON.stringify({ ...req });
}
