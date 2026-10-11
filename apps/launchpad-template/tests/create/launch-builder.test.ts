import { BN } from '@coral-xyz/anchor';
import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  LaunchBuildError,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
  createLaunchBuilder,
  type DbcClientLike,
} from '@/forge/create/launch-builder';
import { PrepareLaunchResponse } from '@/forge/create/api';
import { base64ToBytes } from '@/forge/create/base64';
import { FIXTURE_LAUNCHPAD_CONFIG, buildFixtureLaunch } from '@/forge/create/test-fixtures';
import { verifyPreparedLaunch } from '@/forge/create/verify';
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID } from '@/forge/tx/programs';

const wallet = Keypair.generate().publicKey;
const FEE = BigInt(10_000_000);
const POOL_SIZE = 424;
const rent = (size: number) => (128 + size) * 6960;

function poolConfig(overrides: Record<string, unknown> = {}): PoolConfig {
  return {
    quoteMint: NATIVE_MINT,
    tokenType: 0,
    poolCreationFee: new BN(FEE.toString()),
    poolFees: {
      baseFee: {
        cliffFeeNumerator: new BN(1),
        firstFactor: 0,
        secondFactor: new BN(0),
        thirdFactor: new BN(0),
        baseFeeMode: 0,
      },
      dynamicFee: null,
    },
    collectFeeMode: 0,
    sqrtStartPrice: new BN(1),
    migrationQuoteThreshold: new BN(1),
    curve: [],
    migrationSqrtPrice: new BN(1),
    ...overrides,
  } as unknown as PoolConfig;
}

function sdkInstructions(fixtureTx: string): TransactionInstruction[] {
  const tx = VersionedTransaction.deserialize(base64ToBytes(fixtureTx));
  return TransactionMessage.decompile(tx.message).instructions;
}

function setup(
  options: {
    firstBuy?: bigint;
    config?: PoolConfig | null;
    accounts?: unknown[];
    quote?: () => { outputAmount: BN; minimumAmountOut?: BN };
    mapInstructions?: (ixs: TransactionInstruction[]) => TransactionInstruction[];
  } = {},
) {
  const firstBuy = options.firstBuy ?? BigInt(500_000_000);
  const fixture = buildFixtureLaunch({
    wallet,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: firstBuy,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
  });
  const instructions = sdkInstructions(fixture.response.poolTx);
  const client = {
    state: {
      getPoolConfig: vi.fn(async () =>
        options.config === undefined ? poolConfig() : options.config,
      ),
    },
    pool: {
      getQuoteFromInputAmount: vi.fn(
        options.quote ??
          (() => ({ outputAmount: new BN(1_000_000), minimumAmountOut: new BN(900_000) })),
      ),
    },
    creator: {
      createPoolWithFirstBuy: vi.fn(async () => ({
        instructions: options.mapInstructions
          ? options.mapInstructions(instructions)
          : instructions,
      })),
      getProgram: () => ({ account: { virtualPool: { size: POOL_SIZE } } }),
    },
  } satisfies DbcClientLike;
  const connection = {
    getMultipleAccountsInfo: vi.fn(async () => options.accounts ?? [null, null]),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    })),
    getMinimumBalanceForRentExemption: vi.fn(async (size: number) => rent(size)),
  };
  const builder = createLaunchBuilder({
    connection: connection as unknown as Connection,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
    poolCreationFeeLamports: FEE,
    client,
  });
  const input = {
    mint: fixture.mint,
    wallet: wallet.toBase58(),
    name: 'Moon Coin',
    symbol: 'MOON',
    metadataUri: 'https://example.test/metadata.json',
    firstBuyLamports: firstBuy,
  };
  return { builder, client, connection, input, firstBuy, mint: fixture.mint };
}

const expectations = (firstBuy: bigint) => ({
  wallet: wallet.toBase58(),
  name: 'Moon Coin',
  symbol: 'MOON',
  firstBuyLamports: firstBuy,
  launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
  poolCreationFeeLamports: FEE,
  referralTokenAccount: null,
});

