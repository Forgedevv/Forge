import type { MouseEventHandler, ReactNode } from 'react';
import { canonicalXUrl, xHandle } from './socials';

/**
 * LOCKED ZONE. Link to a coin's X (Twitter) profile, for the free zones (coin page, market cards).
 * It takes the raw value (the data API's `baseAsset.twitter`, or the on-chain fallback's) and
 * renders a link only when it is exactly `https://x.com/<handle>` (`socials.ts`); anything else
 * renders nothing. Opens in a new tab without referrer or opener. The free zone chooses the
 * content (icon, handle) and the style.
 */
export function CoinXLink({
  url,
  className,
  title,
  onClick,
  children,
}: {
  url: unknown;
  className?: string;
  /** Accessible name of the link (an icon-only link needs one). */
  title?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /** Content of the link; a function receives the handle (without `@`). */
  children: ReactNode | ((handle: string) => ReactNode);
}) {
  const href = canonicalXUrl(url);
  const handle = xHandle(href);
  if (!href || !handle) return null;
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
      title={title}
      onClick={onClick}
    >
      {typeof children === 'function' ? children(handle) : children}
    </a>
  );
}

/** True when `url` is a link `CoinXLink` renders. */
export function hasCoinXLink(url: unknown): boolean {
  return canonicalXUrl(url) !== null;
}
