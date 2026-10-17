import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  getDbcPoolState: vi.fn(),
  isGraduated: vi.fn(),
  fetchSwapPoolState: vi.fn(),
  computeSwapQuote: vi.fn(),
  buildBuyTx: vi.fn(),
  buildSellTx: vi.fn(),
}));

vi.mock('@forge/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forge/core')>()),
  ...core,
}));

const configs = vi.hoisted(() => ({ users: '', coin: '' }));

vi.mock('../../src/forge/config', async () => {
  const { Keypair } = await import('@solana/web3.js');
  configs.users = Keypair.generate().publicKey.toBase58();
  configs.coin = Keypair.generate().publicKey.toBase58();
  return {
    onchainConfig: { cluster: 'devnet', launchpadConfig: configs.users, launchpadCoinConfig: configs.coin },
  };
});

import { ForgeAddressError, SwapError } from '@forge/core';
import { TradeError } from '../../src/forge/trade/errors';
import {
  createCoreSwapCore,
  priceImpactBps,
  quoteSwap,
  setSwapCore,
  translateCoreError,
} from '../../src/forge/trade/core-adapter';
import { createMockSwapCore } from '../../src/forge/trade/core-adapter.mock';
import { SITE_PRIORITY_FEE, SWAP_MAX_PRIORITY_FEE_LAMPORTS } from '../../src/forge/priority-fee';

const connection = {} as Connection;
const pool = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const feeWallet = Keypair.generate().publicKey.toBase58();
const referral = Keypair.generate().publicKey.toBase58();

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET', feeWallet);
  vi.stubEnv('NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT', referral);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const fn of Object.values(core)) fn.mockReset();
});

const coreQuote = (amountIn: bigint, expectedAmountOut: bigint) => ({
  side: 'buy' as const,
  amountIn,
  expectedAmountOut,
  minAmountOut: (expectedAmountOut * BigInt(99)) / BigInt(100),
  fees: {
    totalPoolFee: BigInt(1_000),
    platformFee: BigInt(3_000),
    platformFeeBps: 30,
  },
});

