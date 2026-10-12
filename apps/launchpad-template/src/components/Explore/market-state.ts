import { ExploreTab } from './types';

type TokenLists = Partial<Record<ExploreTab, { pools?: readonly unknown[] } | undefined>>;

const TABS: readonly ExploreTab[] = [ExploreTab.NEW, ExploreTab.GRADUATING, ExploreTab.GRADUATED];

/**
 * True when the market has loaded and every list is empty (a new launchpad on day one). The home
 * page then shows one compact empty panel instead of three empty columns.
 */
export function isMarketEmpty(status: string, data: TokenLists | undefined): boolean {
  if (status !== 'success' || !data) return false;
  return TABS.every((tab) => (data[tab]?.pools?.length ?? 0) === 0);
}
