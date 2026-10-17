// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchApi, PrepareLaunchResponse } from '@/forge/create/api';
import type { ChainClient } from '@/forge/create/chain';
import {
  buildFixtureLaunch,
  FIXTURE_LAUNCHPAD_CONFIG,
  FIXTURE_PLATFORM_FEE_WALLET,
} from '@/forge/create/test-fixtures';

const walletKp = Keypair.generate();
const wallet = vi.hoisted(() => ({
  current: { publicKey: null as unknown, signTransaction: undefined as unknown, signMessage: undefined as unknown },
  setShowModal: vi.fn(),
  useWalletCalls: 0,
}));

vi.mock('@jup-ag/wallet-adapter', () => ({
  useWallet: () => {
    wallet.useWalletCalls += 1;
    return wallet.current;
  },
  useUnifiedWalletContext: () => ({ setShowModal: wallet.setShowModal }),
}));

// The launchpad config comes from forge.config.json only (there is no prop for it).
vi.mock('@/forge/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/forge/config')>();
  const fixtures = await import('@/forge/create/test-fixtures');
  const key = () => fixtures.FIXTURE_PLATFORM_FEE_WALLET.toBase58();
  return {
    ...actual,
    onchainConfig: {
      cluster: 'devnet',
      launchpadConfig: fixtures.FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
      launchpadCoinConfig: key(),
      launchpadCoinMint: key(),
      ownerWallet: key(),
    },
  };
});

import { CreateCoin } from '@/forge/CreateCoin';

interface Harness {
  api: LaunchApi & { prepare: ReturnType<typeof vi.fn>; rebuild?: ReturnType<typeof vi.fn> };
  chain: ChainClient & {
    getBalanceLamports: ReturnType<typeof vi.fn>;
    getAccounts: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendRawTransaction: ReturnType<typeof vi.fn>;
    getSignatureStatus: ReturnType<typeof vi.fn>;
  };
  sign: ReturnType<typeof vi.fn>;
  signMessage: ReturnType<typeof vi.fn>;
  response: PrepareLaunchResponse;
  mint: Keypair;
  /** The answer the simulation follows (a rebuild may change it). */
  state: { current: PrepareLaunchResponse };
}

const TOKEN = 'T'.repeat(43);

function harness(
  options: { balance?: bigint; answer?: Partial<PrepareLaunchResponse>; rebuild?: boolean } = {},
): Harness {
  const { response, mint } = buildFixtureLaunch({
    wallet: walletKp.publicKey,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: BigInt(500000000),
    poolCreationFeeLamports: BigInt(10000000),
    networkFeeLamports: BigInt(10000),
    accountRentLamports: BigInt(20000000),
  });
  const merged: PrepareLaunchResponse = {
    ...response,
    ...(options.rebuild ? { rebuildToken: TOKEN } : {}),
    ...options.answer,
  };
  const state = { current: merged };
  const api: Harness['api'] = { prepare: vi.fn().mockResolvedValue(merged) };
  if (options.rebuild) api.rebuild = vi.fn(async () => state.current);
  const balance = options.balance ?? BigInt(10000000000);
  const chain = {
    getBalanceLamports: vi.fn().mockResolvedValue(options.balance ?? BigInt(10000000000)),
    getAccounts: vi.fn().mockImplementation(async () => [
      { lamports: options.balance ?? BigInt(10000000000), owner: PublicKey.default.toBase58(), data: new Uint8Array() },
      null,
    ]),
    simulateTransaction: vi.fn().mockImplementation(async () => {
      const summary = state.current.summary;
      const total = BigInt(summary.poolCreationFeeLamports) + BigInt(summary.firstBuyLamports) + BigInt(summary.platformFeeLamports) +
        BigInt(summary.estimatedNetworkFeeLamports) + BigInt(summary.accountRentLamports) + BigInt(summary.metadataFeeLamports);
      const token = Buffer.alloc(165);
      new PublicKey(state.current.mint).toBuffer().copy(token, 0);
      walletKp.publicKey.toBuffer().copy(token, 32);
      token.writeBigUInt64LE(BigInt(summary.firstBuyMinimumTokensOut), 64);
      return { err: null, logs: [], accounts: [
        { lamports: balance - total, owner: PublicKey.default.toBase58(), data: new Uint8Array() },
        { lamports: BigInt(2039280), owner: TOKEN_PROGRAM_ID.toBase58(), data: token },
      ] };
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('5igSignature'),
    getSignatureStatus: vi.fn().mockResolvedValue({ confirmationStatus: 'confirmed', err: null }),
  };
  const sign = vi.fn(async (tx: VersionedTransaction) => {
    tx.sign([walletKp]);
    return tx;
  });
  const signMessage = vi.fn(async () => new Uint8Array(64));
  wallet.current = { publicKey: walletKp.publicKey, signTransaction: sign, signMessage };
  return { api, chain, sign, signMessage, response: merged, mint, state };
}

function renderCreate(h: Harness, props: Record<string, unknown> = {}) {
  return render(
    <CreateCoin
      mode="live"
      api={h.api}
      chain={h.chain}
      poolCreationFeeSol={0.01}
      confirmOptions={{ sleep: async () => {}, intervalMs: 1 }}
      {...props}
    />,
  );
}

function fillValidForm() {
  fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Moon Coin' } });
  fireEvent.change(screen.getByLabelText('Symbol*'), { target: { value: 'moon' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'To the moon' } });
  fireEvent.change(screen.getByLabelText(/Coin image/), {
    target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] },
  });
  fireEvent.change(screen.getByLabelText(/First buy/), { target: { value: '0.5' } });
}

