import { BN } from '@coral-xyz/anchor';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { MINT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LaunchBuildError,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
  createLaunchBuilder,
  type LaunchBuilderOptions,
} from '@/forge/create/launch-builder';
import { PrepareLaunchResponse } from '@/forge/create/api';
import { base64ToBytes } from '@/forge/create/base64';
import { verifyPreparedLaunch } from '@/forge/create/verify';
import { COMPUTE_BUDGET_PROGRAM_ID, dbcPoolAddress } from '@/forge/tx/programs';

/*
 * The launch is built by @forge/core (`buildUserCoinLaunchTx`) on a mocked relay connection. The
 * config account is a real launchpad config created on devnet by core (public data, also the
 * fixture of packages/core/src/pool.test.ts): 25% creator share, 75 / 25 locked liquidity,
 * anti-sniper 9900 -> 100 bps, 0.001 SOL creation fee, fee claimer = OWNER.
 */
const CONFIG_FIXTURE_BASE64 =
  'GmwOe3TmgSsGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAASyEFwNSPwYU4BGg5qECMVofZ9/hgka2uj3lAj' +
  'ZlDrPoLIQXA1I/BhTgEaDmoQIxWh9n3+GCRra6PeUCNmUOs+iAMwI7AAAAAAYAAAAAAAAAgFzXBQAAAAAKAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQYBAABLABkAAAEZAQAAAAAAAAAAAAqW24GY1wIAAOQLVAIA' +
  'AACY+1gh5rUAAM5N8P/UaM8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAgMakfo0DAACAxqR+jQMAAAAAAAABAABAQg8AAAAAAAAAAAAAAAAAAAAAAAAAAAA5cPuPNdpzAAAAAAAA' +
  'AAAAzk3w/9RozwEAAAAAAAAAAM9n+RX9pKdkafqYB7cBAACbV2lOqRpchLHE/v8AAAAA/XPZVLZwQ7OS1wIAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const OWNER = new PublicKey('3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75');
const CONFIG = Keypair.generate().publicKey;
const FEE = BigInt(1_000_000);
const FIRST_BUY = BigInt(500_000_000);
/** 0.3% of the 0.5 SOL first buy. */
const PLATFORM_FEE = BigInt(1_500_000);
const wallet = Keypair.generate().publicKey;
const platformWallet = Keypair.generate().publicKey;
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();

/** Mainnet rent formula: (128 + size) * 3480 lamports/byte-year * 2 years. */
const rent = (size: number) => (128 + size) * 6960;
const account = (owner: PublicKey, data: Buffer, lamports?: number): AccountInfo<Buffer> => ({
  owner,
  data,
  lamports: lamports ?? rent(data.length),
  executable: false,
  rentEpoch: 0,
});

const program = DynamicBondingCurveClient.create(
  new Connection('http://127.0.0.1:8899'),
  'confirmed',
).pool.getProgram();
const POOL_SIZE = program.account.virtualPool.size;
let fixtureConfig: PoolConfig;

beforeAll(() => {
  fixtureConfig = program.coder.accounts.decode<PoolConfig>(
    'poolConfig',
    Buffer.from(CONFIG_FIXTURE_BASE64, 'base64'),
  );
});

/** Re-encodes the fixture config with some fields changed (account layout, as in core's tests). */
function encodeConfig(changes: Partial<PoolConfig> = {}): Buffer {
  const layouts = (
    program.coder.accounts as unknown as {
      accountLayouts: Map<string, { layout: { encode(value: unknown, buffer: Buffer): number } }>;
    }
  ).accountLayouts;
  const buffer = Buffer.alloc(2048);
  const length = layouts.get('poolConfig')!.layout.encode({ ...fixtureConfig, ...changes }, buffer);
  const discriminator = Buffer.from(CONFIG_FIXTURE_BASE64, 'base64').subarray(0, 8);
  return Buffer.concat([discriminator, buffer.subarray(0, length)]);
}

/** In-memory relay connection: only what the SDK read and core's builder call. */
function mockConnection(accounts: Map<string, AccountInfo<Buffer>>) {
  const get = (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  return {
    getAccountInfo: async (key: PublicKey) => get(key),
    getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 1 }, value: get(key) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(get),
    getMinimumBalanceForRentExemption: async (size: number) => rent(size),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 10_000 }),
  };
}

