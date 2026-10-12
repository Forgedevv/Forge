// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair } from '@solana/web3.js';
import { render, screen, within } from '@testing-library/react';
import type { AppProps } from 'next/app';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mode: 'live' as string,
  shellRenders: 0,
  walletProviders: 0,
  wallet: { publicKey: null as unknown, signTransaction: undefined as unknown },
}));

// The builder-written config, with the on-chain block and the relay configured.
vi.mock('@/forge/config', async () => {
  const { FIXTURE_LAUNCHPAD_CONFIG } = await import('@/forge/create/test-fixtures');
  const onchain = { launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(), cluster: 'devnet' };
  return {
    siteConfig: {
      name: 'Fee Pad',
      slug: 'fee-pad',
      theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: 'Fee tagline', about: '' },
      get mode() {
        return h.mode;
      },
    },
    onchainConfig: onchain,
    forgeConfig: { onchain },
    cluster: 'devnet',
    rpcRelayEndpoint: 'https://forge.example/api/rpc',
  };
});

// The free-zone app shell renders the page, as the real one does.
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ Component, pageProps }: AppProps) => {
    h.shellRenders += 1;
    return (
      <div data-testid="app-shell">
        <Component {...pageProps} />
      </div>
    );
  },
}));

vi.mock('@jup-ag/wallet-adapter', () => ({
  UnifiedWalletProvider: ({ children }: { children: ReactNode }) => {
    h.walletProviders += 1;
    return <div data-testid="wallet-provider">{children}</div>;
  },
  useWallet: () => h.wallet,
  useUnifiedWalletContext: () => ({ setShowModal: () => {} }),
}));
vi.mock('@solana/wallet-adapter-phantom', () => ({
  PhantomWalletAdapter: class {
    name = 'Phantom';
    icon = 'data:,';
  },
}));
vi.mock('@solana/wallet-adapter-solflare', () => ({
  SolflareWalletAdapter: class {
    name = 'Solflare';
    icon = 'data:,';
  },
}));

// No chain data in unit tests: the claims core is the mock one.
vi.mock('@/forge/claims/core-adapter', async () => {
  const { createMockClaimsCore, mockCoin } = await import('@/forge/claims/mock-core');
  return {
    claimsCore: createMockClaimsCore([mockCoin({ name: 'Moon Coin', symbol: 'MOON' })]),
  };
});

import App from '@/pages/_app';
import CreatorFeesRoute from '@/pages/creator-fees';
import { CREATOR_FEES_PATH, CreatorFeesPage } from '@/forge/pages/CreatorFeesPage';

const props = { Component: CreatorFeesRoute, pageProps: {} } as unknown as AppProps;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  h.mode = 'live';
  h.shellRenders = 0;
  h.walletProviders = 0;
  h.wallet = { publicKey: null, signTransaction: undefined };
});

describe('/creator-fees on a live site', () => {
  it('is the locked creator fee page', () => {
    expect(CreatorFeesRoute).toBe(CreatorFeesPage);
    expect(CREATOR_FEES_PATH).toBe('/creator-fees');
  });

  it('renders the claim widget inside the live providers and the app shell', () => {
    render(<App {...props} />);
    const page = document.querySelector('[data-forge-page="creator-fees"]') as HTMLElement;
    expect(page).not.toBeNull();
    expect(within(page).getByRole('heading', { name: 'Creator fees' })).toBeInTheDocument();
    // No wallet yet: the widget asks to connect one.
    expect(page.querySelector('[data-forge="claim-fees-connect"]')).not.toBeNull();
    expect(screen.getByTestId('app-shell')).toContainElement(page);
    expect(screen.getByTestId('wallet-provider')).toContainElement(page);
    expect(within(page).getByRole('link', { name: 'Back to the launchpad' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it("lists the connected wallet's coins", async () => {
    h.wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (tx: unknown) => tx,
    };
    render(<App {...props} />);
    expect(await screen.findByText('Moon Coin (MOON)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your creator fees' })).toBeInTheDocument();
  });
});

describe('/creator-fees outside live mode: the mode gate keeps its page', () => {
  it('renders only the sleeping page (with its own claim entry) when sleeping', () => {
    h.mode = 'sleeping';
    render(<App {...props} />);
    expect(screen.getByText('This launchpad is sleeping')).toBeInTheDocument();
    expect(document.querySelector('[data-forge="sleeping-claim-entry"]')).not.toBeNull();
    expect(document.querySelector('[data-forge-page="creator-fees"]')).toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(h.shellRenders).toBe(0);
    // The claim widget (and its wallet provider) loads only when the creator opens it.
    expect(h.walletProviders).toBe(0);
  });

  it('renders only the disabled page when disabled', () => {
    h.mode = 'disabled';
    render(<App {...props} />);
    expect(screen.getByText('This site is unavailable.')).toBeInTheDocument();
    expect(document.querySelector('[data-forge-page="creator-fees"]')).toBeNull();
    expect(document.querySelector('[data-forge^="claim-fees"]')).toBeNull();
    expect(h.shellRenders).toBe(0);
    expect(h.walletProviders).toBe(0);
  });
});