describe('swap core backed by @forge/core', () => {
  it('reads graduation through the core pool state, for a pool of this launchpad only', async () => {
    const state = { virtualPool: { poolState: { config: new PublicKey(configs.coin) } }, config: {} };
    core.getDbcPoolState.mockResolvedValue(state);
    core.isGraduated.mockReturnValue(true);
    await expect(createCoreSwapCore().isGraduated({ connection, pool })).resolves.toBe(true);
    expect(core.getDbcPoolState).toHaveBeenCalledWith(connection, pool);
    expect(core.isGraduated).toHaveBeenCalledWith(state);

    const foreign = { virtualPool: { poolState: { config: Keypair.generate().publicKey } } };
    core.getDbcPoolState.mockResolvedValue(foreign);
    await expect(createCoreSwapCore().isGraduated({ connection, pool })).rejects.toMatchObject({
      code: 'not_on_launchpad',
    });
  });

  it('quotes only pools of this launchpad (allowedConfigs = its two configs)', async () => {
    core.fetchSwapPoolState.mockRejectedValue(new SwapError('POOL_NOT_ALLOWED', 'foreign'));
    await expect(
      createCoreSwapCore().quoteSwap({ connection, pool, side: 'buy', amountIn: BigInt(1), slippageBps: 100 }),
    ).rejects.toMatchObject({ code: 'not_on_launchpad' });
    expect(core.fetchSwapPoolState).toHaveBeenCalledWith(connection, pool, 'confirmed', {
      allowedConfigs: [configs.users, configs.coin],
    });
  });

  it('maps a core quote to the panel quote without recomputing anything', async () => {
    core.fetchSwapPoolState.mockResolvedValue({ marker: 'state' });
    core.computeSwapQuote.mockImplementation((_state, request) =>
      // Constant 2 tokens per lamport: no price impact.
      coreQuote(request.amountIn, request.amountIn * BigInt(2)),
    );
    const quote = await createCoreSwapCore().quoteSwap({
      connection,
      pool,
      side: 'buy',
      amountIn: BigInt(1_000_000),
      slippageBps: 100,
    });
    expect(core.computeSwapQuote.mock.calls[0]?.[1]).toEqual({
      side: 'buy',
      amountIn: BigInt(1_000_000),
      slippage: { slippageBps: 100 },
    });
    expect(quote).toMatchObject({
      side: 'buy',
      amountIn: BigInt(1_000_000),
      amountOut: BigInt(2_000_000),
      minAmountOut: BigInt(1_980_000),
      priceImpactBps: 0,
      tradingFee: BigInt(1_000),
      platformFee: BigInt(3_000),
      platformFeeBps: 30,
    });
    expect(typeof quote.quotedAt).toBe('number');
  });

  it('derives a display price impact from two core quotes', () => {
    const request = {
      side: 'buy' as const,
      amountIn: BigInt(1_000_000),
      slippage: { slippageBps: 0 },
    };
    // The reference trade (1%) gets 2 tokens per lamport, the full trade gets 1.8.
    core.computeSwapQuote.mockReturnValue(coreQuote(BigInt(10_000), BigInt(20_000)));
    const impact = priceImpactBps({} as never, request, { expectedAmountOut: BigInt(1_800_000) });
    expect(impact).toBe(1_000);
  });

  it('reports no impact when the reference quote is not possible', () => {
    const request = {
      side: 'buy' as const,
      amountIn: BigInt(1_000_000),
      slippage: { slippageBps: 0 },
    };
    core.computeSwapQuote.mockImplementation(() => {
      throw new SwapError('AMOUNT_TOO_SMALL', 'too small');
    });
    expect(priceImpactBps({} as never, request, { expectedAmountOut: BigInt(5) })).toBe(0);
    expect(
      priceImpactBps(
        {} as never,
        { ...request, amountIn: BigInt(99) },
        { expectedAmountOut: BigInt(5) },
      ),
    ).toBe(0);
  });

  it('builds a buy with the lamports, the floor the user saw and the public FORGE addresses', async () => {
    const transaction = {} as VersionedTransaction;
    core.buildBuyTx.mockResolvedValue({ transaction });
    const tx = await createCoreSwapCore().buildBuyTx({
      connection,
      pool,
      user,
      amountIn: BigInt(5_000_000),
      minAmountOut: BigInt(4_000),
    });
    expect(tx).toBe(transaction);
    expect(core.buildBuyTx).toHaveBeenCalledWith({
      connection,
      pool,
      user,
      amountInLamports: BigInt(5_000_000),
      minAmountOut: BigInt(4_000),
      env: { FORGE_PLATFORM_FEE_WALLET: feeWallet, FORGE_METEORA_REFERRAL_ACCOUNT: referral },
      allowedConfigs: [configs.users, configs.coin],
      // The site's fixed priority fee setting (the core defaults, at most 0.0005 SOL).
      priority: SITE_PRIORITY_FEE,
    });
  });

  it('hands the revenue wallet to core when the site has it (referral holder check)', async () => {
    const revenue = Keypair.generate().publicKey.toBase58();
    vi.stubEnv('NEXT_PUBLIC_FORGE_REVENUE_WALLET', revenue);
    core.buildBuyTx.mockResolvedValue({ transaction: {} });
    await createCoreSwapCore().buildBuyTx({
      connection,
      pool,
      user,
      amountIn: BigInt(1),
      minAmountOut: BigInt(1),
    });
    expect(core.buildBuyTx.mock.calls[0]?.[0].env).toEqual({
      FORGE_PLATFORM_FEE_WALLET: feeWallet,
      FORGE_METEORA_REFERRAL_ACCOUNT: referral,
      FORGE_REVENUE_WALLET: revenue,
    });
  });

  it('takes no fee account from its caller: createCoreSwapCore has no option', async () => {
    core.buildBuyTx.mockResolvedValue({ transaction: {} });
    const attacker = Keypair.generate().publicKey.toBase58();
    const make = createCoreSwapCore as unknown as (o: unknown) => ReturnType<typeof createCoreSwapCore>;
    await make({ env: () => ({ FORGE_PLATFORM_FEE_WALLET: attacker }) }).buildBuyTx({
      connection,
      pool,
      user,
      amountIn: BigInt(1),
      minAmountOut: BigInt(1),
    });
    expect(core.buildBuyTx.mock.calls[0]?.[0].env.FORGE_PLATFORM_FEE_WALLET).toBe(feeWallet);
  });

  it('cannot be replaced outside the test environment (setSwapCore is a no-op)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mock = createMockSwapCore();
    const restore = setSwapCore(mock);
    core.fetchSwapPoolState.mockRejectedValue(new SwapError('POOL_NOT_ALLOWED', 'foreign'));
    await expect(
      quoteSwap({ connection, pool, side: 'buy', amountIn: BigInt(1), slippageBps: 100 }),
    ).rejects.toMatchObject({ code: 'not_on_launchpad' });
    expect(mock.calls.quote).toBe(0);
    restore();
    vi.stubEnv('NODE_ENV', 'test');
    const restoreTest = setSwapCore(mock);
    await quoteSwap({ connection, pool, side: 'buy', amountIn: BigInt(1), slippageBps: 100 });
    expect(mock.calls.quote).toBe(1);
    restoreTest();
  });

  it('builds a sell with the token amount', async () => {
    const transaction = {} as VersionedTransaction;
    core.buildSellTx.mockResolvedValue({ transaction });
    await createCoreSwapCore().buildSellTx({
      connection,
      pool,
      user,
      amountIn: BigInt(7_000),
      minAmountOut: BigInt(900),
    });
    expect(core.buildSellTx).toHaveBeenCalledWith(
      expect.objectContaining({
        amountInTokens: BigInt(7_000),
        minAmountOut: BigInt(900),
        priority: SITE_PRIORITY_FEE,
      }),
    );
  });

  it('prices trades with the core defaults, at most 0.00015 SOL per swap', () => {
    expect(SITE_PRIORITY_FEE).toEqual({});
    expect(Object.isFrozen(SITE_PRIORITY_FEE)).toBe(true);
    expect(SWAP_MAX_PRIORITY_FEE_LAMPORTS).toBe(BigInt(150_000));
  });

  it('turns core refusals into trade errors', async () => {
    core.buildBuyTx.mockRejectedValue(
      new SwapError('POOL_GRADUATED', 'The pool curve is complete'),
    );
    const run = createCoreSwapCore().buildBuyTx({
      connection,
      pool,
      user,
      amountIn: BigInt(1),
      minAmountOut: BigInt(1),
    });
    await expect(run).rejects.toBeInstanceOf(TradeError);
    await expect(run).rejects.toMatchObject({ code: 'pool_graduated' });
  });

  it('maps core error codes', () => {
    const code = (swapCode: ConstructorParameters<typeof SwapError>[0]) =>
      (translateCoreError(new SwapError(swapCode, 'x')) as TradeError).code;
    expect(code('INSUFFICIENT_SOL_BALANCE')).toBe('insufficient_funds');
    expect(code('INSUFFICIENT_TOKEN_BALANCE')).toBe('insufficient_funds');
    expect(code('MIN_AMOUNT_OUT_ABOVE_QUOTE')).toBe('price_moved');
    expect(code('PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT')).toBe('not_configured');
    expect(code('PLATFORM_FEE_WALLET_MISMATCH')).toBe('not_configured');
    expect(code('POOL_NOT_ALLOWED')).toBe('not_on_launchpad');
    expect(code('RPC_ERROR')).toBe('network');
    const missing = translateCoreError(new ForgeAddressError(['FORGE_PLATFORM_FEE_WALLET'], []));
    expect((missing as TradeError).code).toBe('not_configured');
    const other = new Error('boom');
    expect(translateCoreError(other)).toBe(other);
  });

  it('does not reimplement swap logic or touch the SDK', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/forge/trade/core-adapter.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['dynamic-bonding-curve-sdk', 'bn.js', 'TransactionInstruction']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