describe('createLaunchBuilder', () => {
  it('builds a launch the browser verifier accepts, signed by the mint only', async () => {
    const { builder, client, input, firstBuy, mint } = setup();
    const response = await builder.build(await builder.loadConfig(), input);

    expect(PrepareLaunchResponse.safeParse(response).success).toBe(true);
    const verified = verifyPreparedLaunch(response, expectations(firstBuy));
    expect(verified.mint).toBe(mint.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(base64ToBytes(response.poolTx));
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true);
    expect(tx.signatures[1]?.some((b) => b !== 0)).toBe(true);

    const call = client.creator.createPoolWithFirstBuy.mock.calls[0]?.[0] as any;
    expect(call.createPoolParam.payer.toBase58()).toBe(wallet.toBase58());
    expect(call.createPoolParam.poolCreator.toBase58()).toBe(wallet.toBase58());
    expect(call.createPoolParam.config.toBase58()).toBe(FIXTURE_LAUNCHPAD_CONFIG.toBase58());
    expect(call.firstBuyParam.buyer.toBase58()).toBe(wallet.toBase58());
    expect(call.firstBuyParam.receiver.toBase58()).toBe(wallet.toBase58());
    expect(call.firstBuyParam.referralTokenAccount).toBeNull();
    expect(call.firstBuyParam.minimumAmountOut.toString()).toBe('900000');
    expect(client.pool.getQuoteFromInputAmount.mock.calls[0]?.[0]).toMatchObject({
      swapBaseForQuote: false,
      eligibleForFirstSwapWithMinFee: true,
      hasReferral: false,
    });
  });

  it('reads the rent from the cluster and summarizes every cost as decimal strings', async () => {
    const { builder, connection, input } = setup();
    const { summary } = await builder.build(await builder.loadConfig(), input);
    const sizes = connection.getMinimumBalanceForRentExemption.mock.calls.map((c) => c[0]);
    expect(sizes.sort((a, b) => a - b)).toEqual([82, 165, POOL_SIZE, 607].sort((a, b) => a - b));
    // pool + mint + metadata + 2 vaults + the user's coin account.
    const expectedRent = rent(POOL_SIZE) + rent(82) + rent(607) + 3 * rent(165);
    expect(summary).toEqual({
      coinName: 'Moon Coin',
      coinSymbol: 'MOON',
      creatorWallet: wallet.toBase58(),
      poolCreationFeeLamports: '10000000',
      firstBuyLamports: '500000000',
      firstBuyExpectedTokensOut: '1000000',
      firstBuyMinimumTokensOut: '900000',
      estimatedNetworkFeeLamports: '10000',
      accountRentLamports: String(expectedRent),
      metadataFeeLamports: METAPLEX_CREATE_METADATA_FEE_LAMPORTS.toString(),
    });
  });

  it('without a first buy: no swap, no user coin account rent', async () => {
    const { builder, client, input } = setup({ firstBuy: BigInt(0) });
    const response = await builder.build(await builder.loadConfig(), input);
    verifyPreparedLaunch(response, expectations(BigInt(0)));
    expect((client.creator.createPoolWithFirstBuy.mock.calls[0]?.[0] as any).firstBuyParam).toBe(
      undefined,
    );
    expect(client.pool.getQuoteFromInputAmount).not.toHaveBeenCalled();
    expect(response.summary.firstBuyMinimumTokensOut).toBe('0');
    expect(response.summary.accountRentLamports).toBe(
      String(rent(POOL_SIZE) + rent(82) + rent(607) + 2 * rent(165)),
    );
  });

  it('always creates the wrapped SOL account idempotently, once', async () => {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
    const { builder, input, firstBuy } = setup({
      // The SDK omits the creation when the account exists at build time.
      mapInstructions: (ixs) =>
        ixs.filter(
          (ix) =>
            !(
              ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID &&
              ix.keys[1]?.pubkey.equals(wsol)
            ),
        ),
    });
    const response = await builder.build(await builder.loadConfig(), input);
    verifyPreparedLaunch(response, expectations(firstBuy));
    const tx = VersionedTransaction.deserialize(base64ToBytes(response.poolTx));
    const ixs = TransactionMessage.decompile(tx.message).instructions;
    expect(ixs[0]?.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(
      ixs.filter(
        (ix) =>
          ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID &&
          ix.keys[1]?.pubkey.equals(wsol),
      ),
    ).toHaveLength(1);
  });

  it('refuses a missing, non-SPL, non-SOL or differently priced launchpad config', async () => {
    await expect(setup({ config: null }).builder.loadConfig()).rejects.toMatchObject({
      code: 'config_not_found',
    });
    await expect(
      setup({ config: poolConfig({ tokenType: 1 }) }).builder.loadConfig(),
    ).rejects.toMatchObject({
      code: 'config_unsupported',
    });
    await expect(
      setup({
        config: poolConfig({ quoteMint: Keypair.generate().publicKey }),
      }).builder.loadConfig(),
    ).rejects.toMatchObject({ code: 'config_unsupported' });
    await expect(
      setup({ config: poolConfig({ poolCreationFee: new BN(1) }) }).builder.loadConfig(),
    ).rejects.toMatchObject({ code: 'creation_fee_mismatch' });
  });

  it('refuses a mint or pool that already exists', async () => {
    const { builder, input } = setup({ accounts: [{ lamports: 1 }, null] });
    await expect(builder.build(await builder.loadConfig(), input)).rejects.toMatchObject({
      code: 'mint_exists',
    });
  });

  it('maps a first buy larger than the curve to a clear error', async () => {
    const { builder, input } = setup({
      quote: () => {
        throw new Error('Insufficient liquidity');
      },
    });
    const error = await builder.build(await builder.loadConfig(), input).catch((e) => e);
    expect(error).toBeInstanceOf(LaunchBuildError);
    expect(error.code).toBe('first_buy_too_large');
  });

  it('refuses any extra signer and an oversized transaction', async () => {
    const extra = Keypair.generate().publicKey;
    const signer = setup({
      mapInstructions: (ixs) => [
        ...ixs,
        new TransactionInstruction({
          programId: new PublicKey(COMPUTE_BUDGET_PROGRAM_ID),
          keys: [{ pubkey: extra, isSigner: true, isWritable: false }],
          data: Buffer.from([]),
        }),
      ],
    });
    await expect(
      signer.builder.build(await signer.builder.loadConfig(), signer.input),
    ).rejects.toMatchObject({ code: 'unexpected_signers' });

    const big = setup({
      mapInstructions: (ixs) => [
        ...ixs,
        new TransactionInstruction({
          programId: new PublicKey(COMPUTE_BUDGET_PROGRAM_ID),
          keys: [],
          data: Buffer.alloc(600),
        }),
      ],
    });
    await expect(
      big.builder.build(await big.builder.loadConfig(), big.input),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
  });
});
