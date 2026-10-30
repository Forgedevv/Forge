import React, { useEffect, useRef, useState } from 'react';

import styles from './index.module.css';
import { useTokenAddress, useTokenInfo } from '@/hooks/queries';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ApeQueries } from '../Explore/queries';
import { content } from '@/content';
import { CoinXLink, hasCoinXLink } from '@/forge/CoinXLink';
import XIcon from '@/icons/XIcon';

type TokenDescriptionProps = {
  className?: string;
};

export function useTokenDescription() {
  const address = useTokenAddress();
  return useQuery({
    ...ApeQueries.tokenDescription({ id: address || '' }),
    enabled: !!address,
  });
}

export const TokenDescription: React.FC<TokenDescriptionProps> = ({ className }) => {
  const { data: baseAsset } = useTokenInfo((data) => data.baseAsset);
  const { data, status } = useTokenDescription();

  const description = status === 'loading' ? undefined : data?.description;
  const hasX = hasCoinXLink(baseAsset?.twitter);
  if (!description && !hasX) {
    return null;
  }

  return (
    <div className={cn('flex flex-col gap-2 p-2.5', styles.animateIn, className)}>
      <h2 className="text-sm font-semibold">About {baseAsset?.name}</h2>

      {description && <Description description={description} />}

      <CoinXLink
        url={baseAsset?.twitter}
        title={content.strings.coinOnX}
        className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-neutral-400 hover:text-primary"
      >
        {(handle) => (
          <>
            <XIcon aria-hidden="true" width={12} height={12} />
            <span>@{handle}</span>
          </>
        )}
      </CoinXLink>
    </div>
  );
};

const Description: React.FC<{ description: string }> = ({ description }) => {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const checkOverflow = () => {
      const element = contentRef.current;
      if (element) {
        setHasOverflow(element.scrollHeight > element.clientHeight);
      }
    };

    checkOverflow();

    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [description]);

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div
        ref={contentRef}
        className={cn('text-neutral-500 [overflow-wrap:anywhere]', {
          'line-clamp-3': !expanded,
          'whitespace-pre-wrap': expanded,
        })}
      >
        {description}
      </div>

      {hasOverflow && (
        <button
          onClick={() => setExpanded(!expanded)}
          type="button"
          aria-expanded={expanded}
          className="self-start text-xs font-medium uppercase text-neutral-500 hover:text-primary"
        >
          {expanded ? content.strings.showLess : content.strings.readMore}
        </button>
      )}
    </div>
  );
};