function setup(
  options: {
    config?: Partial<PoolConfig> | null;
    builder?: Partial<LaunchBuilderOptions>;
    firstBuy?: bigint;
  } = {},
) {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  if (options.config !== null) {
    accounts.set(
      CONFIG.toBase58(),
      account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, encodeConfig(options.config ?? {})),
    );
  }
  accounts.set(NATIVE_MINT.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
  accounts.set(platformWallet.toBase58(), account(SystemProgram.programId, Buffer.alloc(0)));
  const connection = mockConnection(accounts);
  const builder = createLaunchBuilder({
    connection: connection as unknown as Connection,
    launchpadConfig: CONFIG.toBase58(),
    poolCreationFeeLamports: FEE,
    ownerWallet: OWNER.toBase58(),
    platformFeeWallet: platformWallet.toBase58(),
    ...options.builder,
  });
  const mint = Keypair.generate();
  const firstBuy = options.firstBuy ?? FIRST_BUY;
  const input = {
    mint,
    wallet: wallet.toBase58(),
    name: 'Moon Coin',
    symbol: 'MOON',
    metadataUri: 'https://example.test/metadata.json',
    firstBuyLamports: firstBuy,
  };
  return { builder, accounts, input, mint, firstBuy };
}

const expectations = (firstBuy: bigint) => ({
  wallet: wallet.toBase58(),
  name: 'Moon Coin',
  symbol: 'MOON',
  firstBuyLamports: firstBuy,
  launchpadConfig: CONFIG.toBase58(),
  poolCreationFeeLamports: FEE,
  referralTokenAccount: null,
  platformFeeWallet: platformWallet.toBase58(),
});

const instructionsOf = (response: { poolTx: string }) =>
  TransactionMessage.decompile(
    VersionedTransaction.deserialize(base64ToBytes(response.poolTx)).message,
  ).instructions;

