// @vitest-environment jsdom
import '../helpers/dom-setup';
import { render, screen } from '@testing-library/react';
import type { AppProps } from 'next/app';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mode: 'disabled' as string,
  shellRenders: 0,
  walletConfigs: [] as unknown[],
  theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
}));

// The builder-written config: the only source of the mode.
vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Gate Pad',
    slug: 'gate-pad',
    theme: h.theme,
    content: { tagline: 'Gate tagline', about: '' },
    get mode() {
      return h.mode;
    },
  },
  onchainConfig: undefined,
  forgeConfig: {},
  cluster: 'devnet',
}));

// A free-zone change that tries to force the site live: it must have no effect on the gate.
vi.mock('@/content', () => ({
  siteConfig: {
    name: 'Gate Pad',
    slug: 'gate-pad',
    theme: h.theme,
    content: { tagline: 'Gate tagline', about: '' },
    mode: 'live',
  },
  content: { name: 'Gate Pad', tagline: 'Gate tagline', about: '', strings: {} },
}));

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
  UnifiedWalletProvider: ({ children, config }: { children: ReactNode; config: unknown }) => {
    h.walletConfigs.push(config);
    return <div data-testid="wallet-provider">{children}</div>;
  },
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

import App from '@/pages/_app';

const Page = () => <p>Full site page</p>;
const props = { Component: Page, pageProps: {} } as unknown as AppProps;

beforeAll(() => {
  // next-themes reads the colour scheme preference.
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
  h.shellRenders = 0;
  h.walletConfigs = [];
});

describe('ModeGate in _app: the mode comes from forge.config.json only', () => {
  it('serves the disabled page even when the free-zone content says live', () => {
    h.mode = 'disabled';
    render(<App {...props} />);
    expect(screen.getByText('This site is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Full site page')).toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.queryByTestId('wallet-provider')).toBeNull();
    expect(h.shellRenders).toBe(0);
    expect(h.walletConfigs).toHaveLength(0);
  });

  it('serves the sleeping page only when sleeping', () => {
    h.mode = 'sleeping';
    render(<App {...props} />);
    expect(screen.getByText('This launchpad is sleeping')).toBeInTheDocument();
    expect(screen.getByText('Gate tagline')).toBeInTheDocument();
    expect(screen.queryByText('Full site page')).toBeNull();
    expect(h.shellRenders).toBe(0);
    expect(h.walletConfigs).toHaveLength(0);
  });

  it('fails closed to the disabled page on an unknown mode', () => {
    h.mode = 'paused';
    render(<App {...props} />);
    expect(screen.getByText('This site is unavailable.')).toBeInTheDocument();
    expect(h.shellRenders).toBe(0);
  });

  it('renders the providers, the free-zone app shell and the page when live', () => {
    h.mode = 'live';
    render(<App {...props} />);
    expect(screen.getByTestId('wallet-provider')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByText('Full site page')).toBeInTheDocument();
  });

  it('configures the wallet for the configured cluster and with this site metadata', () => {
    h.mode = 'live';
    render(<App {...props} />);
    const config = h.walletConfigs[0] as {
      env: string;
      metadata: { name: string; description: string; url: string; iconUrls: string[] };
    };
    expect(config.env).toBe('devnet');
    expect(config.metadata).toEqual({
      name: 'Gate Pad',
      description: 'Gate tagline',
      url: window.location.origin,
      iconUrls: [`${window.location.origin}/favicon.ico`],
    });
    expect(JSON.stringify(config.metadata)).not.toContain('jup.ag');
  });
});
