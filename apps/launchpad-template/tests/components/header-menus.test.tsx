// @vitest-environment jsdom
import '../helpers/dom-setup';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADDRESS = 'Ab1cDeFgHiJkLmNoPqRsTuVwXyZ23456789abcdefghij';

const h = vi.hoisted(() => ({
  address: null as string | null,
  disconnect: vi.fn(),
  setShowModal: vi.fn(),
  cluster: 'devnet' as 'devnet' | 'mainnet-beta',
}));

vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Moon Pad',
    slug: 'moon-pad',
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'About the moon.' },
    mode: 'live',
  },
  onchainConfig: undefined,
  get cluster() {
    return h.cluster;
  },
}));
vi.mock('@jup-ag/wallet-adapter', () => ({
  useWallet: () => ({
    publicKey: h.address ? { toBase58: () => h.address } : null,
    disconnect: h.disconnect,
  }),
  useUnifiedWalletContext: () => ({ setShowModal: h.setShowModal }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark', setTheme: vi.fn() }) }));

import { Header } from '@/components/Header';

beforeEach(() => {
  h.address = null;
  h.cluster = 'devnet';
  h.disconnect.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const menuButton = () => screen.getByRole('button', { name: /menu/i });
const siteMenu = () => document.getElementById(menuButton().getAttribute('aria-controls')!)!;

describe('mobile navigation', () => {
  it('opens from an accessible button and moves focus to the first link', () => {
    render(<Header />);
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(menuButton().getAttribute('aria-label')).toBe('Open menu');
    expect(siteMenu().hidden).toBe(true);

    fireEvent.click(menuButton());
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(menuButton().getAttribute('aria-label')).toBe('Close menu');
    expect(siteMenu().hidden).toBe(false);
    const nav = within(siteMenu()).getByRole('navigation', { name: 'Site menu' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/about', '/creator-fees']);
    expect(document.activeElement).toBe(links[0]);
    // The theme toggle lives in the menu on phones.
    expect(within(nav).getByRole('button', { name: /mode/ })).toBeTruthy();
  });

  it('closes on Escape and gives focus back to its button', () => {
    render(<Header />);
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(siteMenu().hidden).toBe(true);
    expect(document.activeElement).toBe(menuButton());
  });

  it('closes on a press outside, but not on a press inside', () => {
    render(<Header />);
    fireEvent.click(menuButton());
    fireEvent.mouseDown(within(siteMenu()).getByRole('navigation'));
    expect(siteMenu().hidden).toBe(false);
    fireEvent.mouseDown(document.body);
    expect(siteMenu().hidden).toBe(true);
  });

  it('closes when a link is followed or the history moves', () => {
    render(<Header />);
    fireEvent.click(menuButton());
    fireEvent.click(within(siteMenu()).getByRole('link', { name: 'About' }));
    expect(siteMenu().hidden).toBe(true);

    fireEvent.click(menuButton());
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(siteMenu().hidden).toBe(true);
  });
});

describe('wallet menu', () => {
  const walletButton = () => screen.getByRole('button', { name: /Ab1c/ });
  const walletPanel = () => document.getElementById(walletButton().getAttribute('aria-controls')!)!;

  it('asks to connect when no wallet is connected', () => {
    render(<Header />);
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(h.setShowModal).toHaveBeenCalledWith(true);
  });

  it('opens a menu on a tap and never disconnects on its own', () => {
    h.address = ADDRESS;
    render(<Header />);
    expect(walletButton().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(walletButton());
    expect(walletButton().getAttribute('aria-expanded')).toBe('true');
    expect(walletPanel().hidden).toBe(false);
    expect(within(walletPanel()).getByText(ADDRESS)).toBeTruthy();
    expect(h.disconnect).not.toHaveBeenCalled();
    fireEvent.click(walletButton());
    expect(walletPanel().hidden).toBe(true);
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('copies the address', async () => {
    h.address = ADDRESS;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<Header />);
    fireEvent.click(walletButton());
    await act(async () => {
      fireEvent.click(within(walletPanel()).getByRole('button', { name: 'Copy address' }));
    });
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(within(walletPanel()).getByRole('button', { name: 'Address copied' })).toBeTruthy();
  });

  it('links the explorer of the launchpad cluster and the creator fees page', () => {
    h.address = ADDRESS;
    const { unmount } = render(<Header />);
    fireEvent.click(walletButton());
    const explorer = within(walletPanel()).getByRole('link', { name: 'View on explorer' });
    expect(explorer.getAttribute('href')).toBe(`https://solscan.io/account/${ADDRESS}?cluster=devnet`);
    expect(explorer.getAttribute('target')).toBe('_blank');
    expect(explorer.getAttribute('rel')).toContain('noopener');
    expect(
      within(walletPanel()).getByRole('link', { name: 'Creator fees' }).getAttribute('href'),
    ).toBe('/creator-fees');
    unmount();

    h.cluster = 'mainnet-beta';
    render(<Header />);
    fireEvent.click(walletButton());
    expect(
      within(walletPanel()).getByRole('link', { name: 'View on explorer' }).getAttribute('href'),
    ).toBe(`https://solscan.io/account/${ADDRESS}`);
  });

  it('disconnects only from the explicit menu item, then closes', () => {
    h.address = ADDRESS;
    render(<Header />);
    fireEvent.click(walletButton());
    fireEvent.click(within(walletPanel()).getByRole('button', { name: 'Disconnect' }));
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(walletPanel().hidden).toBe(true);
  });

  it('closes on Escape and on a press outside', () => {
    h.address = ADDRESS;
    render(<Header />);
    fireEvent.click(walletButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(walletPanel().hidden).toBe(true);
    expect(document.activeElement).toBe(walletButton());
    fireEvent.click(walletButton());
    fireEvent.mouseDown(document.body);
    expect(walletPanel().hidden).toBe(true);
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});
