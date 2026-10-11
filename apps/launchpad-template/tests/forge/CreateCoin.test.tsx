// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchApi, PrepareLaunchResponse } from '@/forge/create/api';
import type { ChainClient } from '@/forge/create/chain';
import { buildFixtureLaunch, FIXTURE_LAUNCHPAD_CONFIG } from '@/forge/create/test-fixtures';

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

import { CreateCoin } from '@/forge/CreateCoin';

interface Harness {
  api: LaunchApi & { prepare: ReturnType<typeof vi.fn> };
  chain: ChainClient & {
    getBalanceLamports: ReturnType<typeof vi.fn>;
    getAccounts: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendRawTransaction: ReturnType<typeof vi.fn>;
    getSignatureStatus: ReturnType<typeof vi.fn>;
  };
  sign: ReturnType<typeof vi.fn>;
  response: PrepareLaunchResponse;
}

function harness(
  options: { balance?: bigint; answer?: Partial<PrepareLaunchResponse> } = {},
): Harness {
  const { response } = buildFixtureLaunch({
    wallet: walletKp.publicKey,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: BigInt(500000000),
    poolCreationFeeLamports: BigInt(10000000),
    networkFeeLamports: BigInt(10000),
    accountRentLamports: BigInt(20000000),
  });
  const merged = { ...response, ...options.answer };
  const api = { prepare: vi.fn().mockResolvedValue(merged) };
  const chain = {
    getBalanceLamports: vi.fn().mockResolvedValue(options.balance ?? BigInt(10000000000)),
    getAccounts: vi.fn().mockImplementation(async () => [
      { lamports: options.balance ?? BigInt(10000000000), owner: PublicKey.default.toBase58(), data: new Uint8Array() },
      null,
    ]),
    simulateTransaction: vi.fn().mockImplementation(async () => {
      const summary = merged.summary;
      const total = BigInt(summary.poolCreationFeeLamports) + BigInt(summary.firstBuyLamports) +
        BigInt(summary.estimatedNetworkFeeLamports) + BigInt(summary.accountRentLamports) + BigInt(summary.metadataFeeLamports);
      const token = Buffer.alloc(165);
      new PublicKey(merged.mint).toBuffer().copy(token, 0);
      walletKp.publicKey.toBuffer().copy(token, 32);
      token.writeBigUInt64LE(BigInt(summary.firstBuyMinimumTokensOut), 64);
      return { err: null, logs: [], accounts: [
        { lamports: BigInt(10000000000) - total, owner: PublicKey.default.toBase58(), data: new Uint8Array() },
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
  return { api, chain, sign, response: merged };
}

function renderCreate(h: Harness, props: Record<string, unknown> = {}) {
  return render(
    <CreateCoin
      mode="live"
      api={h.api}
      chain={h.chain}
      poolCreationFeeSol={0.01}
      launchpadConfig={FIXTURE_LAUNCHPAD_CONFIG.toBase58()}
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
    expect(summary.getByTestId('review-total')).toHaveTextContent('0.53001 SOL');

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
    expect(screen.getByRole('link', { name: '5igSignature' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
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
