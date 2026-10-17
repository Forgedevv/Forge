// @vitest-environment jsdom
import '../helpers/dom-setup';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchApiError, type LaunchApi, type PrepareLaunchResponse } from '@/forge/create/api';
import type { ChainClient } from '@/forge/create/chain';
import { RpcError } from '@/forge/create/chain';
import {
  TxError,
  affordableFirstBuyLamports,
  costRose,
  executeLaunch,
  prepareLaunch,
  rebuildLaunch,
  reviewAge,
  waitForLaunch,
  type LaunchDeps,
} from '@/forge/create/flow';
import {
  buildFixtureLaunch,
  FIXTURE_LAUNCHPAD_CONFIG,
  FIXTURE_PLATFORM_FEE_WALLET,
} from '@/forge/create/test-fixtures';
import type { ValidatedCoin } from '@/forge/create/validation';

const walletKp = Keypair.generate();
const coin: ValidatedCoin = {
  name: 'Moon Coin',
  symbol: 'MOON',
  description: 'desc',
  firstBuyLamports: BigInt(500000000),
};
const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
/** 0.3% of the 0.5 SOL first buy. */
const PLATFORM_FEE = BigInt(1500000);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', FIXTURE_PLATFORM_FEE_WALLET.toBase58());
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function setup(options: { balance?: bigint | Error; fee?: bigint } = {}) {
  const { response, mint } = buildFixtureLaunch({
    wallet: walletKp.publicKey,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
    name: coin.name,
    symbol: coin.symbol,
    firstBuyLamports: coin.firstBuyLamports,
    poolCreationFeeLamports: options.fee ?? BigInt(10000000),
  });
  // The answer the simulation follows (a rebuild may change it).
  const state = { response: { ...response, rebuildToken: 'T'.repeat(43) } as PrepareLaunchResponse };
  const api: LaunchApi = { prepare: vi.fn().mockResolvedValue(state.response) };
  const chain = {
    getBalanceLamports: vi.fn().mockImplementation(async () => {
      if (options.balance instanceof Error) throw options.balance;
      return options.balance ?? BigInt(10000000000);
    }),
    getAccounts: vi.fn().mockImplementation(async () => {
      if (options.balance instanceof Error) throw options.balance;
      return [
        { lamports: options.balance ?? BigInt(10000000000), owner: PublicKey.default.toBase58(), data: new Uint8Array() },
        null,
      ];
    }),
    simulateTransaction: vi.fn().mockImplementation(async (_tx: string, addresses: string[]) => {
      const balance = options.balance instanceof Error ? BigInt(10000000000) : options.balance ?? BigInt(10000000000);
      const summary = state.response.summary;
      const total = BigInt(summary.poolCreationFeeLamports) + BigInt(summary.firstBuyLamports) + BigInt(summary.platformFeeLamports) +
        BigInt(summary.estimatedNetworkFeeLamports) + BigInt(summary.accountRentLamports) + BigInt(summary.metadataFeeLamports);
      const token = Buffer.alloc(165);
      new PublicKey(state.response.mint).toBuffer().copy(token, 0);
      walletKp.publicKey.toBuffer().copy(token, 32);
      token.writeBigUInt64LE(BigInt(summary.firstBuyMinimumTokensOut), 64);
      return {
        err: null,
        logs: [],
        accounts: [
          { lamports: balance - total, owner: PublicKey.default.toBase58(), data: new Uint8Array() },
          addresses[1] ? { lamports: BigInt(2039280), owner: TOKEN_PROGRAM_ID.toBase58(), data: token } : null,
        ],
      };
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
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
    signMessage: async () => new Uint8Array(64),
    poolCreationFeeLamports: BigInt(10000000),
    confirm: { sleep: async () => {}, intervalMs: 1 },
  };
  return { deps, api, chain, signTransaction, response, mint, state };
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
      BigInt(500000000) + PLATFORM_FEE + BigInt(10000000) + BigInt(10000) + BigInt(20000000),
    );
    expect(review.summary.platformFeeLamports).toBe(PLATFORM_FEE);
    expect(review.insufficientBalance).toBe(false);
  });

  it('refuses a first buy before any signature when the site has no platform fee wallet', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', '');
    const { deps, api } = setup();
    const signMessage = vi.fn(async () => new Uint8Array(64));
    await expect(prepareLaunch(coin, image, { ...deps, signMessage })).rejects.toMatchObject({
      code: 'prepare_failed',
    });
    expect(signMessage).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('refuses a prepared launch paying the platform fee to another wallet', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', Keypair.generate().publicKey.toBase58());
    const { deps } = setup();
    await expect(prepareLaunch(coin, image, deps)).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });

  it('flags an insufficient balance', async () => {
    const { deps } = setup({ balance: BigInt(1000) });
    expect((await prepareLaunch(coin, image, deps)).insufficientBalance).toBe(true);
  });

  it('fails closed when the transaction state cannot be read', async () => {
    const { deps } = setup({ balance: new Error('relay down') });
    await expect(prepareLaunch(coin, image, deps)).rejects.toMatchObject({ code: 'verification_failed' });
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

describe('prepare progress', () => {
  it('reports the steps in order: sign, upload, check', async () => {
    const { deps } = setup();
    const steps: string[] = [];
    await prepareLaunch(coin, image, deps, (step) => steps.push(step));
    expect(steps).toEqual(['sign', 'upload', 'check']);
  });

  it('asks for no signature when the wallet cannot sign messages, with a clear message', async () => {
    const { deps, api } = setup();
    const error = await prepareLaunch(coin, image, { ...deps, signMessage: undefined }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'prepare_failed' });
    expect((error as Error).message).toMatch(/cannot sign messages/);
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('keeps the rebuild capability and the time of preparation', async () => {
    const { deps } = setup();
    const review = await prepareLaunch(coin, image, { ...deps, now: () => new Date(1_000_000) });
    expect(review.rebuildToken).toBe('T'.repeat(43));
    expect(review.preparedAt).toBe(1_000_000);
    expect(review.coin).toEqual(coin);
    expect(reviewAge(review, { now: () => new Date(1_025_000) })).toBe(25_000);
  });
});

describe('rebuildLaunch', () => {
  it('rebuilds the same launch through the server and verifies it again (no new signature)', async () => {
    const { deps, api, state } = setup();
    const signMessage = vi.fn(async () => new Uint8Array(64));
    const review = await prepareLaunch(coin, image, { ...deps, signMessage });
    const rebuild = vi.fn().mockResolvedValue(state.response);
    deps.api = { ...api, rebuild };
    const next = await rebuildLaunch(review, coin.firstBuyLamports, { ...deps, signMessage });
    expect(rebuild).toHaveBeenCalledWith({
      mint: review.mint,
      rebuildToken: 'T'.repeat(43),
      userWallet: walletKp.publicKey.toBase58(),
      firstBuyLamports: '500000000',
    });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(next.mint).toBe(review.mint);
    expect(next.rebuildToken).toBe('T'.repeat(43));
    expect(costRose(review, next)).toBe(false);
  });

  it('rebuilds with a lower first buy', async () => {
    const { deps, api, mint, state } = setup();
    const review = await prepareLaunch(coin, image, deps);
    const lower = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: BigInt(100000000),
      mint,
    });
    deps.api = {
      ...api,
      rebuild: vi.fn(async () => {
        state.response = lower.response;
        return lower.response;
      }),
    };
    const next = await rebuildLaunch(review, BigInt(100000000), deps);
    expect(next.summary.firstBuyLamports).toBe(BigInt(100000000));
    expect(next.coin.firstBuyLamports).toBe(BigInt(100000000));
    expect(next.coin.name).toBe(coin.name);
  });

  it('refuses a rebuild for another coin address', async () => {
    const { deps, api } = setup();
    const review = await prepareLaunch(coin, image, deps);
    const other = buildFixtureLaunch({
      wallet: walletKp.publicKey,
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: coin.firstBuyLamports,
    });
    deps.api = { ...api, rebuild: vi.fn().mockResolvedValue(other.response) };
    await expect(rebuildLaunch(review, coin.firstBuyLamports, deps)).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });

  it('asks for a full preparation when the server forgot the launch or there is no capability', async () => {
    const { deps, api } = setup();
    const review = await prepareLaunch(coin, image, deps);
    deps.api = {
      ...api,
      rebuild: vi.fn().mockRejectedValue(new LaunchApiError('gone', 410, 'prepare_again')),
    };
    await expect(rebuildLaunch(review, coin.firstBuyLamports, deps)).rejects.toMatchObject({
      code: 'prepare_again',
    });
    await expect(
      rebuildLaunch({ ...review, rebuildToken: null }, coin.firstBuyLamports, deps),
    ).rejects.toMatchObject({ code: 'prepare_again' });
    await expect(
      rebuildLaunch(review, coin.firstBuyLamports, { ...deps, wallet: Keypair.generate().publicKey.toBase58() }),
    ).rejects.toMatchObject({ code: 'prepare_again' });
  });

  it('suggests the largest first buy the balance covers', async () => {
    const { deps } = setup({ balance: BigInt(300000000) });
    const review = await prepareLaunch(coin, image, deps);
    expect(review.insufficientBalance).toBe(true);
    const fit = affordableFirstBuyLamports(review, 30);
    // 0.3 SOL - (0.01 fee + 0.00001 network + 0.02 rent) - margin, less the 0.3% fee, to 0.001 SOL.
    expect(fit).toBe(BigInt(269000000));
    expect(affordableFirstBuyLamports({ ...review, balanceLamports: BigInt(1000) }, 30)).toBe(BigInt(0));
  });
});

describe('expiry and friendly errors', () => {
  it('reports an expired transaction (not a timeout) once the chain passed its expiry height', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    let height = 1000;
    const withHeight = { ...chain, getBlockHeight: vi.fn(async () => height) };
    chain.getSignatureStatus.mockImplementation(async () => {
      height += 100;
      return null;
    });
    const error = await executeLaunch(review, { ...deps, chain: withHeight }).catch((e) => e);
    expect(error).toMatchObject({ code: 'expired', signature: 'SIG', expiryHeight: 1160 });
    expect((error as Error).message).toMatch(/safely try again/);
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('checks again with the expiry height after a timeout', async () => {
    const { chain } = setup();
    chain.getSignatureStatus.mockResolvedValue(null);
    const withHeight = { ...chain, getBlockHeight: vi.fn(async () => 2000) };
    const error = await waitForLaunch('MINT', 'SIG', {
      chain: withHeight,
      confirm: { sleep: async () => {}, intervalMs: 1 },
    }, 1999).catch((e) => e);
    expect(error).toMatchObject({ code: 'expired' });
  });

  it('never shows the raw program error of an on-chain failure', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    chain.getSignatureStatus.mockResolvedValue({
      confirmationStatus: 'confirmed',
      err: { InstructionError: [1, { Custom: 6001 }] },
    });
    const error = (await executeLaunch(review, deps).catch((e) => e)) as TxError;
    expect(error.code).toBe('onchain_failed');
    expect(error.message).toMatch(/failed on-chain/);
    expect(error.message).not.toMatch(/[{}[\]]|InstructionError|6001/);
    expect(error.cause).toEqual({ InstructionError: [1, { Custom: 6001 }] });
  });

  it('explains an insufficient-funds rejection at send without the RPC text', async () => {
    const { deps, chain } = setup();
    const review = await prepareLaunch(coin, image, deps);
    chain.sendRawTransaction.mockRejectedValue(
      new RpcError(
        'Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1',
        -32002,
        { err: { InstructionError: [3, { Custom: 1 }] }, logs: ['Program log: insufficient lamports'] },
      ),
    );
    const error = (await executeLaunch(review, deps).catch((e) => e)) as TxError;
    expect(error.code).toBe('send_failed');
    expect(error.message).toMatch(/not have enough SOL/);
    expect(error.message).not.toMatch(/0x1|Instruction 3|simulation/i);
  });

  it('never shows the wallet adapter text of a signing failure', async () => {
    const { deps } = setup();
    const review = await prepareLaunch(coin, image, deps);
    deps.signTransaction = vi
      .fn()
      .mockRejectedValue(new Error('WalletSignTransactionError: internal 0xdeadbeef')) as never;
    const error = (await executeLaunch(review, deps).catch((e) => e)) as TxError;
    expect(error.code).toBe('sign_failed');
    expect(error.message).not.toMatch(/0xdeadbeef|WalletSign/);
  });

  it('never shows the wallet adapter text of a failed message signature', async () => {
    const { deps } = setup();
    const signMessage = vi.fn().mockRejectedValue(new Error('WalletSignMessageError: boom 42'));
    const error = (await prepareLaunch(coin, image, { ...deps, signMessage }).catch((e) => e)) as TxError;
    expect(error.code).toBe('prepare_failed');
    expect(error.message).not.toMatch(/boom|WalletSign/);
  });
});
