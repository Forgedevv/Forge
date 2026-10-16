import { TradePanel } from './TradePanel';

export interface CoinTradePanelProps {
  /** Coin mint address (base58), e.g. from the page URL. */
  mint: string;
  /** Ticker shown in labels (display only). */
  symbol?: string;
  /**
   * Decimals from the data API (Jupiter indexer): display fallback only, never used for an amount.
   * The trade form reads the decimals of the on-chain mint through the relay.
   */
  displayDecimals?: number;
  className?: string;
}

/**
 * LOCKED ZONE. Trade panel of a coin page. `TradePanel` derives the pool from the mint and this
 * launchpad's two configs (`launchpadConfig` for the coins of its users, `launchpadCoinConfig`
 * for its own coin), uses the one that exists on-chain (never a pool from the data API), then
 * routes the trade: the FORGE buy/sell form (0.3% platform fee) on the bonding curve, the Jupiter
 * plugin once the coin graduated.
 *
 * Without the on-chain configuration, or for a coin that is not on this launchpad, the panel says
 * so and nothing can be traded.
 */
export function CoinTradePanel({ mint, symbol, displayDecimals, className }: CoinTradePanelProps) {
  return (
    <TradePanel
      mint={mint}
      symbol={symbol}
      displayDecimals={saneDecimals(displayDecimals)}
      className={className}
    />
  );
}

/** SPL decimals from a data API: an integer between 0 and 9, otherwise the panel default. */
export function saneDecimals(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9
    ? value
    : undefined;
}

export default CoinTradePanel;
