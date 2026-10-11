// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_CLAIM_COSTS, createMockClaimsCore, mockCoin } from '@/forge/claims/mock-core';
import { FIXTURE_LAUNCHPAD_CONFIG } from '@/forge/create/test-fixtures';
import type { CreatorClaimCosts, CreatorCoin } from '@/forge/claims/core-adapter';

const walletKp = Keypair.generate();
const wallet = vi.hoisted(() => ({
  current: { publicKey: null as unknown, signTransaction: undefined as unknown },
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

import { ClaimCreatorFees } from '@/forge/ClaimCreatorFees';

function setup(
  coins: CreatorCoin[],
  balance = BigInt(1000000000),
  costs: CreatorClaimCosts = MOCK_CLAIM_COSTS,
) {
  const core = createMockClaimsCore(coins, costs);
  const chain = {
    getBalanceLamports: vi.fn().mockResolvedValue(balance),
    sendRawTransaction: vi.fn().mockResolvedValue('ClaimSig'),
    getSignatureStatus: vi.fn().mockResolvedValue({ confirmationStatus: 'confirmed', err: null }),
  };
  const sign = vi.fn(async (tx: VersionedTransaction) => {
    tx.sign([walletKp]);
    return tx;
  });
  wallet.current = { publicKey: walletKp.publicKey, signTransaction: sign };
  return { core, chain, sign };
}

function renderClaims(s: ReturnType<typeof setup>, props: Record<string, unknown> = {}) {
  return render(
    <ClaimCreatorFees
      mode="live"
      core={s.core}
      chain={s.chain}
      confirmOptions={{ sleep: async () => {}, intervalMs: 1 }}
      launchpadConfigs={[FIXTURE_LAUNCHPAD_CONFIG.toBase58()]}
      {...props}
    />,
  );
}

beforeEach(() => {
  wallet.setShowModal.mockReset();
  wallet.useWalletCalls = 0;
});

describe('ClaimCreatorFees', () => {
  it('asks to connect a wallet', () => {
    const s = setup([]);
    wallet.current = { publicKey: null, signTransaction: undefined };
    renderClaims(s);
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(wallet.setShowModal).toHaveBeenCalledWith(true);
  });

  it('lists the wallet coins with their claimable creator fees', async () => {
    const s = setup([
      mockCoin({ name: 'Moon Coin', symbol: 'MOON', claimableQuoteLamports: BigInt(1500000000) }),
      mockCoin({ name: 'Sun Coin', symbol: 'SUN', claimableQuoteLamports: BigInt(0) }),
    ]);
    renderClaims(s);
    expect(await screen.findByText('Moon Coin (MOON)')).toBeInTheDocument();
    expect(screen.getByText(/Claimable: 1.5 SOL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim fees for Moon Coin' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Claim fees for Sun Coin' })).toBeDisabled();
  });

  it('shows an empty state', async () => {
    renderClaims(setup([]));
    expect(await screen.findByText(/have not created any coin/)).toBeInTheDocument();
  });

  it('shows a load error and retries', async () => {
    const s = setup([mockCoin()]);
    const list = vi
      .spyOn(s.core, 'listCreatorCoins')
      .mockRejectedValueOnce(new Error('relay down'));
    renderClaims(s);
    expect(await screen.findByRole('alert')).toHaveTextContent('relay down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Moon Coin (MOON)')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows the claim summary before signing, with the receiver set to the wallet', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin', symbol: 'MOON' })]);
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));

    const review = await screen.findByLabelText('Claim summary');
    const summary = within(review);
    expect(summary.getByText('1.5 SOL')).toBeInTheDocument();
    expect(summary.getByText(/Network fee/)).toBeInTheDocument();
    expect(summary.getByText('0.000005 SOL')).toBeInTheDocument();
    // The core's costs: one-time coin account rent, total, temporary WSOL rent, required balance.
    expect(summary.getByText(/Coin account rent/)).toBeInTheDocument();
    expect(summary.getAllByText('0.00203928 SOL')).toHaveLength(2);
    expect(summary.getByText(/Total cost/)).toBeInTheDocument();
    expect(summary.getByText('0.00204428 SOL')).toBeInTheDocument();
    expect(summary.getByText(/Temporary deposit/)).toBeInTheDocument();
    expect(summary.getByText('0.00408356 SOL')).toBeInTheDocument();
    expect(summary.getByText(new RegExp(walletKp.publicKey.toBase58()))).toBeInTheDocument();
    expect(s.core.built).toEqual([
      {
        pool: expect.any(String),
        creator: walletKp.publicKey.toBase58(),
        receiver: walletKp.publicKey.toBase58(),
      },
    ]);
    expect(s.sign).not.toHaveBeenCalled();
    expect(s.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('signs, sends, confirms and refreshes the list', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin', symbol: 'MOON' })]);
    const list = vi.spyOn(s.core, 'listCreatorCoins');
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    await screen.findByLabelText('Claim summary');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and claim' }));

    expect(await screen.findByText(/Claimed 1.5 SOL/)).toBeInTheDocument();
    expect(s.sign).toHaveBeenCalledTimes(1);
    expect(s.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Claim summary')).not.toBeInTheDocument();
  });

  it('stays on the summary when the signature is declined', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin' })]);
    s.sign.mockRejectedValue(new Error('User rejected the request'));
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    await screen.findByLabelText('Claim summary');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and claim' }));
    expect(await screen.findByText(/declined/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign and claim' })).toBeEnabled();
    expect(s.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('shows an on-chain failure', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin' })]);
    s.chain.getSignatureStatus.mockResolvedValue({
      confirmationStatus: 'confirmed',
      err: { InstructionError: [0, 'Custom'] },
    });
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    await screen.findByLabelText('Claim summary');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/failed on-chain/);
  });

  it('offers to check again after a confirmation timeout', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin' })]);
    s.chain.getSignatureStatus.mockResolvedValue(null);
    renderClaims(s, { confirmOptions: { sleep: async () => {}, intervalMs: 1, timeoutMs: 0 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    await screen.findByLabelText('Claim summary');
    fireEvent.click(screen.getByRole('button', { name: 'Sign and claim' }));
    const again = await screen.findByRole('button', { name: 'Check again' });
    s.chain.getSignatureStatus.mockResolvedValue({ confirmationStatus: 'confirmed', err: null });
    fireEvent.click(again);
    expect(await screen.findByText(/Claimed 1.5 SOL/)).toBeInTheDocument();
    expect(s.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('blocks the claim when the wallet cannot pay the network fee', async () => {
    const s = setup([mockCoin({ name: 'Moon Coin' })], BigInt(100));
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    await screen.findByLabelText('Claim summary');
    expect(screen.getByRole('button', { name: 'Sign and claim' })).toBeDisabled();
  });

  it('blocks the claim when the wallet pays the fee but not the coin account rent', async () => {
    // Enough for the network fee and the one-time rent, not for the temporary WSOL rent.
    const s = setup([mockCoin({ name: 'Moon Coin' })], BigInt(2044280));
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    const review = await screen.findByLabelText('Claim summary');
    expect(within(review).getByRole('alert')).toHaveTextContent(/at least 0.00408356 SOL/);
    expect(screen.getByRole('button', { name: 'Sign and claim' })).toBeDisabled();
  });

  it('hides the rent rows when the accounts already exist', async () => {
    const fee = BigInt(5000);
    const zero = BigInt(0);
    const s = setup([mockCoin({ name: 'Moon Coin' })], BigInt(6000), {
      networkFeeLamports: fee,
      receiverTokenAccountRentLamports: zero,
      temporaryLamports: zero,
      payerTotalLamports: fee,
      payerRequiredBalanceLamports: fee,
    });
    renderClaims(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Claim fees for Moon Coin' }));
    const review = within(await screen.findByLabelText('Claim summary'));
    expect(review.queryByText(/Coin account rent/)).not.toBeInTheDocument();
    expect(review.queryByText(/Temporary deposit/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign and claim' })).toBeEnabled();
  });

  it('fails loudly with the default adapter when the relay is not configured', async () => {
    const s = setup([]);
    render(<ClaimCreatorFees mode="live" chain={s.chain} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/);
  });

  it.each(['sleeping', 'disabled'] as const)('is unavailable in %s mode', (mode) => {
    const s = setup([mockCoin()]);
    const list = vi.spyOn(s.core, 'listCreatorCoins');
    renderClaims(s, { mode });
    expect(screen.getByRole('status')).toHaveAttribute('data-forge-mode', mode);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(wallet.useWalletCalls).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });
});
