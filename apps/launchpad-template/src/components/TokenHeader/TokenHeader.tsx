import { useMinimalTokenInfo, useTokenInfo } from '@/hooks/queries';
import { cn } from '@/lib/utils';
import { memo } from 'react';
import { getNumberColorCn, ReadableNumber } from '../ui/ReadableNumber';
import { formatReadablePercentChange } from '@/lib/format/number';
import { Copyable } from '../ui/Copyable';
import { TruncatedAddress } from '../TruncatedAddress/TruncatedAddress';
import CopyIconSVG from '@/icons/CopyIconSVG';
import { TrenchesTokenIcon, TrenchesTokenIconImage } from '@/forge/token-icon';
import { Skeleton } from '../ui/Skeleton';

type TokenHeaderProps = {
  className?: string;
};

export const TokenHeader: React.FC<TokenHeaderProps> = memo(({ className }) => {
  const { data: pool, isLoading } = useTokenInfo();
  const { data: minimalTokenInfo } = useMinimalTokenInfo();
  const name = pool?.baseAsset.name;
  const symbol = pool?.baseAsset.symbol;

  const pctChange =
    pool?.baseAsset.stats24h?.priceChange === undefined
      ? undefined
      : pool.baseAsset.stats24h.priceChange / 100;

  return (
    <div className={cn('flex items-center overflow-hidden w-full', className)}>
      <div className="relative mr-2 flex shrink-0 items-center rounded-lg bg-neutral-850">
        <TrenchesTokenIcon className="rounded-lg" token={minimalTokenInfo}>
          <TrenchesTokenIconImage className="rounded-lg" />
        </TrenchesTokenIcon>
      </div>

      <div className="flex flex-1 justify-between gap-2.5 overflow-hidden">
        <div className="flex min-w-0 flex-col justify-center gap-0.5">
          {name || symbol ? (
            <h1 className="flex min-w-0 items-baseline gap-1.5 leading-none tracking-tight">
              <span className="truncate font-medium">{name || symbol}</span>
              {name && symbol && symbol !== name ? (
                <span className="shrink-0 text-sm text-neutral-500">{symbol}</span>
              ) : null}
            </h1>
          ) : isLoading ? (
            <Skeleton className="h-4 w-28" data-testid="token-header-name-loading" />
          ) : null}

          {minimalTokenInfo && (
            <Copyable
              name="Address"
              copyText={minimalTokenInfo.address}
              className={cn(
                'flex min-w-0 items-center gap-0.5 text-sm text-neutral-500 duration-500 hover:text-neutral-200',
              )}
            >
              {(copied) => (
                <>
                  <TruncatedAddress
                    className={cn(
                      'min-w-0 overflow-hidden text-clip whitespace-nowrap leading-none tracking-tight',
                      {
                        'text-primary': copied,
                      },
                    )}
                    address={minimalTokenInfo.address}
                  />
                  {copied ? (
                    <span className="iconify shrink-0 text-primary ph--check-bold" />
                  ) : (
                    <CopyIconSVG className="shrink-0" width={11} height={11} />
                  )}
                </>
              )}
            </Copyable>
          )}
        </div>

        <div className={cn('flex flex-col items-end justify-center gap-0.5', className)}>
          <ReadableNumber
            className="leading-none tracking-tight font-semibold"
            format="price"
            num={pool?.baseAsset.usdPrice}
            prefix="$"
            animated
            showDirection
          />
          <div className={cn('text-xs leading-none font-semibold', getNumberColorCn(pctChange))}>
            {formatReadablePercentChange(pctChange, { hideSign: 'positive' })}
          </div>
        </div>
      </div>
    </div>
  );
});

TokenHeader.displayName = 'TokenHeader';
