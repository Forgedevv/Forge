import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import Link from 'next/link';
import { Button } from './ui/button';
import { CreatePoolButton } from './CreatePoolButton';
import { ThemeToggle } from './ThemeToggle';
import { useMemo } from 'react';
import { content } from '@/content';
import { Logo } from './Logo';
import { MobileNav } from './MobileNav';
import { WalletMenu } from './WalletMenu';

export const Header = () => {
  const { setShowModal } = useUnifiedWalletContext();

  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const handleConnectWallet = () => {
    setShowModal(true);
  };

  return (
    <header className="launchpad-header sticky top-0 z-40 w-full border-b backdrop-blur-md">
      <div className="launchpad-header-inner relative flex min-h-14 items-center justify-between gap-3 py-2 md:min-h-16">
        {/* Logo Section */}
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none"
        >
          {/* Logo slot: replace the drawing in `Logo.tsx` with the launchpad's own mark. */}
          <span className="launchpad-brand-mark flex h-9 w-9 shrink-0 items-center justify-center">
            <Logo className="h-full w-full" />
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
        <nav
          className="flex items-center gap-1.5 md:gap-3"
          aria-label={content.strings.mainNavLabel}
        >
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
          {/* The wallet button opens a menu (copy, explorer, creator fees, disconnect). */}
          {address ? (
            <WalletMenu address={address} onDisconnect={() => disconnect()} />
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
          {/* Phones carry the theme toggle in the menu. */}
          <ThemeToggle className="max-md:hidden" />
          <MobileNav />
        </nav>
      </div>
    </header>
  );
};

export default Header;
