import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import Link from 'next/link';
import { Button } from './ui/button';
import { CreatePoolButton } from './CreatePoolButton';
import { ThemeToggle } from './ThemeToggle';
import { useMemo } from 'react';
import { shortenAddress } from '@/lib/utils';
import { content } from '@/content';

export const Header = () => {
  const { setShowModal } = useUnifiedWalletContext();

  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const handleConnectWallet = () => {
    setShowModal(true);
  };

  return (
    <header className="launchpad-header sticky top-0 z-40 w-full border-b backdrop-blur-md">
      <div className="launchpad-header-inner flex min-h-14 items-center justify-between gap-3 py-2 md:min-h-16">
        {/* Logo Section */}
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none"
        >
          <span className="launchpad-brand-mark flex h-8 w-8 shrink-0 items-center justify-center">
            <span className="iconify h-5 w-5 ph--rocket-launch-bold" />
          </span>
          <span className="min-w-0">
            <span className="block truncate whitespace-nowrap text-base font-bold tracking-tight md:text-lg">
              {content.name}
            </span>
            <span className="launchpad-tagline hidden truncate text-xs sm:block">
              {content.tagline}
            </span>
          </span>
        </Link>

        {/* Navigation and Actions */}
        <div className="flex items-center gap-1.5 md:gap-3">
          <Link
            href="/"
            className="launchpad-nav-link hidden px-3 py-2 text-sm font-medium md:inline-flex"
          >
            {content.strings.explore}
          </Link>
          <Link
            href="/about"
            className="launchpad-nav-link hidden px-3 py-2 text-sm font-medium md:inline-flex"
          >
            {content.strings.aboutTitle}
          </Link>
          <Link
            href="/creator-fees"
            className="launchpad-nav-link hidden px-3 py-2 text-sm font-medium md:inline-flex"
          >
            {content.strings.creatorFees}
          </Link>
          <CreatePoolButton />
          {address ? (
            <Button variant="secondary" onClick={() => disconnect()}>
              <span className="iconify h-4 w-4 ph--wallet-bold" />
              {shortenAddress(address)}
            </Button>
          ) : (
            <Button
              onClick={() => {
                handleConnectWallet();
              }}
            >
              <span className="hidden md:block">{content.strings.connectWallet}</span>
              <span className="block md:hidden">{content.strings.connectShort}</span>
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};

export default Header;
