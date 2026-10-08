// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchApi } from '@/forge/create/api';
import type { ChainClient } from '@/forge/create/chain';
import { TxError, executeLaunch, prepareLaunch, type LaunchDeps } from '@/forge/create/flow';
import { buildFixtureLaunch } from '@/forge/create/test-fixtures';
import type { ValidatedCoin } from '@/forge/create/validation';

const walletKp = Keypair.generate();
const coin: ValidatedCoin = {
  name: 'Moon Coin',
  symbol: 'MOON',
  description: 'desc',
  firstBuyLamports: BigInt(500000000),
};
const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

function setup(options: { balance?: bigint | Error; fee?: bigint } = {}) {
  const { response } = buildFixtureLaunch({
    wallet: walletKp.publicKey,
    name: coin.name,
    symbol: coin.symbol,
    firstBuyLamports: coin.firstBuyLamports,
    poolCreationFeeLamports: options.fee ?? BigInt(10000000),
  });
  const api: LaunchApi = { prepare: vi.fn().mockResolvedValue(response) };
  const chain = {
    getBalanceLamports: vi.fn().mockImplementation(async () => {
      if (options.balance instanceof Error) throw options.balance;
      return options.balance ?? BigInt(10000000000);
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
    getSignatureStatus: vi.fn().mockResolvedValue({ confirmationStatus: 'confirmed', err: null }),
  } satisfies ChainClient;
  const signTransaction = vi.fn(async (tx: VersionedTransaction) => {
    tx.sign([walletKp]);
    return tx;
  });
  const deps: LaunchDeps = {
    api,
    chain,
    signTransaction: signTransaction as unknown as LaunchDeps['signTransaction'],
    wallet: walletKp.publicKey.toBase58(),
    poolCreationFeeLamports: BigInt(10000000),
    confirm: { sleep: async () => {}, intervalMs: 1 },
  };
  return { deps, api, chain, signTransaction, response };
}

describe('prepareLaunch', () => {
  it('sends the typed values and returns a verified review with the balance', async () => {
    const { deps, api } = setup();
    const review = await prepareLaunch(coin, image, deps);
    const request = (api.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request).toMatchObject({
      tokenName: 'Moon Coin',
      tokenSymbol: 'MOON',
      description: 'desc',
      userWallet: walletKp.publicKey.toBase58(),
      firstBuyLamports: '500000000',
    });
    expect(request.tokenLogo).toMatch(/^data:image\/png;base64,/);
    expect(review.summary.totalLamports).toBe(
      BigInt(500000000) + BigInt(10000000) + BigInt(10000) + BigInt(20000000),
    );
    expect(review.insufficientBalance).toBe(false);
  });

  it('flags an insufficient balance', async () => {
    const { deps } = setup({ balance: BigInt(1000) });
    expect((await prepareLaunch(coin, image, deps)).insufficientBalance).toBe(true);
  });

  it('does not block when the balance cannot be read', async () => {
    const { deps } = setup({ balance: new Error('relay down') });
    const review = await prepareLaunch(coin, image, deps);
    expect(review.balanceLamports).toBeNull();
    expect(review.insufficientBalance).toBe(false);
  });

  it('reports a server failure as prepare_failed', async () => {
    const { deps } = setup();
    deps.api = { prepare: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(prepareLaunch(coin, image, deps)).rejects.toMatchObject({
      code: 'prepare_failed',
      stage: 'prepare',
    });
  });

  it('refuses a creation fee that differs from the configuration', async () => {
    const { deps } = setup({ fee: BigInt(900000000) });
    await expect(prepareLaunch(coin, image, deps)).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });
});

describe('executeLaunch', () => {
  it('signs, sends once, polls and returns the signature and mint', async () => {
    const { deps, chain, signTransaction } = setup();
    const review = await prepareLaunch(coin, image, deps);
    const phases: string[] = [];
    const result = await executeLaunch(review, deps, (p) => phases.push(p));
    expect(result).toEqual({ signature: 'SIG', mint: review.mint });
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['signing', 'sending', 'confirming']);
  });

  it('does not sign when the balance is insufficient', async () => {
    const { deps, signTransaction } = setup({ balance: BigInt(1000) });
    const review = await prepareLaunch(coin, image, deps);
    await expect(executeLaunch(review, deps)).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('maps a declined signature and never sends', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    deps.signTransaction = vi.fn().mockRejectedValue(new Error('User rejected the request'));
    await expect(executeLaunch(review, deps)).rejects.toMatchObject({ code: 'user_rejected' });
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses to send a transaction the wallet left incomplete', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    deps.signTransaction = vi.fn(async (tx: VersionedTransaction) => tx) as never;
    await expect(executeLaunch(review, deps)).rejects.toMatchObject({ code: 'sign_failed' });
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('reports a network rejection at send', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    chain.sendRawTransaction.mockRejectedValue(new Error('Simulation failed'));
    await expect(executeLaunch(review, deps)).rejects.toMatchObject({
      code: 'send_failed',
      stage: 'send',
    });
  });

  it('reports an on-chain failure with the signature', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    chain.getSignatureStatus.mockResolvedValue({
      confirmationStatus: 'confirmed',
      err: { InstructionError: [1, 'Custom'] },
    });
    const error = await executeLaunch(review, deps).catch((e) => e);
    expect(error).toBeInstanceOf(TxError);
    expect(error).toMatchObject({ code: 'onchain_failed', signature: 'SIG' });
  });

  it('reports a confirmation timeout with the signature and without resending', async () => {
    const { deps, chain } = setup();
    deps.confirm = { sleep: async () => {}, intervalMs: 1, timeoutMs: 0 };
    const review = await prepareLaunch(coin, image, deps);
    chain.getSignatureStatus.mockResolvedValue(null);
    const error = await executeLaunch(review, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'timeout', signature: 'SIG' });
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
