// @vitest-environment jsdom
import '../helpers/dom-setup';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mint: undefined as string | undefined }));

vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Moon Pad',
    slug: 'moon-pad',
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'About the moon.' },
    mode: 'live',
  },
  get onchainConfig() {
    return h.mint ? { launchpadCoinMint: h.mint } : undefined;
  },
}));

import { content } from '@/content';
import { ClosingCta } from '@/components/home/ClosingCta';
import { Faq } from '@/components/home/Faq';
import { HowItWorks } from '@/components/home/HowItWorks';
import { LaunchpadCoin } from '@/components/home/LaunchpadCoin';
import { ValueStrip } from '@/components/home/ValueStrip';
import { MarketEmpty } from '@/components/Explore/MarketEmpty';
import { isMarketEmpty } from '@/components/Explore/market-state';
import { Logo } from '@/components/Logo';
import { SiteFooter } from '@/components/SiteFooter';

describe('home sections', () => {
  it('render their copy from src/content', () => {
    render(
      <>
        <ValueStrip />
        <HowItWorks />
        <Faq />
        <ClosingCta />
      </>,
    );
    for (const value of content.values) expect(screen.getByText(value.title)).toBeInTheDocument();
    const steps = screen.getByRole('region', { name: content.howItWorks.title });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(content.howItWorks.steps.length);
    for (const item of content.faq.items)
      expect(screen.getByText(item.question)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create a coin/ })).toHaveAttribute(
      'href',
      '/create-pool',
    );
  });

  it('shows the launchpad coin as pending until FORGE writes its mint', () => {
    h.mint = undefined;
    const { unmount } = render(<LaunchpadCoin />);
    expect(screen.getByText(content.launchpadCoin.pendingNote)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    unmount();

    h.mint = 'MintOfTheCoin';
    render(<LaunchpadCoin />);
    expect(screen.getByRole('link', { name: /Trade the coin/ })).toHaveAttribute(
      'href',
      '/token/MintOfTheCoin',
    );
  });

  it('renders the day-one market with a call to create the first coin', () => {
    render(<MarketEmpty />);
    expect(screen.getByRole('status')).toHaveTextContent(content.market.empty.title);
    expect(screen.getByRole('link', { name: /Launch the first coin/ })).toHaveAttribute(
      'href',
      '/create-pool',
    );
  });

  it('renders the logo and the footer links', () => {
    render(<Logo title="Moon Pad logo" />);
    expect(screen.getByRole('img', { name: 'Moon Pad logo' })).toBeInTheDocument();
    render(<SiteFooter />);
    const nav = screen.getByRole('navigation', { name: content.strings.footerNavLabel });
    expect(within(nav).getByRole('link', { name: content.strings.creatorFees })).toHaveAttribute(
      'href',
      '/creator-fees',
    );
  });
});

describe('isMarketEmpty', () => {
  it('is true only once loaded with every list empty', () => {
    const empty = { recent: { pools: [] }, aboutToGraduate: { pools: [] }, graduated: undefined };
    expect(isMarketEmpty('success', empty)).toBe(true);
    expect(isMarketEmpty('loading', empty)).toBe(false);
    expect(isMarketEmpty('error', undefined)).toBe(false);
    expect(isMarketEmpty('success', { ...empty, graduated: { pools: [{}] } })).toBe(false);
  });
});

describe('free-zone section components', () => {
  // jsdom tests run from the package root (vitest root).
  const root = join(process.cwd(), 'src', 'components');
  const files = [
    ...readdirSync(join(root, 'home')).map((name) => join(root, 'home', name)),
    join(root, 'Logo.tsx'),
    join(root, 'SiteFooter.tsx'),
    join(root, 'Explore', 'MarketEmpty.tsx'),
  ];

  it('stay presentational: no network, no wallet, no environment, no raw HTML', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /fetch\(|XMLHttpRequest|WebSocket|process\.env|dangerouslySetInnerHTML|useWallet|https?:\/\//,
      );
    }
  });
});
