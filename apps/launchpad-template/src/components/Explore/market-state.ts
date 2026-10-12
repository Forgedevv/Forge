import type { ExploreTab } from './types';

type TokenLists = Partial<Record<ExploreTab, { pools?: readonly unknown[] } | undefined>>;

/**
 * True when the market has loaded and every list is empty (a new launchpad on day one). The home
 * page then shows one compact empty panel instead of three empty columns.
 */
export function isMarketEmpty(status: string, data: TokenLists | undefined): boolean {
  if (status !== 'success' || !data) return false;
  const lists = [data.recent, data.aboutToGraduate, data.graduated];
  return lists.every((list) => (list?.pools?.length ?? 0) === 0);
}
