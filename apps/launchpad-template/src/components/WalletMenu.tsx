import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { content } from '@/content';
import { cluster } from '@/forge/config';
import { cn, shortenAddress } from '@/lib/utils';
import { buttonVariants } from './ui/button';
import { useDismiss } from './ui/useDismiss';

type WalletMenuProps = {
  /** Connected wallet address (base58). */
  address: string;
  onDisconnect: () => void;
  className?: string;
};

/**
 * Connected wallet button of the header. A tap opens a small panel (it never disconnects on its
 * own): copy the address, view it on the explorer of this launchpad's cluster, open the creator
 * fees page, or disconnect explicitly. Closes on Escape, a press outside, focus leaving it, or a
 * choice. Styled with the theme variables (`launchpad-wallet-menu*` in theme.css).
 */
export const WalletMenu = ({ address, onDisconnect, className }: WalletMenuProps) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, button, panel);

  useEffect(() => {
    if (open) panel.current?.querySelector('button')?.focus();
    else setCopied(false);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const disconnect = () => {
    close();
    onDisconnect();
  };

  return (
    <div className={cn('relative', className)}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title={content.strings.walletMenu}
        onClick={() => setOpen((value) => !value)}
        className={cn(buttonVariants({ variant: 'secondary' }), 'launchpad-wallet-button')}
      >
        <span aria-hidden="true" className="iconify h-4 w-4 ph--wallet-bold" />
        {shortenAddress(address)}
        <span aria-hidden="true" className="iconify h-3.5 w-3.5 ph--caret-down-bold" />
      </button>
      <div
        ref={panel}
        id={panelId}
        hidden={!open}
        className="launchpad-wallet-menu absolute right-0 top-full z-50 mt-2 w-60 max-w-[calc(100vw-2rem)] border p-1.5"
      >
        <p className="launchpad-wallet-menu-address" title={address}>
          {address}
        </p>
        <button type="button" onClick={copy} className="launchpad-wallet-menu-item">
          <span aria-hidden="true" className="iconify h-4 w-4 ph--copy-bold" />
          <span aria-live="polite">
            {copied ? content.strings.addressCopied : content.strings.copyAddress}
          </span>
        </button>
        <a
          href={
            cluster === 'devnet'
              ? `https://solscan.io/account/${address}?cluster=devnet`
              : `https://solscan.io/account/${address}`
          }
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
          className="launchpad-wallet-menu-item"
        >
          <span aria-hidden="true" className="iconify h-4 w-4 ph--arrow-square-out-bold" />
          {content.strings.viewOnExplorer}
        </a>
        <Link href="/creator-fees" onClick={close} className="launchpad-wallet-menu-item">
          <span aria-hidden="true" className="iconify h-4 w-4 ph--coins-bold" />
          {content.strings.creatorFees}
        </Link>
        <button
          type="button"
          onClick={disconnect}
          className="launchpad-wallet-menu-item launchpad-wallet-menu-danger"
        >
          <span aria-hidden="true" className="iconify h-4 w-4 ph--sign-out-bold" />
          {content.strings.disconnect}
        </button>
      </div>
    </div>
  );
};

export default WalletMenu;