describe('createLaunchBuilder (launch built by @forge/core)', () => {
  it('builds a launch the browser verifier accepts, signed by the mint only', async () => {
    const { builder, input, firstBuy, mint } = setup();
    const response = await builder.build(await builder.loadConfig(), input);

    expect(PrepareLaunchResponse.safeParse(response).success).toBe(true);
    const verified = verifyPreparedLaunch(response, expectations(firstBuy));
    expect(verified.mint).toBe(mint.publicKey.toBase58());
    expect(verified.summary.platformFeeLamports).toBe(PLATFORM_FEE);
    const tx = VersionedTransaction.deserialize(base64ToBytes(response.poolTx));
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true);
    expect(tx.signatures[1]?.some((b) => b !== 0)).toBe(true);
    const ixs = instructionsOf(response);
    expect(ixs[0]?.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  });

  it('ends with the 0.3% platform fee transfer to FORGE_PLATFORM_FEE_WALLET', async () => {
    const { builder, input } = setup();
    const response = await builder.build(await builder.loadConfig(), input);
    const ixs = instructionsOf(response);
    const last = ixs[ixs.length - 1]!;
    expect(last.programId.equals(SystemProgram.programId)).toBe(true);
    const fee = SystemInstruction.decodeTransfer(last);
    expect(fee.fromPubkey.equals(wallet)).toBe(true);
    expect(fee.toPubkey.equals(platformWallet)).toBe(true);
    expect(fee.lamports).toBe(PLATFORM_FEE);
    expect(response.summary.platformFeeLamports).toBe(PLATFORM_FEE.toString());
  });

  it('reads the rent from the cluster and summarizes every cost as decimal strings', async () => {
    const { builder, input } = setup();
    const { summary } = await builder.build(await builder.loadConfig(), input);
    // pool + mint + metadata + 2 vaults + the user's coin account.
    const expectedRent = rent(POOL_SIZE) + rent(MINT_SIZE) + rent(607) + 3 * rent(165);
    expect(summary).toMatchObject({
      coinName: 'Moon Coin',
      coinSymbol: 'MOON',
      creatorWallet: wallet.toBase58(),
      poolCreationFeeLamports: FEE.toString(),
      firstBuyLamports: FIRST_BUY.toString(),
      platformFeeLamports: PLATFORM_FEE.toString(),
      estimatedNetworkFeeLamports: '10000',
      accountRentLamports: String(expectedRent),
      metadataFeeLamports: METAPLEX_CREATE_METADATA_FEE_LAMPORTS.toString(),
    });
    const expectedOut = BigInt(summary.firstBuyExpectedTokensOut);
    expect(expectedOut).toBeGreaterThan(BigInt(0));
    expect(BigInt(summary.firstBuyMinimumTokensOut)).toBe(
      (expectedOut * BigInt(9_900)) / BigInt(10_000),
    );
  });

  it('without a first buy: no swap, no platform fee, no fee wallet needed', async () => {
    const { builder, input } = setup({
      firstBuy: BigInt(0),
      builder: { platformFeeWallet: null },
    });
    const response = await builder.build(await builder.loadConfig(), input);
    verifyPreparedLaunch(response, { ...expectations(BigInt(0)), platformFeeWallet: null });
    expect(response.summary.firstBuyMinimumTokensOut).toBe('0');
    expect(response.summary.platformFeeLamports).toBe('0');
    expect(
      instructionsOf(response).some((ix) => ix.programId.equals(SystemProgram.programId)),
    ).toBe(false);
    expect(response.summary.accountRentLamports).toBe(
      String(rent(POOL_SIZE) + rent(MINT_SIZE) + rent(607) + 2 * rent(165)),
    );
  });

  it('refuses a missing config, another creation fee, another owner or a tampered config', async () => {
    await expect(setup({ config: null }).builder.loadConfig()).rejects.toMatchObject({
      code: 'config_not_found',
    });
    await expect(
      setup({ builder: { poolCreationFeeLamports: BigInt(1) } }).builder.loadConfig(),
    ).rejects.toMatchObject({ code: 'creation_fee_mismatch' });
    await expect(
      setup({
        builder: { ownerWallet: Keypair.generate().publicKey.toBase58() },
      }).builder.loadConfig(),
    ).rejects.toMatchObject({ code: 'config_unsupported' });
    for (const change of [
      { migrationFeePercentage: 10 },
      { tokenUpdateAuthority: 0 },
      { creatorTradingFeePercentage: 10 },
      { quoteMint: Keypair.generate().publicKey },
    ] as Partial<PoolConfig>[]) {
      await expect(setup({ config: change }).builder.loadConfig()).rejects.toMatchObject({
        code: 'config_unsupported',
      });
    }
  });

  it('re-checks the config in the build (core), not only in loadConfig', async () => {
    const { builder, accounts, input } = setup();
    const loaded = await builder.loadConfig();
    accounts.set(
      CONFIG.toBase58(),
      account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, encodeConfig({ migrationFeePercentage: 10 })),
    );
    await expect(builder.build(loaded, input)).rejects.toMatchObject({
      code: 'config_unsupported',
    });
  });

  it('refuses a mint or pool that already exists', async () => {
    const { builder, accounts, input, mint } = setup();
    accounts.set(mint.publicKey.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
    await expect(builder.build(await builder.loadConfig(), input)).rejects.toMatchObject({
      code: 'mint_exists',
    });
    const other = setup();
    accounts.delete(mint.publicKey.toBase58());
    other.accounts.set(
      dbcPoolAddress(CONFIG.toBase58(), other.mint.publicKey.toBase58()),
      account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, Buffer.alloc(8)),
    );
    await expect(
      other.builder.build(await other.builder.loadConfig(), other.input),
    ).rejects.toMatchObject({ code: 'mint_exists' });
  });

  it('maps a first buy larger than the curve to a clear error', async () => {
    // A curve that ends one step above its start price sells (almost) nothing (the migration
    // price is derived by the program, so the config check does not look at it).
    const { builder, input } = setup({
      config: { migrationSqrtPrice: fixtureConfig.sqrtStartPrice.add(new BN(1)) },
    });
    const error = await builder.build(await builder.loadConfig(), input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchBuildError);
    expect((error as LaunchBuildError).code).toBe('first_buy_too_large');
  });

  it('refuses a first buy when the platform fee wallet is missing or not rent-exempt', async () => {
    const missing = setup({ builder: { platformFeeWallet: null } });
    await expect(
      missing.builder.build(await missing.builder.loadConfig(), missing.input),
    ).rejects.toMatchObject({ code: 'platform_fee_unavailable' });
    const empty = setup();
    empty.accounts.delete(platformWallet.toBase58());
    await expect(
      empty.builder.build(await empty.builder.loadConfig(), empty.input),
    ).rejects.toMatchObject({ code: 'platform_fee_unavailable' });
  });

  it('fits the largest metadata with the platform fee (32-byte name, 10-character symbol, 200-byte URI)', async () => {
    const { builder, input } = setup();
    const uri = `https://example.com/${'a'.repeat(200 - 25)}.json`;
    expect(Buffer.byteLength(uri)).toBe(200);
    const response = await builder.build(await builder.loadConfig(), {
      ...input,
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri,
    });
    expect(base64ToBytes(response.poolTx).length).toBeLessThanOrEqual(1232);
  });
});
