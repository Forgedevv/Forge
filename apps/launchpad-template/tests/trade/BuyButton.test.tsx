// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyButton } from '../../src/forge/BuyButton';
import { setSwapCore } from '../../src/forge/trade/core-adapter';
import { createMockSwapCore } from '../../src/forge/trade/core-adapter.mock';
import { connectionRef, createFakeConnection, keys, site, wallet } from './harness';

vi.mock('@jup-ag/wallet-adapter', async () => {
  const h = await import('./harness');
  return {
    useWallet: () => ({ publicKey: h.wallet.publicKey, signTransaction: h.wallet.signTransaction }),
    useUnifiedWalletContext: () => ({ setShowModal: h.wallet.setShowModal }),
  };
});

vi.mock('@solana/spl-token', async (importOriginal) => {
  const h = await import('./harness');
  // Keep the other exports: `@forge/core` (imported by the swap adapter) needs them at load time.
  return {
    ...(await importOriginal<typeof import('@solana/spl-token')>()),
    getAssociatedTokenAddressSync: () => h.keys.user,
  };
});

vi.mock('../../src/forge/config', async () => {
  const h = await import('./harness');
  return {
    siteConfig: h.site,
    onchainConfig: { cluster: 'devnet', launchpadConfig: h.keys.config, launchpadCoinConfig: h.keys.coinConfig },
    forgeConfig: {},
  };
});

vi.mock('../../src/forge/trade/pool-address', async () => {
  const h = await import('./harness');
  return { launchpadPoolForMint: h.derivedPool };
});

vi.mock('../../src/forge/trade/connection', async () => {
  const h = await import('./harness');
  return { getRelayConnection: () => h.connectionRef.current };
});

vi.mock('../../src/forge/JupiterTrade', () => ({
  default: () => <div data-testid="jupiter-mock" />,
  JupiterTrade: () => <div data-testid="jupiter-mock" />,
}));

let restore: () => void;
beforeEach(() => {
  site.mode = 'live';
  wallet.publicKey = keys.user;
  wallet.signTransaction = null;
  connectionRef.current = createFakeConnection();
  restore = setSwapCore(createMockSwapCore());
});
afterEach(() => {
  cleanup();
  restore();
});

describe('BuyButton', () => {
  it('opens the trade panel on click without triggering the card behind it', async () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <BuyButton mint={keys.mint} symbol="MOON" />
      </div>,
    );
    expect(screen.queryByTestId('trade-form')).toBeNull();
    fireEvent.click(screen.getByTestId('buy-button'));
    expect(await screen.findByTestId('trade-form')).toBeTruthy();
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('is disabled and opens nothing when the site is sleeping or disabled', () => {
    for (const mode of ['sleeping', 'disabled'] as const) {
      site.mode = mode;
      const { unmount } = render(<BuyButton mint={keys.mint} />);
      const button = screen.getByTestId('buy-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(screen.queryByTestId('trade-form')).toBeNull();
      unmount();
    }
  });
});
