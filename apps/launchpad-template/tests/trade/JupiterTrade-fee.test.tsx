// @vitest-environment jsdom
import { Keypair } from '@solana/web3.js';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JupiterTrade } from '../../src/forge/JupiterTrade';
import { findLaunchpadPool } from '../../src/forge/trade/launchpad-pool';
import { accountsByAddress, keys, site } from './harness';

vi.mock('@jup-ag/wallet-adapter', async () => {
  const h = await import('./harness');
  return {
    useWallet: () => ({ publicKey: h.wallet.publicKey, signTransaction: null }),
    useUnifiedWalletContext: () => ({ setShowModal: h.wallet.setShowModal }),
  };
});

vi.mock('../../src/forge/config', async () => {
  const h = await import('./harness');
  return {
    siteConfig: h.site,
    onchainConfig: {
      cluster: 'devnet',
      launchpadConfig: h.keys.config,
      launchpadCoinConfig: h.keys.coinConfig,
      launchpadCoinMint: h.keys.ownMint,
    },
    forgeConfig: {},
  };
});

vi.mock('../../src/forge/trade/pool-address', async () => {
  const h = await import('./harness');
  return { launchpadPoolForMint: h.derivedPool };
});

// A fee Jupiter Ultra refuses (below its 50 bps minimum): the old 30 bps value.
vi.mock('../../src/forge/trade/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/forge/trade/constants')>()),
  JUPITER_REFERRAL_FEE_BPS: 30,
}));

let init: ReturnType<typeof vi.fn>;

beforeEach(() => {
  site.mode = 'live';
  init = vi.fn();
  (window as unknown as { Jupiter: unknown }).Jupiter = {
    init,
    close: vi.fn(),
    syncProps: vi.fn(),
  };
  vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', Keypair.generate().publicKey.toBase58());
  document.getElementById('jupiter-plugin-script')?.remove();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { Jupiter?: unknown }).Jupiter;
});

describe('JupiterTrade with a referral fee Jupiter refuses', () => {
  it('fails closed: notice, no plugin, no script', async () => {
    const handle = await findLaunchpadPool(
      { getAccountInfo: vi.fn(accountsByAddress()) },
      keys.mint,
    );
    expect(handle).not.toBeNull();
    render(<JupiterTrade launchpadPool={handle!} />);
    expect(screen.getByTestId('jupiter-not-configured').textContent).toMatch(/not configured/);
    expect(init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });
});
