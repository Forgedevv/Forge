import { formatBps, formatUnits } from './amounts';
import { PLATFORM_FEE_BPS, PRICE_IMPACT_WARN_BPS, SOL_DECIMALS } from './constants';
import { TRADE_TEXT } from './copy';
import type { SwapQuote } from './core-adapter';
import type { NetworkFeeEstimate } from './useWalletBalances';

export interface QuoteSummaryProps {
  quote: SwapQuote;
  symbol: string;
  tokenDecimals: number;
  networkFee: NetworkFeeEstimate;
}

const TEXT = TRADE_TEXT.quote;

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
      <dt className="min-w-0 text-[var(--color-text-muted)]">{label}</dt>
      <dd className={`text-right tabular-nums ${warn ? 'text-[var(--color-danger)]' : ''}`}>
        {value}
      </dd>
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
    <dl
      className="flex flex-col gap-1.5 text-sm"
      data-testid="quote-summary"
      aria-label={TEXT.label}
    >
      {isBuy ? (
        <>
          <Row id="pay" label={TEXT.youPay} value={sol(quote.amountIn, 6)} />
          <Row id="out" label={TEXT.youReceive} value={token(quote.amountOut)} emphasis />
          <Row id="min" label={TEXT.minimumReceived} value={token(quote.minAmountOut)} />
        </>
      ) : (
        <>
          <Row id="pay" label={TEXT.youSell} value={token(quote.amountIn)} />
          <Row id="out" label={TEXT.proceeds} value={sol(quote.amountOut, 6)} emphasis />
          <Row id="min" label={TEXT.minimumProceeds} value={sol(quote.minAmountOut, 6)} />
        </>
      )}
      <Row id="impact" label={TEXT.priceImpact} value={impact} warn={impactWarn} />
      <Row id="trading-fee" label={TEXT.tradingFee} value={sol(quote.tradingFee)} />
      <Row
        id="platform-fee"
        label={TEXT.platformFee(formatBps(PLATFORM_FEE_BPS))}
        value={sol(quote.platformFee)}
      />
      <Row id="network-fee" label={TEXT.networkFee} value={sol(networkFee.base)} />
      <Row id="priority-fee" label={TEXT.priorityFee} value={sol(networkFee.maxPriorityFee)} />
      {networkFee.accountRent > BigInt(0) ? (
        <Row id="account-rent" label={TEXT.accountRent} value={sol(networkFee.accountRent)} />
      ) : null}
      {isBuy ? (
        <Row
          id="total"
          label={TEXT.totalBuy}
          value={sol(quote.amountIn + quote.platformFee + networkFee.total, 9)}
          emphasis
        />
      ) : (
        <Row
          id="total"
          label={TEXT.totalSell}
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
