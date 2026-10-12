// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppProps } from 'next/app';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const RELAY = 'https://forge.example/api/rpc';

const h = vi.hoisted(() => ({
  mode: 'sleeping' as string,
  onchain: true,
  shellRenders: 0,
  walletProviders: 0,
  wallet: { publicKey: null as unknown, signTransaction: undefined as unknown },
  setShowModal: (() => {}) as (open: boolean) => void,
}));

// The builder-written config: sleeping, with the on-chain block and the relay configured.
vi.mock('@/forge/config', async () => {
  const { FIXTURE_LAUNCHPAD_CONFIG } = await import('@/forge/create/test-fixtures');
  const onchain = { launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(), cluster: 'devnet' };
  return {
    siteConfig: {
      name: 'Sleepy Pad',
      slug: 'sleepy-pad',
      theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: 'Sleepy tagline', about: '' },
      get mode() {
        return h.mode;
      },
    },
    get onchainConfig() {
      return h.onchain ? onchain : undefined;
    },
    get forgeConfig() {
      return h.onchain ? { onchain } : {};
    },
    cluster: 'devnet',
    rpcRelayEndpoint: 'https://forge.example/api/rpc',
  };
});

vi.mock('@/components/AppShell', () => ({
  AppShell: () => {
    h.shellRenders += 1;
    return <div data-testid="app-shell" />;
  },
}));

vi.mock('@jup-ag/wallet-adapter', () => ({
  UnifiedWalletProvider: ({ children }: { children: ReactNode }) => {
    h.walletProviders += 1;
    return <div data-testid="wallet-provider">{children}</div>;
  },
  useWallet: () => h.wallet,
  useUnifiedWalletContext: () => ({ setShowModal: h.setShowModal }),
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

// The core is mocked (no chain data in unit tests); the chain client is the real one, over a
// mocked relay `fetch`.
vi.mock('@/forge/claims/core-adapter', async () => {
  const { createMockClaimsCore, mockCoin } = await import('@/forge/claims/mock-core');
  const core = createMockClaimsCore([mockCoin({ name: 'Moon Coin', symbol: 'MOON' })]);
  return { claimsCore: core };
});

import App from '@/pages/_app';
import { claimsCore } from '@/forge/claims/core-adapter';

const walletKp = Keypair.generate();
const props = { Component: () => <p>Full site page</p>, pageProps: {} } as unknown as AppProps;

interface RpcCall {
  url: string;
  method: string;
}
let calls: RpcCall[] = [];

function stubRelay() {
  calls = [];
  const fetch = vi.fn(async (input: string, init: { body: string }) => {
    const { id, method } = JSON.parse(init.body) as { id: number; method: string };
    calls.push({ url: input, method });
    const results: Record<string, unknown> = {
      getBalance: { context: { slot: 1 }, value: 1_000_000_000 },
      sendTransaction: 'ClaimSig',
      getSignatureStatuses: {
        context: { slot: 2 },
        value: [{ confirmationStatus: 'confirmed', err: null }],
      },
    };
    if (!(method in results)) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, error: {} }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id, result: results[method] }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

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
  h.mode = 'sleeping';
  h.onchain = true;
  h.shellRenders = 0;
  h.walletProviders = 0;
  h.wallet = {
    publicKey: walletKp.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([walletKp]);
      return tx;
    },
  };
  (claimsCore as unknown as { built: unknown[] }).built.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openClaim() {
  render(<App {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Claim your creator fees' }));
  return screen.findByText('Moon Coin (MOON)');
}

describe('sleeping site: creator fee claims (D29)', () => {
  it('serves a static page until a creator opens the claim widget', () => {
    const fetch = stubRelay();
    render(<App {...props} />);
    expect(screen.getByText('This launchpad is sleeping')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim your creator fees' })).toBeInTheDocument();
    // Nothing loaded yet: no wallet provider, no RPC call, no app shell.
    expect(h.walletProviders).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.shellRenders).toBe(0);
    expect(screen.queryByText('Full site page')).toBeNull();
  });

  it('renders the locked claim widget with the wallet connection', async () => {
    h.wallet = { publicKey: null, signTransaction: undefined };
    const setShowModal = vi.fn();
    h.setShowModal = setShowModal;
    render(<App {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim your creator fees' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    expect(setShowModal).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('wallet-provider')).toBeInTheDocument();
    expect(document.querySelector('[data-forge="claim-fees-disabled"]')).toBeNull();
  });

  it('builds, signs and sends a claim through the FORGE RPC relay', async () => {
    stubRelay();
    await openClaim();
    expect(h.walletProviders).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Claim fees for Moon Coin' }));
    const review = await screen.findByLabelText('Claim summary');
    expect(within(review).getByText(new RegExp(walletKp.publicKey.toBase58()))).toBeInTheDocument();
    expect((claimsCore as unknown as { built: unknown[] }).built).toEqual([
      {
        pool: expect.any(String),
        creator: walletKp.publicKey.toBase58(),
        receiver: walletKp.publicKey.toBase58(),
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and claim' }));
    expect(await screen.findByText(/Claimed 1.5 SOL/)).toBeInTheDocument();
    expect(calls.map((c) => c.method)).toEqual([
      'getBalance',
      'sendTransaction',
      'getSignatureStatuses',
    ]);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([RELAY]));
  });

  it('renders no trade panel, coin creation or indexer data', async () => {
    stubRelay();
    await openClaim();
    expect(h.shellRenders).toBe(0);
    expect(document.querySelector('[data-forge="trade-panel"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /buy|sell|swap/i })).toBeNull();
    expect(screen.queryByText(/create (a )?coin/i)).toBeNull();
    const interactive = [...document.querySelectorAll('button, a, input, select, textarea')];
    const labels = interactive.map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(labels.sort()).toEqual(['Claim fees for Moon Coin'].sort());
    for (const call of calls) expect(call.url).toBe(RELAY);
  });

  it('shows no claim entry before the on-chain setup', () => {
    h.onchain = false;
    render(<App {...props} />);
    expect(screen.getByText('This launchpad is sleeping')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim your creator fees' })).toBeNull();
  });

  it('disabled mode still renders nothing interactive', () => {
    h.mode = 'disabled';
    const fetch = stubRelay();
    render(<App {...props} />);
    expect(screen.getByText('This site is unavailable.')).toBeInTheDocument();
    expect(document.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
    expect(h.walletProviders).toBe(0);
    expect(h.shellRenders).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
