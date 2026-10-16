import ky, { Options } from 'ky';
import {
  GetChartRequest,
  GetChartResponse,
  GetGemsTokenListIndividualResponse,
  GetGemsTokenListRequest,
  GetTokenDescriptionResponse,
  GetTokenRequest,
  GetTokenResponse,
  GetTopHoldersResponse,
  GetTxsRequest,
  GetTxsResponse,
} from '@/components/Explore/types';
import { serializeParams } from '@/lib/utils';
import {
  isListedLaunchpadCoin,
  listedConfigs,
  type ListedPoolEntry,
} from '../trade/launchpad-pool';

const BASE_URL = 'https://datapi.jup.ag';

type GemsTokenListResponse<T extends GetGemsTokenListRequest> = {
  [K in keyof T]: undefined extends T[K]
    ? GetGemsTokenListIndividualResponse | undefined
    : GetGemsTokenListIndividualResponse;
};

/**
 * The coin list request restricted to this launchpad's configs, whatever the caller asked:
 * every list of the site (and every coin card linking to a trade panel) shows this launchpad's
 * coins only. Null when there is no config to filter on (the API would list every coin).
 */
export function launchpadGemsRequest<T extends GetGemsTokenListRequest>(
  req: T,
  configs: readonly string[] = listedConfigs(),
): T | null {
  if (configs.length === 0) return null;
  const filtered: Record<string, unknown> = {};
  for (const [tab, value] of Object.entries(req)) {
    filtered[tab] = value ? { ...value, partnerConfigs: [...configs] } : value;
  }
  return filtered as T;
}

/**
 * The coin lists without the entries that are not this launchpad's coins: a pool someone created
 * on the launchpad coin config for another mint matches the config filter of the request, so it is
 * dropped here (`isListedLaunchpadCoin`).
 */
export function launchpadGemsResponse<T extends Record<string, unknown>>(response: T): T {
  if (!response || typeof response !== 'object') return response;
  const filtered: Record<string, unknown> = {};
  for (const [tab, value] of Object.entries(response)) {
    const pools = (value as { pools?: unknown } | undefined)?.pools;
    filtered[tab] = Array.isArray(pools)
      ? {
          ...(value as object),
          pools: (pools as ListedPoolEntry[]).filter((pool) => isListedLaunchpadCoin(pool)),
        }
      : value;
  }
  return filtered as T;
}

/**
 * A data stream message without the pool updates that are not this launchpad's coins (same rule as
 * the lists: the recent stream is subscribed on both configs). Other messages are unchanged.
 */
export function launchpadStreamMessage<M extends { type: string; data?: unknown }>(msg: M): M {
  if (!msg || msg.type !== 'updates' || !Array.isArray(msg.data)) return msg;
  const data = (msg.data as ({ pool?: ListedPoolEntry } | null)[]).filter((update) =>
    isListedLaunchpadCoin(update?.pool),
  );
  return { ...msg, data };
}

export class ApeClient {
  static async getGemsTokenList<T extends GetGemsTokenListRequest>(
    req: T,
    options?: Options,
  ): Promise<GemsTokenListResponse<T>> {
    const filtered = launchpadGemsRequest(req);
    if (!filtered) {
      // No launchpad config to filter on: empty lists, nothing requested.
      const empty: Record<string, GetGemsTokenListIndividualResponse | undefined> = {};
      for (const [tab, value] of Object.entries(req)) empty[tab] = value ? { pools: [] } : undefined;
      return empty as GemsTokenListResponse<T>;
    }
    const lists = await ky
      .post(`${BASE_URL}/v1/pools/gems`, {
        json: filtered,
        ...options,
      })
      .json<GemsTokenListResponse<T>>();
    return launchpadGemsResponse(lists);
  }
  static async getToken(req: GetTokenRequest, options?: Options): Promise<GetTokenResponse> {
    return ky
      .get(`${BASE_URL}/v1/pools`, {
        searchParams: serializeParams({
          assetIds: [req.id],
        }),
        ...options,
      })
      .json();
  }

  static async getTokenHolders(assetId: string, options?: Options): Promise<GetTopHoldersResponse> {
    return ky.get(`${BASE_URL}/v1/holders/${assetId}`, options).json();
  }

  static async getChart(
    assetId: string,
    params: GetChartRequest,
    options?: Options,
  ): Promise<GetChartResponse> {
    return ky
      .get(`${BASE_URL}/v2/charts/${assetId}`, {
        searchParams: serializeParams(params),
        ...options,
      })
      .json();
  }

  static async getTokenTxs(
    assetId: string,
    req: GetTxsRequest,
    options?: Options,
  ): Promise<GetTxsResponse> {
    return ky
      .get(`${BASE_URL}/v1/txs/${assetId}`, {
        searchParams: serializeParams(req),
        ...options,
      })
      .json();
  }

  static async getTokenDescription(
    assetId: string,
    options?: Options,
  ): Promise<GetTokenDescriptionResponse> {
    return ky.get(`${BASE_URL}/v1/assets/${assetId}/description`, options).json();
  }
}
