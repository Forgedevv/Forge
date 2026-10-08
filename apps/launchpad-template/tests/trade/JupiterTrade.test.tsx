// @vitest-environment jsdom
import { Keypair } from '@solana/web3.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JupiterTrade } from '../../src/forge/JupiterTrade';
import { site, wallet } from './harness';

vi.mock('@jup-ag/wallet-adapter', async () => {
  const h = await import('./harness');
  return {
    useWallet: () => ({ publicKey: h.wallet.publicKey, signTransaction: null }),
    useUnifiedWalletContext: () => ({ setShowModal: h.wallet.setShowModal }),
  };
});

vi.mock('../../src/forge/config', async () => {
  const h = await import('./harness');
  return { siteConfig: h.site, onchainConfig: { cluster: 'devnet' }, forgeConfig: {} };
});

const REFERRAL = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

type JupiterStub = {
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  syncProps: ReturnType<typeof vi.fn>;
};
let jupiter: JupiterStub;

beforeEach(() => {
  site.mode = 'live';
  wallet.publicKey = null;
  jupiter = { init: vi.fn(), close: vi.fn(), syncProps: vi.fn() };
  (window as unknown as { Jupiter: JupiterStub }).Jupiter = jupiter;
  vi.stubEnv('FORGE_JUPITER_REFERRAL_ACCOUNT', '');
  document.getElementById('jupiter-plugin-script')?.remove();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { Jupiter?: JupiterStub }).Jupiter;
});

describe('JupiterTrade', () => {
  it('initialises the plugin with the FORGE referral account and the 30 bps fee read from the environment', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    render(<JupiterTrade mint={MINT} />);
    await waitFor(() => expect(jupiter.init).toHaveBeenCalled());
    const options = jupiter.init.mock.calls[0]?.[0] as { formProps: Record<string, unknown> };
    expect(options.formProps).toMatchObject({
      initialOutputMint: MINT,
      referralAccount: REFERRAL,
      referralFee: 30,
    });
  });

  it('fails closed without a valid referral account: no plugin, no script', () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', 'not-an-address');
    render(<JupiterTrade mint={MINT} />);
    expect(screen.getByTestId('jupiter-not-configured')).toBeTruthy();
    expect(jupiter.init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });

  it('renders nothing and loads nothing when the site is sleeping or disabled', () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    for (const mode of ['sleeping', 'disabled'] as const) {
      site.mode = mode;
      const { container, unmount } = render(<JupiterTrade mint={MINT} />);
      expect(container.innerHTML).toBe('');
      unmount();
    }
    expect(jupiter.init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });
});