beforeEach(() => {
  wallet.setShowModal.mockReset();
  wallet.useWalletCalls = 0;
  vi.stubEnv('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', FIXTURE_PLATFORM_FEE_WALLET.toBase58());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CreateCoin form', () => {
  it('asks to connect a wallet when none is connected', () => {
    const h = harness();
    wallet.current = { publicKey: null, signTransaction: undefined, signMessage: undefined };
    renderCreate(h);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(wallet.setShowModal).toHaveBeenCalledWith(true);
  });

  it('shows the configured creation fee before anything is prepared', () => {
    renderCreate(harness());
    expect(screen.getByText(/Creation fee/)).toBeInTheDocument();
    expect(screen.getByText('0.01 SOL')).toBeInTheDocument();
  });

  it('validates the form and does not call the server when invalid', async () => {
    const h = harness();
    renderCreate(h);
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    expect(await screen.findByText('Name must be at least 3 characters.')).toBeInTheDocument();
    expect(screen.getByText('Symbol must be 2 to 10 characters.')).toBeInTheDocument();
    expect(screen.getByText('A coin image is required.')).toBeInTheDocument();
    expect(h.api.prepare).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('rejects a malformed first buy amount', async () => {
    const h = harness();
    renderCreate(h);
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/First buy/), { target: { value: '1e3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    expect(await screen.findByText(/First buy must be a number/)).toBeInTheDocument();
    expect(h.api.prepare).not.toHaveBeenCalled();
  });
});

describe('CreateCoin launchpad config', () => {
  it('takes the config from forge.config.json only: a launchpadConfig prop changes nothing', async () => {
    const h = harness();
    // Not part of the props any more; a caller passing one anyway must not redirect creation.
    renderCreate(h, { launchpadConfig: Keypair.generate().publicKey.toBase58() });
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    // The fixture is on FIXTURE_LAUNCHPAD_CONFIG (forge.config.json): it verifies.
    expect(await screen.findByText('Review your launch')).toBeInTheDocument();
  });

  it('has no launchpadConfig override in its source', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // jsdom environment: resolve from the package root (the test runner's working directory).
    const source = readFileSync(join(process.cwd(), 'src/forge/CreateCoin.tsx'), 'utf8');
    expect(source).not.toMatch(/props\.launchpadConfig/);
    expect(source).not.toMatch(/launchpadConfig\?:/);
  });
});

describe('CreateCoin summary before signing', () => {
  it('shows fees, first buy, network fee and total BEFORE the wallet is asked to sign', async () => {
    const h = harness();
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));

    const review = await screen.findByText('Review your launch');
    expect(review).toBeInTheDocument();
    const summary = within(
      document.querySelector('[data-forge="create-coin-review"]') as HTMLElement,
    );
    expect(summary.getByText('Moon Coin (MOON)')).toBeInTheDocument();
    expect(summary.getByText(/Creation fee/)).toBeInTheDocument();
    expect(summary.getByText('0.01 SOL')).toBeInTheDocument();
    expect(summary.getByText('0.5 SOL')).toBeInTheDocument();
    expect(summary.getByText(/Network fee/)).toBeInTheDocument();
    expect(summary.getByText('0.00001 SOL')).toBeInTheDocument();
    expect(summary.getByText('0.02 SOL')).toBeInTheDocument();
    // 0.3% FORGE platform fee on the 0.5 SOL first buy, shown before signing and in the total.
    expect(summary.getByTestId('review-platform-fee')).toHaveTextContent(
      'FORGE platform fee (0.3% of the first buy)',
    );
    expect(summary.getByTestId('review-platform-fee')).toHaveTextContent('0.0015 SOL');
    expect(summary.getByTestId('review-total')).toHaveTextContent('0.53151 SOL');

    // The server was called once with the typed values, nothing was signed or sent yet.
    expect(h.api.prepare).toHaveBeenCalledTimes(1);
    expect(h.api.prepare.mock.calls[0][0]).toMatchObject({
      tokenName: 'Moon Coin',
      tokenSymbol: 'MOON',
      firstBuyLamports: '500000000',
    });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('signs, sends, confirms and shows success after the user confirms the summary', async () => {
    const h = harness();
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');

    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText('Your coin is live')).toBeInTheDocument();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'View your coin' })).toHaveAttribute(
      'href',
      `/token/${h.response.mint}`,
    );
  });

  it('blocks signing when the wallet cannot afford the total', async () => {
    const h = harness({ balance: BigInt(1000) });
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    expect(screen.getByRole('alert')).toHaveTextContent(/Not enough SOL/);
    expect(screen.getByRole('button', { name: 'Sign and launch' })).toBeDisabled();
  });

  it('lets the user go back from the summary to edit', async () => {
    const h = harness();
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name*')).toHaveValue('Moon Coin');
  });
});

