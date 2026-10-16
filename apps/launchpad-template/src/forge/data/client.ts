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
import { listedConfigs } from '../trade/launchpad-pool';

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
    return ky
      .post(`${BASE_URL}/v1/pools/gems`, {
        json: filtered,
        ...options,
      })
      .json();
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
