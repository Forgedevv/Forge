// @vitest-environment jsdom
import { Keypair } from '@solana/web3.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JupiterTrade } from '../../src/forge/JupiterTrade';
import { findLaunchpadPool, type LaunchpadPool } from '../../src/forge/trade/launchpad-pool';
import { accountsByAddress, keys, site, wallet } from './harness';

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

// PDA derivation is covered in node by pool-address.test.ts and launchpad-pool.test.ts.
vi.mock('../../src/forge/trade/pool-address', async () => {
  const h = await import('./harness');
  return { launchpadPoolForMint: h.derivedPool };
});

const REFERRAL = Keypair.generate().publicKey.toBase58();

type JupiterStub = {
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  syncProps: ReturnType<typeof vi.fn>;
};
let jupiter: JupiterStub;

async function handleFor(mint: string): Promise<LaunchpadPool> {
  const found = await findLaunchpadPool({ getAccountInfo: vi.fn(accountsByAddress()) }, mint);
  if (!found) throw new Error('no pool');
  return found;
}

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
  it('initialises the plugin with the FORGE referral account from the environment and the 50 bps fee', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    render(<JupiterTrade launchpadPool={await handleFor(keys.mint)} />);
    await waitFor(() => expect(jupiter.init).toHaveBeenCalled());
    const options = jupiter.init.mock.calls[0]?.[0] as { formProps: Record<string, unknown> };
    expect(options.formProps).toMatchObject({
      initialOutputMint: keys.mint,
      referralAccount: REFERRAL,
      referralFee: 50,
    });
  });

  it("opens the launchpad's own coin, found on its coin config", async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    render(<JupiterTrade launchpadPool={await handleFor(keys.ownMint)} />);
    await waitFor(() => expect(jupiter.init).toHaveBeenCalled());
    const options = jupiter.init.mock.calls[0]?.[0] as { formProps: Record<string, unknown> };
    expect(options.formProps.initialOutputMint).toBe(keys.ownMint);
  });

  it('refuses any coin that is not a pool handle of this launchpad: no plugin, no script', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    // A look-alike on the launchpad coin config gets no handle at all.
    expect(
      await findLaunchpadPool({ getAccountInfo: vi.fn(accountsByAddress()) }, keys.lookAlikeMint),
    ).toBeNull();
    const anyMint = Keypair.generate().publicKey.toBase58();
    const forged = [
      Object.freeze({ mint: anyMint, pool: keys.pool, config: keys.config }),
      Object.freeze({
        mint: keys.lookAlikeMint,
        pool: keys.lookAlikePool,
        config: keys.coinConfig,
      }),
      { mint: anyMint } as unknown as LaunchpadPool,
      undefined as unknown as LaunchpadPool,
    ];
    for (const launchpadPool of forged) {
      const { unmount } = render(<JupiterTrade launchpadPool={launchpadPool} />);
      expect(screen.getByTestId('jupiter-not-on-launchpad').textContent).toMatch(
        /not on this launchpad/,
      );
      unmount();
    }
    // A raw mint prop (the old API) is refused the same way.
    const Untyped = JupiterTrade as unknown as (props: {
      mint: string;
    }) => ReturnType<typeof JupiterTrade>;
    render(<Untyped mint={anyMint} />);
    expect(screen.getByTestId('jupiter-not-on-launchpad')).toBeTruthy();
    expect(jupiter.init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });

  it('fails closed without a valid referral account: no plugin, no script', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', 'not-an-address');
    render(<JupiterTrade launchpadPool={await handleFor(keys.mint)} />);
    expect(screen.getByTestId('jupiter-not-configured')).toBeTruthy();
    expect(jupiter.init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });

  it('renders nothing and loads nothing when the site is sleeping or disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT', REFERRAL);
    const handle = await handleFor(keys.mint);
    for (const mode of ['sleeping', 'disabled'] as const) {
      site.mode = mode;
      const { container, unmount } = render(<JupiterTrade launchpadPool={handle} />);
      expect(container.innerHTML).toBe('');
      unmount();
    }
    expect(jupiter.init).not.toHaveBeenCalled();
    expect(document.getElementById('jupiter-plugin-script')).toBeNull();
  });
});
