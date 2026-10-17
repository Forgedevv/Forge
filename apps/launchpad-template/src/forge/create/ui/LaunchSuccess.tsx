import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CREATE_COIN_TEXT, CREATOR_FEES_HREF } from '../copy';
import { CoinAvatar } from './CoinPreview';
import { ui } from './styles';

const TEXT = CREATE_COIN_TEXT.success;

export interface LaunchSuccessProps {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  siteName: string;
  /** Explorer link of the launch transaction. */
  transactionUrl: string;
  onAnother: () => void;
  /** Origin of the site for the share link (default: `window.location.origin`). */
  origin?: string;
}

/** Path of a coin page on this site. */
export function coinPath(mint: string): string {
  return `/token/${encodeURIComponent(mint)}`;
}

/** Plain https share intent on X (no script, no tracker). */
export function shareOnXUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

/**
 * LOCKED ZONE. Success screen of a launch: the coin, its page, its address (copy), a share link,
 * the transaction, and how the creator earns fees (`/creator-fees`).
 */
export function LaunchSuccess(props: LaunchSuccessProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  const origin = props.origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  const path = coinPath(props.mint);
  const share = shareOnXUrl(
    TEXT.shareText(props.name, props.symbol, props.siteName),
    `${origin}${path}`,
  );

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(props.mint);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (permissions): the address stays visible to copy by hand.
    }
  };

  return (
    <section data-forge="create-coin-success" className="text-center">
      <div className="mx-auto mb-5 w-fit">
        <CoinAvatar name={props.name} imageUrl={props.imageUrl} size={88} />
      </div>
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-bold text-foreground outline-none md:text-3xl"
      >
        {TEXT.title}
      </h2>
      <p className="mt-1 text-sm font-semibold text-primary">
        ${props.symbol} <span className="font-normal text-neutral-400">{props.name}</span>
      </p>
      <p className="mx-auto mt-3 max-w-lg text-sm text-neutral-400">{TEXT.body(props.siteName)}</p>

      <div className="mx-auto mt-5 flex max-w-md items-center gap-2 rounded-[var(--radius)] border border-neutral-850 bg-background py-1 pl-3 pr-1 text-left">
        <span className="sr-only">{TEXT.mint}</span>
        <code className="min-w-0 flex-1 truncate text-xs text-neutral-300" title={props.mint}>
          {props.mint}
        </code>
        <button type="button" className={ui.textButton} onClick={copy} aria-live="polite">
          <span
            aria-hidden="true"
            className={`iconify h-3.5 w-3.5 ${copied ? 'ph--check-bold' : 'ph--copy-bold'}`}
          />
          {copied ? TEXT.copied : TEXT.copy}
        </button>
      </div>

      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row sm:flex-wrap">
        <Link className={ui.primaryButton} href={path}>
          {TEXT.view}
        </Link>
        <a className={ui.secondaryButton} href={share} target="_blank" rel="noopener noreferrer">
          <span aria-hidden="true" className="iconify simple-icons--x h-3.5 w-3.5" />
          {TEXT.share}
        </a>
        <a
          className={ui.secondaryButton}
          href={props.transactionUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {TEXT.viewTransaction}
        </a>
      </div>

      <div
        className={`${ui.note} mx-auto mt-6 max-w-lg text-left`}
        data-forge="create-coin-fees-note"
      >
        <p className="font-semibold text-foreground">{TEXT.feesTitle}</p>
        <p className="mt-1 text-neutral-400">{TEXT.feesBody}</p>
        <Link
          href={CREATOR_FEES_HREF}
          className="mt-2 inline-flex min-h-[2.25rem] items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {TEXT.feesLink}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      <button type="button" className={`${ui.textButton} mt-5`} onClick={props.onAnother}>
        {CREATE_COIN_TEXT.actions.another}
      </button>
    </section>
  );
}
