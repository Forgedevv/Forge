import { formatBps, formatUnits } from './amounts';
import { PLATFORM_FEE_BPS, PRICE_IMPACT_WARN_BPS, SOL_DECIMALS } from './constants';
import type { SwapQuote } from './core-adapter';
import type { NetworkFeeEstimate } from './useWalletBalances';

export interface QuoteSummaryProps {
  quote: SwapQuote;
  symbol: string;
  tokenDecimals: number;
  networkFee: NetworkFeeEstimate;
}

const sol = (raw: bigint, digits = 9) => `${formatUnits(raw, SOL_DECIMALS, digits)} SOL`;

function Row({
  id,
  label,
  value,
  emphasis,
  warn,
}: {
  id: string;
  label: string;
  value: string;
  emphasis?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${emphasis ? 'font-semibold' : ''}`}
      data-testid={`quote-row-${id}`}
    >
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className={warn ? 'text-[var(--color-danger)]' : ''}>{value}</dd>
    </div>
  );
}

/**
 * Everything the user must see BEFORE signing: expected output, price impact, the pool trading
 * fee, the FORGE platform fee (explicitly, with its rate), the network fee estimate, the most the
 * priority fee can be, and the total (with that maximum).
 */
export function QuoteSummary({ quote, symbol, tokenDecimals, networkFee }: QuoteSummaryProps) {
  const impactWarn = quote.priceImpactBps >= PRICE_IMPACT_WARN_BPS;
  const impact = `${formatBps(quote.priceImpactBps)}`;
  const token = (raw: bigint) => `${formatUnits(raw, tokenDecimals, 6)} ${symbol}`;
  const isBuy = quote.side === 'buy';

  return (
    <dl className="flex flex-col gap-1.5 text-sm" data-testid="quote-summary" aria-label="Quote">
      {isBuy ? (
        <>
          <Row id="pay" label="You pay" value={sol(quote.amountIn, 6)} />
          <Row id="out" label="You receive (estimated)" value={token(quote.amountOut)} emphasis />
          <Row id="min" label="Minimum received" value={token(quote.minAmountOut)} />
        </>
      ) : (
        <>
          <Row id="pay" label="You sell" value={token(quote.amountIn)} />
          <Row id="out" label="Proceeds (estimated)" value={sol(quote.amountOut, 6)} emphasis />
          <Row id="min" label="Minimum proceeds" value={sol(quote.minAmountOut, 6)} />
        </>
      )}
      <Row id="impact" label="Price impact" value={impact} warn={impactWarn} />
      <Row id="trading-fee" label="Trading fee (pool)" value={sol(quote.tradingFee)} />
      <Row
        id="platform-fee"
        label={`FORGE platform fee (${formatBps(PLATFORM_FEE_BPS)})`}
        value={sol(quote.platformFee)}
      />
      <Row id="network-fee" label="Network fee (estimate)" value={sol(networkFee.base)} />
      <Row
        id="priority-fee"
        label="Priority fee (at most)"
        value={sol(networkFee.maxPriorityFee)}
      />
      {networkFee.accountRent > BigInt(0) ? (
        <Row
          id="account-rent"
          label="Token account deposit (one time)"
          value={sol(networkFee.accountRent)}
        />
      ) : null}
      {isBuy ? (
        <Row
          id="total"
          label="Total from your wallet (at most)"
          value={sol(quote.amountIn + quote.platformFee + networkFee.total, 9)}
          emphasis
        />
      ) : (
        <Row
          id="total"
          label="Estimated SOL you keep"
          value={sol(
            quote.amountOut > quote.platformFee + networkFee.base + networkFee.maxPriorityFee
              ? quote.amountOut - quote.platformFee - networkFee.base - networkFee.maxPriorityFee
              : BigInt(0),
            9,
          )}
          emphasis
        />
      )}
    </dl>
  );
}