describe('CreateCoin failure states', () => {
  it('shows a server failure and keeps the form', async () => {
    const h = harness();
    h.api.prepare.mockRejectedValue(new Error('x'));
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not prepare/);
    expect(screen.getByLabelText('Name*')).toHaveValue('Moon Coin');
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('refuses a prepared transaction that does not match the form', async () => {
    const h = harness();
    const tampered = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(9000000000),
    });
    h.api.prepare.mockResolvedValue(tampered.response);
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/first buy does not match/);
    expect(screen.queryByText('Review your launch')).not.toBeInTheDocument();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('stays on the summary when the user declines the signature', async () => {
    const h = harness();
    h.sign.mockRejectedValue(new Error('User rejected the request'));
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/);
    expect(screen.getByRole('button', { name: 'Sign and launch' })).toBeEnabled();
    expect(h.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('shows an on-chain failure with the transaction link', async () => {
    const h = harness();
    h.chain.getSignatureStatus.mockResolvedValue({
      confirmationStatus: 'confirmed',
      err: { InstructionError: [0, 'Custom'] },
    });
    renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/failed on-chain/);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/InstructionError|Custom/);
    expect(screen.getByRole('link', { name: '5igSignature' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Editing keeps every input.
    fireEvent.click(screen.getByRole('button', { name: 'Edit coin' }));
    expect(screen.getByLabelText('Name*')).toHaveValue('Moon Coin');
    expect(screen.getByLabelText('Symbol*')).toHaveValue('MOON');
    expect(screen.getByLabelText('Description')).toHaveValue('To the moon');
    expect(screen.getByLabelText(/First buy/)).toHaveValue('0.5');
    expect(screen.getByText('logo.png')).toBeInTheDocument();
  });

  it('offers to check again after a confirmation timeout, without resending', async () => {
    const h = harness();
    h.chain.getSignatureStatus.mockResolvedValue(null);
    renderCreate(h, { confirmOptions: { sleep: async () => {}, intervalMs: 1, timeoutMs: 0 } });
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText(/not confirmed yet/)).toBeInTheDocument();

    h.chain.getSignatureStatus.mockResolvedValue({ confirmationStatus: 'confirmed', err: null });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Your coin is live')).toBeInTheDocument();
    expect(h.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
  });
});

describe('CreateCoin modes', () => {
  it.each(['sleeping', 'disabled'] as const)(
    'is unavailable in %s mode: banner only, no form, no wallet, no network',
    (mode) => {
      const h = harness();
      renderCreate(h, { mode });
      expect(screen.getByRole('status')).toHaveAttribute('data-forge-mode', mode);
      expect(screen.queryByLabelText('Name*')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(wallet.useWalletCalls).toBe(0);
      expect(h.api.prepare).not.toHaveBeenCalled();
      expect(h.chain.getBalanceLamports).not.toHaveBeenCalled();
    },
  );

  it('shows the sleeping explanation', () => {
    renderCreate(harness(), { mode: 'sleeping' });
    expect(screen.getByText('This launchpad is sleeping')).toBeInTheDocument();
  });

  it('shows the maintenance explanation when disabled', () => {
    renderCreate(harness(), { mode: 'disabled' });
    expect(screen.getByText('Under maintenance')).toBeInTheDocument();
  });
});

/** Status null and a block height that moves past the expiry: the transaction expired. */
function expireOnSend(h: Harness) {
  let height = 1000;
  Object.assign(h.chain, { getBlockHeight: vi.fn(async () => height) });
  h.chain.getSignatureStatus.mockImplementation(async () => {
    height += 200;
    return null;
  });
}

async function toReview(h: Harness, props: Record<string, unknown> = {}) {
  renderCreate(h, props);
  fillValidForm();
  fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
  await screen.findByText('Review your launch');
}

describe('CreateCoin form guidance', () => {
  it('on submit with errors: summary near the button and focus on the first invalid field', async () => {
    const h = harness();
    renderCreate(h);
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Moon Coin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    const summary = document.querySelector('[data-forge="create-coin-error-summary"]') as HTMLElement;
    expect(summary).toHaveTextContent('Fix 2 fields to continue:');
    expect(within(summary).getByRole('button', { name: 'Coin image' })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Symbol' })).toBeInTheDocument();
    // The image comes first in the form: it gets the focus.
    expect(document.activeElement).toBe(screen.getByLabelText(/Coin image/));
    fireEvent.click(within(summary).getByRole('button', { name: 'Symbol' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Symbol*'));
  });

  it('counts the name in bytes as it is typed (accents and emoji count more)', () => {
    renderCreate(harness());
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Moon' } });
    expect(document.getElementById('coinName-count')).toHaveTextContent('4/32');
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Café 🚀' } });
    expect(document.getElementById('coinName-count')).toHaveTextContent('10/32');
    expect(document.getElementById('coinName-count')).toHaveTextContent(/bytes used/);
  });

  it('refuses a name beyond 32 bytes before calling the server', async () => {
    const h = harness();
    renderCreate(h);
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'é'.repeat(17) } });
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    expect(await screen.findByText(/accents or emoji take 2 to 4 each/)).toBeInTheDocument();
    expect(h.api.prepare).not.toHaveBeenCalled();
  });

  it('shows a live preview of the coin as it is typed', () => {
    renderCreate(harness());
    const preview = within(
      document.querySelector('[data-forge="create-coin-preview"]') as HTMLElement,
    );
    expect(preview.getByText('TICKER')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Moon Coin' } });
    fireEvent.change(screen.getByLabelText('Symbol*'), { target: { value: 'moon' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'To the moon' } });
    expect(preview.getByText('MOON')).toBeInTheDocument();
    expect(preview.getByText('Moon Coin')).toBeInTheDocument();
    expect(preview.getByText('To the moon')).toBeInTheDocument();
    // The preview reuses the market row style.
    expect(document.querySelector('[data-forge="create-coin-preview"] .launchpad-token-row')).not.toBeNull();
  });

  it('explains that the message signature is free and locks the inputs while preparing', async () => {
    const h = harness();
    let release: (value: PrepareLaunchResponse) => void = () => {};
    h.api.prepare.mockImplementation(
      () => new Promise<PrepareLaunchResponse>((resolve) => (release = resolve)),
    );
    renderCreate(h);
    fillValidForm();
    expect(screen.getByText(/free signature \(not a transaction\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    const steps = await screen.findByText('Upload the image');
    await waitFor(() => expect(steps.closest('li')).toHaveAttribute('aria-current', 'step'));
    expect(screen.getByLabelText('Name*')).toBeDisabled();
    expect(screen.getByLabelText(/First buy/)).toBeDisabled();
    expect(screen.getByRole('button', { name: /Preparing/ })).toBeDisabled();
    release(h.response);
    expect(await screen.findByText('Review your launch')).toBeInTheDocument();
  });

  it('tells a wallet that cannot sign messages what to do, and offers no submit', () => {
    const h = harness();
    wallet.current = { ...wallet.current, signMessage: undefined };
    renderCreate(h);
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot sign messages/);
    expect(screen.queryByRole('button', { name: 'Review launch' })).not.toBeInTheDocument();
  });

  it('shows a calm message when coin creation is unavailable (no relay)', async () => {
    const { CreateCoin: Fresh } = await import('@/forge/CreateCoin');
    harness();
    render(<Fresh mode="live" poolCreationFeeSol={0.01} />);
    expect(screen.getByText(/not available on this site right now/)).toBeInTheDocument();
    expect(screen.queryByText(/RPC relay/)).not.toBeInTheDocument();
  });
});

describe('CreateCoin image dropzone', () => {
  const imageInput = () => screen.getByLabelText(/Coin image/) as HTMLInputElement;

  it('hides the native file input text and keeps the input reachable', () => {
    renderCreate(harness());
    expect(imageInput()).toHaveAttribute('type', 'file');
    expect(imageInput()).toHaveClass('sr-only');
    expect(screen.getByText('Drop your image here')).toBeInTheDocument();
    expect(screen.queryByText(/No file chosen/)).not.toBeInTheDocument();
  });

  it('refuses a wrong type or a file above 2 MB as soon as it is picked', () => {
    renderCreate(harness());
    fireEvent.change(imageInput(), {
      target: { files: [new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' })] },
    });
    expect(screen.getByText('Image must be a PNG, JPEG, WebP or GIF file.')).toBeInTheDocument();
    expect(screen.queryByText('paper.pdf')).not.toBeInTheDocument();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(imageInput(), { target: { files: [big] } });
    expect(screen.getByText('Image must be 2 MB or smaller.')).toBeInTheDocument();
  });

  it('accepts a dropped image, shows it, and can remove it', () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    renderCreate(harness());
    const zone = document.querySelector('[data-forge="create-coin-image"] label') as HTMLElement;
    const file = new File(['png'], 'a-very-long-file-name-for-a-coin-image-that-keeps-going.png', {
      type: 'image/png',
    });
    fireEvent.dragEnter(zone, { dataTransfer: { files: [file] } });
    expect(zone).toHaveAttribute('data-dragging', 'true');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    const name = screen.getByText(file.name);
    expect(name).toHaveClass('truncate');
    expect(name).toHaveAttribute('title', file.name);
    expect(screen.getByAltText('Selected coin image')).toHaveAttribute('src', 'blob:preview');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText(file.name)).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    Object.assign(URL, original);
  });
});

describe('CreateCoin keeps the form and rebuilds instead of starting over', () => {
  it('on an expired transaction: "Try again" rebuilds a fresh transaction for the same coin', async () => {
    const h = harness({ rebuild: true });
    expireOnSend(h);
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
    expect(screen.getByRole('alert')).toHaveTextContent(/safely try again/);

    h.chain.getSignatureStatus.mockResolvedValue({ confirmationStatus: 'confirmed', err: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Review your launch')).toBeInTheDocument();
    expect(h.api.rebuild).toHaveBeenCalledTimes(1);
    expect(h.api.rebuild?.mock.calls[0][0]).toMatchObject({
      mint: h.response.mint,
      rebuildToken: TOKEN,
      firstBuyLamports: '500000000',
    });
    // No new upload and no new message signature.
    expect(h.api.prepare).toHaveBeenCalledTimes(1);
    expect(h.signMessage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText('Your coin is live')).toBeInTheDocument();
    expect(h.chain.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it('on an expired transaction without a rebuild: back to the form with every input kept', async () => {
    const h = harness();
    expireOnSend(h);
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Your coin details are kept/);
    expect(screen.getByLabelText('Name*')).toHaveValue('Moon Coin');
    expect(screen.getByLabelText('Symbol*')).toHaveValue('MOON');
    expect(screen.getByText('logo.png')).toBeInTheDocument();
    expect(screen.getByLabelText(/First buy/)).toHaveValue('0.5');
  });

  it('refreshes a review older than the safe window before signing', async () => {
    let clock = Date.parse('2026-10-17T10:00:00.000Z');
    const h = harness({ rebuild: true });
    await toReview(h, { now: () => new Date(clock) });
    clock += 30_000;
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText('Your coin is live')).toBeInTheDocument();
    expect(h.api.rebuild).toHaveBeenCalledTimes(1);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('does not sign a refreshed transaction that costs more: shows the new total first', async () => {
    let clock = Date.parse('2026-10-17T10:00:00.000Z');
    const h = harness({ rebuild: true });
    await toReview(h, { now: () => new Date(clock) });
    const pricier = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(500000000),
      poolCreationFeeLamports: BigInt(10000000),
      networkFeeLamports: BigInt(10000),
      accountRentLamports: BigInt(30000000),
      mint: h.mint,
    });
    h.api.rebuild?.mockImplementation(async () => {
      h.state.current = { ...pricier.response, rebuildToken: TOKEN };
      return h.state.current;
    });
    clock += 30_000;
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText(/network fee changed/)).toBeInTheDocument();
    expect(screen.getByTestId('review-total')).toHaveTextContent('0.54151 SOL');
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('going back and changing only the first buy rebuilds without a new upload or signature', async () => {
    const h = harness({ rebuild: true });
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const lower = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(100000000),
      poolCreationFeeLamports: BigInt(10000000),
      mint: h.mint,
    });
    h.api.rebuild?.mockImplementation(async () => {
      h.state.current = { ...lower.response, rebuildToken: TOKEN };
      return h.state.current;
    });
    fireEvent.change(screen.getByLabelText(/First buy/), { target: { value: '0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    expect(h.api.rebuild?.mock.calls[0][0]).toMatchObject({ firstBuyLamports: '100000000' });
    expect(h.api.prepare).toHaveBeenCalledTimes(1);
    expect(h.signMessage).toHaveBeenCalledTimes(1);
  });

  it('a changed name after going back prepares the coin again in full', async () => {
    const h = harness({ rebuild: true });
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'Moon Coin' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Other text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await waitFor(() => expect(h.api.prepare).toHaveBeenCalledTimes(2));
    expect(h.api.rebuild).not.toHaveBeenCalled();
  });

  it('not enough SOL: lower the first buy from the review and rebuild', async () => {
    const h = harness({ rebuild: true, balance: BigInt(300000000) });
    await toReview(h);
    expect(screen.getByRole('alert')).toHaveTextContent(/Not enough SOL/);
    const input = screen.getByLabelText('New first buy (SOL)');
    expect(input).toHaveValue('0.269');
    const fit = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(269000000),
      poolCreationFeeLamports: BigInt(10000000),
      mint: h.mint,
    });
    h.api.rebuild?.mockImplementation(async () => {
      h.state.current = { ...fit.response, rebuildToken: TOKEN };
      return h.state.current;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update first buy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign and launch' })).toBeEnabled());
    expect(h.api.rebuild?.mock.calls[0][0]).toMatchObject({ firstBuyLamports: '269000000' });
    expect(screen.queryByText(/Not enough SOL/)).not.toBeInTheDocument();
    // The form follows the new amount.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText(/First buy/)).toHaveValue('0.269');
  });

  it('a wallet that disconnects during the review gets a reconnect button, not a dead button', async () => {
    const h = harness();
    const view = renderCreate(h);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review launch' }));
    await screen.findByText('Review your launch');
    wallet.current = { publicKey: null, signTransaction: undefined, signMessage: undefined };
    view.rerender(
      <CreateCoin
        mode="live"
        api={h.api}
        chain={h.chain}
        poolCreationFeeSol={0.01}
        confirmOptions={{ sleep: async () => {}, intervalMs: 1 }}
      />,
    );
    expect(screen.getByText(/Your wallet disconnected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign and launch' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(wallet.setShowModal).toHaveBeenCalledWith(true);
  });
});

describe('CreateCoin success screen', () => {
  it('links to the coin page, copies the address, shares on X and explains creator fees', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const h = harness();
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    expect(await screen.findByText('Your coin is live')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'View your coin' })).toHaveAttribute(
      'href',
      `/token/${h.response.mint}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(h.response.mint));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    const share = screen.getByRole('link', { name: 'Share on X' });
    const url = new URL(share.getAttribute('href') as string);
    expect(url.origin).toBe('https://x.com');
    expect(url.pathname).toBe('/intent/tweet');
    expect(url.searchParams.get('text')).toMatch(/Moon Coin \(\$MOON\)/);
    expect(url.searchParams.get('url')).toMatch(new RegExp(`/token/${h.response.mint}$`));
    expect(share).toHaveAttribute('rel', 'noopener noreferrer');

    expect(screen.getByRole('link', { name: 'Go to creator fees' })).toHaveAttribute(
      'href',
      '/creator-fees',
    );
    expect(screen.getByText(/share of the trading fees/)).toBeInTheDocument();
  });

  it('starts a new coin with an empty form', async () => {
    const h = harness();
    await toReview(h);
    fireEvent.click(screen.getByRole('button', { name: 'Sign and launch' }));
    await screen.findByText('Your coin is live');
    fireEvent.click(screen.getByRole('button', { name: 'Create another coin' }));
    expect(screen.getByLabelText('Name*')).toHaveValue('');
  });
});
