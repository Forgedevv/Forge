import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction as TransactionInstructionClass,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { OwnerTransactionSummary, type LaunchpadSpec } from '@forge/shared';
import { ForgeAddressError } from './addresses.js';
import { MIGRATION_THRESHOLD_LAMPORTS, SOL_QUOTE_MINT, solToLamports } from './constants.js';
import { MAX_TRANSACTION_COMPUTE_UNITS } from './priority-fee.js';
import { platformFeeLamports } from './swap.js';
import {
  LaunchTransactionCheckError,
  verifyLaunchCoinTransaction,
  type ExpectedLaunchCoinTransaction,
} from './launch-check.js';
import {
  DEFAULT_FIRST_BUY_SLIPPAGE_BPS,
  LAUNCH_COIN_COMPUTE_UNITS,
  LAUNCH_METADATA_BUDGET_BYTES,
  LaunchCoinError,
  MAX_FIRST_BUY_LAMPORTS,
  METADATA_ACCOUNT_SIZE,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
  assertFirstBuyLamports,
  assertLaunchCoinConfig,
  assertLaunchMetadata,
  assertSpecLaunchable,
  assertUserCoinConfig,
  buildLaunchCoinTx,
  buildUserCoinLaunchTx,
  launchMetadataBytes,
  toOwnerTransactionSummary,
  type BuildLaunchCoinTxParams,
  type BuildUserCoinLaunchTxParams,
  type LaunchCoinErrorCode,
} from './pool.js';
import {
  DurableNonceError,
  MAX_TRANSACTION_BYTES,
  deserializeTransactionBase64,
  missingSigners,
  serializeTransactionBase64,
} from './tx.js';

/*
 * The config fixture is the real launchpad coin config created on devnet by `buildCreateConfigTx`
 * (scripts/devnet-tests/reports/core-config-pool.md, config
 * GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J): SOL quote, anti-sniper 9900 -> 100 bps linear in
 * 10 x 6 s, enableFirstSwapWithMinFee, creator share 25%, creator / partner locked liquidity
 * 25 / 75, pool creation fee 0.001 SOL, fee claimer = leftover receiver = the devnet `client`.
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
const CONFIG = new PublicKey('GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J');
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const NONCE_VALUE = new PublicKey(Buffer.alloc(32, 9)).toBase58();

/** Mainnet rent formula: (128 + size) * 3480 lamports/byte-year * 2 years. */
const rent = (size: number) => (128 + size) * 6960;

function account(owner: PublicKey, data: Buffer, lamports?: number): AccountInfo<Buffer> {
  return { owner, data, lamports: lamports ?? rent(data.length), executable: false, rentEpoch: 0 };
}

function nonceAccountData(authority: PublicKey, nonce: string, state = 1): Buffer {
  const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(state, 4);
  authority.toBuffer().copy(data, 8);
  new PublicKey(nonce).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(5000n, 72);
  return data;
}

function wsolTokenAccountData(owner: PublicKey, amount = 0n): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: NATIVE_MINT,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: 2039280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

interface MockOptions {
  accounts?: Map<string, AccountInfo<Buffer>>;
  feeForMessage?: number | null | Error;
}

/** In-memory Connection: only the methods the builders call. */
function mockConnection(options: MockOptions = {}) {
  const accounts = options.accounts ?? new Map<string, AccountInfo<Buffer>>();
  const calls: string[] = [];
  const get = (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  const connection = {
    calls,
    accounts,
    getAccountInfo: async (key: PublicKey) => {
      calls.push('getAccountInfo');
      return get(key);
    },
    getAccountInfoAndContext: async (key: PublicKey) => {
      calls.push('getAccountInfoAndContext');
      return { context: { slot: 1 }, value: get(key) };
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push('getMultipleAccountsInfo');
      return keys.map(get);
    },
    getMinimumBalanceForRentExemption: async (size: number) => {
      calls.push('getMinimumBalanceForRentExemption');
      return rent(size);
    },
    getLatestBlockhash: async () => {
      calls.push('getLatestBlockhash');
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
    },
    getFeeForMessage: async () => {
      calls.push('getFeeForMessage');
      if (options.feeForMessage instanceof Error) throw options.feeForMessage;
      return { context: { slot: 1 }, value: options.feeForMessage ?? null };
    },
    /** Answer of getRecentPrioritizationFees (micro-lamports per slot; an Error is thrown). */
    priorityFees: [] as number[] | Error,
    priorityFeeAccounts: [] as string[],
    getRecentPrioritizationFees: async (config?: { lockedWritableAccounts?: PublicKey[] }) => {
      calls.push('getRecentPrioritizationFees');
      connection.priorityFeeAccounts = (config?.lockedWritableAccounts ?? []).map(String);
      if (connection.priorityFees instanceof Error) throw connection.priorityFees;
      return connection.priorityFees.map((prioritizationFee, slot) => ({
        slot,
        prioritizationFee,
      }));
    },
  };
  return connection;
}

const decoder = DynamicBondingCurveClient.create(
  new Connection('http://127.0.0.1:8899'),
  'confirmed',
).pool.getProgram().coder.accounts;

let fixtureConfig: PoolConfig;

beforeAll(() => {
  fixtureConfig = decoder.decode<PoolConfig>(
    'poolConfig',
    Buffer.from(CONFIG_FIXTURE_BASE64, 'base64'),
  );
});

/**
 * Re-encodes the fixture with some fields changed. The fixture was created when the coin config
 * still charged the spec's creation fee (0.001 SOL); the current builder sets none
 * (LAUNCHPAD_COIN_POOL_CREATION_FEE_SOL) and the config check requires it, so the encoded default is
 * a fee of 0. User coin tests that need a creation fee set it explicitly. Anchor's `encode` uses a 1000-byte buffer and
 * a pool config is 1048 bytes, so the account layout is used directly.
 */
async function encodeConfig(changes: Partial<PoolConfig> = {}): Promise<Buffer> {
  const layouts = (
    decoder as unknown as {
      accountLayouts: Map<string, { layout: { encode(value: unknown, buffer: Buffer): number } }>;
    }
  ).accountLayouts;
  const buffer = Buffer.alloc(2048);
  const length = layouts
    .get('poolConfig')!
    .layout.encode({ ...fixtureConfig, poolCreationFee: new BN(0), ...changes }, buffer);
  const discriminator = Buffer.from(CONFIG_FIXTURE_BASE64, 'base64').subarray(0, 8);
  return Buffer.concat([discriminator, buffer.subarray(0, length)]);
}

interface Setup {
  creator: PublicKey;
  mint: Keypair;
  nonceAuthority: PublicKey;
  nonceAccount: PublicKey;
  connection: ReturnType<typeof mockConnection>;
  params: BuildLaunchCoinTxParams;
}

async function setup(
  overrides: Partial<BuildLaunchCoinTxParams> = {},
  options: { config?: Partial<PoolConfig>; feeForMessage?: number | null | Error } = {},
): Promise<Setup> {
  const creator = Keypair.generate().publicKey;
  const mint = Keypair.generate();
  const nonceAccount = Keypair.generate().publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(
    CONFIG.toBase58(),
    account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, await encodeConfig(options.config)),
  );
  accounts.set(NATIVE_MINT.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
  accounts.set(
    nonceAccount.toBase58(),
    account(SystemProgram.programId, nonceAccountData(creator, NONCE_VALUE)),
  );
  const connection = mockConnection({ accounts, feeForMessage: options.feeForMessage ?? 25_000 });
  const params: BuildLaunchCoinTxParams = {
    connection: connection as unknown as Connection,
    config: CONFIG,
    creator,
    owner: OWNER,
    mint,
    name: 'Moon',
    symbol: 'MOON',
    metadataUri: 'https://example.com/moon.json',
    firstBuyLamports: solToLamports(0.01),
    durableNonce: { nonceAccount, authority: creator },
    // No FORGE referral unless a test sets it (never read from the developer's environment).
    env: {},
    ...overrides,
  };
  return { creator, mint: mint, nonceAuthority: creator, nonceAccount, connection, params };
}

/** A launchpad spec with this coin name and symbol (first buy 0.01 SOL). */
function coinSpec(name: string, symbol: string): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: OWNER.toBase58(),
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.001,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: '',
      designNotes: '',
    },
    launchpadCoin: {
      name,
      symbol,
      description: '',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 0.01,
    },
  };
}

async function expectLaunchError(
  promise: Promise<unknown>,
  code: LaunchCoinErrorCode,
): Promise<LaunchCoinError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LaunchCoinError);
  expect((error as LaunchCoinError).code).toBe(code);
  return error as LaunchCoinError;
}

describe('buildLaunchCoinTx — durable nonce', () => {
  it('puts nonceAdvance first and uses the nonce value as recentBlockhash', async () => {
    const { params, creator, nonceAccount } = await setup();
    const { transaction, summary } = await buildLaunchCoinTx(params);

    expect(transaction.recentBlockhash).toBe(NONCE_VALUE);
    const first = transaction.instructions[0]!;
    expect(first.programId.equals(SystemProgram.programId)).toBe(true);
    expect(SystemInstruction.decodeInstructionType(first)).toBe('AdvanceNonceAccount');
    const decoded = SystemInstruction.decodeNonceAdvance(first);
    expect(decoded.noncePubkey.equals(nonceAccount)).toBe(true);
    expect(decoded.authorizedPubkey.equals(creator)).toBe(true);

    expect(summary.durableNonce).toEqual({
      nonceAccount,
      authority: creator,
      nonce: NONCE_VALUE,
    });
    expect(summary.lastValidBlockHeight).toBeNull();
    expect(summary.recentBlockhash).toBe(NONCE_VALUE);
  });

  it('adds the compute budget instructions after the nonce advance', async () => {
    const { params } = await setup({ computeUnitPriceMicroLamports: 1000 });
    const { transaction, summary } = await buildLaunchCoinTx(params);
    const [, limit, price] = transaction.instructions;
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(price!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit!.data[0]).toBe(2); // SetComputeUnitLimit
    expect(limit!.data.readUInt32LE(1)).toBe(LAUNCH_COIN_COMPUTE_UNITS);
    expect(price!.data[0]).toBe(3); // SetComputeUnitPrice
    expect(price!.data.readBigUInt64LE(1)).toBe(1000n);
    expect(summary.computeUnitLimit).toBe(LAUNCH_COIN_COMPUTE_UNITS);
    expect(summary.computeUnitPriceMicroLamports).toBe(1000);
  });

  it('refuses a nonce account held by another authority', async () => {
    const { params } = await setup();
    const other = Keypair.generate().publicKey;
    const error = await buildLaunchCoinTx({
      ...params,
      durableNonce: { nonceAccount: params.durableNonce!.nonceAccount, authority: other },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DurableNonceError);
    expect((error as DurableNonceError).code).toBe('AUTHORITY_MISMATCH');
  });

  it('refuses a missing or uninitialized nonce account', async () => {
    const { params, connection } = await setup();
    const missing = Keypair.generate().publicKey;
    const error = await buildLaunchCoinTx({
      ...params,
      durableNonce: { nonceAccount: missing, authority: params.creator },
    }).catch((e: unknown) => e);
    expect((error as DurableNonceError).code).toBe('NOT_FOUND');

    const raw = Keypair.generate().publicKey;
    connection.accounts.set(
      raw.toBase58(),
      account(SystemProgram.programId, nonceAccountData(params.creator, NONCE_VALUE, 0)),
    );
    const error2 = await buildLaunchCoinTx({
      ...params,
      durableNonce: { nonceAccount: raw, authority: params.creator },
    }).catch((e: unknown) => e);
    expect((error2 as DurableNonceError).code).toBe('NOT_A_NONCE_ACCOUNT');
  });

  it('accepts a separate nonce authority and lists it on the signer side', async () => {
    const { params, connection } = await setup();
    const authority = Keypair.generate().publicKey;
    const nonceAccount = Keypair.generate().publicKey;
    connection.accounts.set(
      nonceAccount.toBase58(),
      account(SystemProgram.programId, nonceAccountData(authority, NONCE_VALUE)),
    );
    const { transaction, summary } = await buildLaunchCoinTx({
      ...params,
      durableNonce: { nonceAccount, authority },
    });
    expect(summary.signerSideSigners.map(String)).toEqual(
      [params.creator, (params.mint as Keypair).publicKey, authority].map(String),
    );
    expect(missingSigners(transaction)).toHaveLength(4);
  });
});

describe('buildLaunchCoinTx — without a durable nonce', () => {
  it('uses a fresh blockhash and has no nonceAdvance', async () => {
    const { params } = await setup({ durableNonce: undefined });
    const { transaction, summary } = await buildLaunchCoinTx(params);
    expect(transaction.recentBlockhash).toBe(BLOCKHASH);
    expect(transaction.lastValidBlockHeight).toBe(1_000);
    expect(summary.durableNonce).toBeNull();
    expect(summary.lastValidBlockHeight).toBe(1_000);
    expect(
      transaction.instructions.some(
        (ix) =>
          ix.programId.equals(SystemProgram.programId) &&
          SystemInstruction.decodeInstructionType(ix) === 'AdvanceNonceAccount',
      ),
    ).toBe(false);
    expect(transaction.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(
      true,
    );
  });
});

describe('buildLaunchCoinTx — signers and signing flow', () => {
  it('needs exactly owner (fee payer, first), creator and mint', async () => {
    const { params } = await setup();
    const { transaction, summary } = await buildLaunchCoinTx(params);
    const mint = (params.mint as Keypair).publicKey;
    expect(transaction.feePayer!.equals(OWNER)).toBe(true);
    const signers = missingSigners(transaction);
    expect(signers[0]!.equals(OWNER)).toBe(true);
    expect(signers.map(String).sort()).toEqual([OWNER, params.creator, mint].map(String).sort());
    expect(summary.signerSideSigners.map(String)).toEqual([params.creator, mint].map(String));
    expect(summary.ownerSigner.equals(OWNER)).toBe(true);
    expect(summary.feePayer.equals(OWNER)).toBe(true);
    expect(summary.rentPayer.equals(OWNER)).toBe(true);
  });

  it('keeps the creator wallet read-only when the owner pays the rent', async () => {
    const { params } = await setup();
    const { transaction } = await buildLaunchCoinTx(params);
    const message = transaction.compileMessage();
    const index = message.accountKeys.findIndex((k) => k.equals(params.creator));
    expect(message.isAccountWritable(index)).toBe(false);
  });

  it('makes the creator the rent payer on request, on a config without creation fee', async () => {
    const { params } = await setup(
      { rentPayer: 'creator' },
      { config: { poolCreationFee: new BN(0) } },
    );
    const { transaction, summary } = await buildLaunchCoinTx(params);
    const message = transaction.compileMessage();
    const index = message.accountKeys.findIndex((k) => k.equals(params.creator));
    expect(message.isAccountWritable(index)).toBe(true);
    expect(summary.rentPayer.equals(params.creator)).toBe(true);
    expect(summary.costs.creatorTotalLamports).toBeGreaterThan(0n);
    expect(summary.costs.poolCreationFeeLamports).toBe(0n);
  });

  it('refuses a coin config that charges a pool creation fee, whoever pays the rent', async () => {
    // The fixture as created on devnet charges 0.001 SOL: no current coin config does, and the
    // FORGE creator wallet would pay the client's own fee (RENT_PAYER_REFUSED, behind this check).
    for (const rentPayer of ['creator', 'owner'] as const) {
      const { params } = await setup(
        { rentPayer },
        { config: { poolCreationFee: new BN(1_000_000) } },
      );
      const error = await expectLaunchError(buildLaunchCoinTx(params), 'CONFIG_MISMATCH');
      expect(error.message).toContain('poolCreationFee is 1000000, expected 0');
    }
  });

  it('survives partial signing, base64 round trip and the owner signing last', async () => {
    const creator = Keypair.generate();
    const owner = Keypair.generate();
    const { params, connection } = await setup({
      creator: creator.publicKey,
      owner: owner.publicKey,
    });
    // The config must belong to this owner.
    connection.accounts.set(
      CONFIG.toBase58(),
      account(
        DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        await encodeConfig({ feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey }),
      ),
    );
    connection.accounts.set(
      params.durableNonce!.nonceAccount.toBase58(),
      account(SystemProgram.programId, nonceAccountData(creator.publicKey, NONCE_VALUE)),
    );
    const { transaction } = await buildLaunchCoinTx({
      ...params,
      durableNonce: {
        nonceAccount: params.durableNonce!.nonceAccount,
        authority: creator.publicKey,
      },
    });

    // Signer side.
    transaction.partialSign(creator, params.mint as Keypair);
    const base64 = serializeTransactionBase64(transaction);
    expect(missingSigners(transaction).map(String)).toEqual([owner.publicKey.toBase58()]);

    // Client side.
    const received = deserializeTransactionBase64(base64);
    expect(received.serializeMessage().equals(transaction.serializeMessage())).toBe(true);
    received.partialSign(owner);
    expect(received.verifySignatures(true)).toBe(true);
    const wire = received.serialize();
    expect(wire.length).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });
});

describe('buildLaunchCoinTx — first buy', () => {
  it('buys for the owner with the quoted minimum out', async () => {
    const { params } = await setup();
    const { summary } = await buildLaunchCoinTx(params);
    expect(summary.costs.firstBuyLamports).toBe(solToLamports(0.01));
    expect(summary.expectedTokensOut).toBeGreaterThan(0n);
    expect(summary.minimumTokensOut).toBe(
      (summary.expectedTokensOut * BigInt(10_000 - DEFAULT_FIRST_BUY_SLIPPAGE_BPS)) / 10_000n,
    );
    // Minimum (ending) fee of the fixture: 100 bps of the first buy.
    expect(summary.costs.firstBuyFeeLamports).toBe(solToLamports(0.01) / 100n);
  });

  it('matches the devnet launch exactly (0.01 SOL)', async () => {
    const { params } = await setup({ firstBuyLamports: solToLamports(0.01) });
    const { summary } = await buildLaunchCoinTx(params);
    // Measured on devnet (scripts/devnet-tests/reports/core-config-pool.md).
    expect(summary.expectedTokensOut).toBe(3_158_618_642_371n);
    expect(summary.costs.firstBuyFeeLamports).toBe(100_000n);
  });

  it('matches the devnet test 3 first buy exactly (0.05 SOL, same curve)', async () => {
    const { params } = await setup({ firstBuyLamports: solToLamports(0.05), slippageBps: 0 });
    const { summary } = await buildLaunchCoinTx(params);
    // Measured on devnet (scripts/devnet-tests/reports/test3-first-buy.md).
    expect(summary.expectedTokensOut).toBe(15_608_216_690_980n);
    expect(summary.costs.firstBuyFeeLamports).toBe(500_000n);
  });

  it('wires the swap after the pool creation, buyer = receiver = owner', async () => {
    const { params } = await setup();
    const { transaction } = await buildLaunchCoinTx(params);
    const mint = (params.mint as Keypair).publicKey;
    const dbc = transaction.instructions.filter((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    );
    expect(dbc).toHaveLength(2);
    const [create, swap] = dbc;
    const pool = deriveDbcPoolAddress(SOL_QUOTE_MINT, mint, CONFIG);
    expect(create!.keys.some((k) => k.pubkey.equals(pool))).toBe(true);
    const ownerAta = getAssociatedTokenAddressSync(mint, OWNER, true);
    expect(swap!.keys.some((k) => k.pubkey.equals(ownerAta) && k.isWritable)).toBe(true);
    expect(swap!.keys.some((k) => k.pubkey.equals(OWNER) && k.isSigner)).toBe(true);
    expect(transaction.instructions.indexOf(create!)).toBeLessThan(
      transaction.instructions.indexOf(swap!),
    );
  });

  it('builds a pool creation without a buy for 0 lamports', async () => {
    const { params } = await setup({ firstBuyLamports: 0n });
    const { transaction, summary } = await buildLaunchCoinTx(params);
    const dbc = transaction.instructions.filter((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    );
    expect(dbc).toHaveLength(1);
    expect(summary.costs.firstBuyLamports).toBe(0n);
    expect(summary.costs.ownerTokenAccountRentLamports).toBe(0n);
  });

  it('refuses a first buy above the 10 SOL spec bound and accepts 10 SOL', async () => {
    const { params } = await setup({ firstBuyLamports: solToLamports(50) });
    await expectLaunchError(buildLaunchCoinTx(params), 'INVALID_INPUT');
    expect(MAX_FIRST_BUY_LAMPORTS).toBe(solToLamports(10));
    const max = await setup({ firstBuyLamports: MAX_FIRST_BUY_LAMPORTS });
    const { summary } = await buildLaunchCoinTx(max.params);
    expect(summary.costs.firstBuyLamports).toBe(MAX_FIRST_BUY_LAMPORTS);
  });

  it.each([-1n, MAX_FIRST_BUY_LAMPORTS + 1n])('refuses first buy %s', async (lamports) => {
    const { params } = await setup({ firstBuyLamports: lamports });
    await expectLaunchError(buildLaunchCoinTx(params), 'INVALID_INPUT');
  });

  it('refuses a non-bigint first buy', () => {
    expect(() => assertFirstBuyLamports(1 as unknown as bigint)).toThrow(LaunchCoinError);
  });

  it.each([-1, 1001, 1.5])('refuses slippage %d', async (slippageBps) => {
    const { params } = await setup({ slippageBps });
    await expectLaunchError(buildLaunchCoinTx(params), 'INVALID_INPUT');
  });
});

describe('buildLaunchCoinTx — on-chain config checks', () => {
  it('refuses a missing config', async () => {
    const { params, connection } = await setup();
    connection.accounts.delete(CONFIG.toBase58());
    await expectLaunchError(buildLaunchCoinTx(params), 'CONFIG_NOT_FOUND');
  });

  it('refuses a config not owned by the DBC program', async () => {
    const { params, connection } = await setup();
    const info = connection.accounts.get(CONFIG.toBase58())!;
    connection.accounts.set(CONFIG.toBase58(), { ...info, owner: SystemProgram.programId });
    await expectLaunchError(buildLaunchCoinTx(params), 'CONFIG_MISMATCH');
  });

  it.each<[string, Partial<PoolConfig>]>([
    ['first swap at minimum fee disabled', { enableFirstSwapWithMinFee: 0 }],
    ['creator share is not 25%', { creatorTradingFeePercentage: 0 }],
    [
      'no creator locked liquidity',
      {
        creatorPermanentLockedLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 100,
      },
    ],
    ['fee claimer is not the owner', { feeClaimer: Keypair.generate().publicKey }],
    ['leftover receiver is not the owner', { leftoverReceiver: Keypair.generate().publicKey }],
    ['quote is not SOL', { quoteMint: Keypair.generate().publicKey }],
    ['token 2022', { tokenType: 1 }],
    ['DAMM v1 migration', { migrationOption: 0 }],
    ['migration threshold 1 SOL', { migrationQuoteThreshold: new BN(solToLamports(1).toString()) }],
  ])('refuses a config where %s', async (_label, change) => {
    const { params } = await setup({}, { config: change });
    await expectLaunchError(buildLaunchCoinTx(params), 'CONFIG_MISMATCH');
  });

  it('assertLaunchCoinConfig accepts the fixture for its fee claimer', () => {
    const current = { ...fixtureConfig, poolCreationFee: new BN(0) };
    expect(() => assertLaunchCoinConfig(current, OWNER)).not.toThrow();
    expect(BigInt(fixtureConfig.migrationQuoteThreshold.toString())).toBe(
      MIGRATION_THRESHOLD_LAMPORTS,
    );
  });

  it.each<[string, (config: PoolConfig) => Partial<PoolConfig>]>([
    ['mutable metadata', () => ({ tokenUpdateAuthority: 0 })],
    ['a pool creation fee', () => ({ poolCreationFee: new BN(1_000_000) })],
    [
      'another cliff fee',
      (c) => ({
        poolFees: {
          ...c.poolFees,
          baseFee: { ...c.poolFees.baseFee, cliffFeeNumerator: new BN(500_000_000) },
        },
      }),
    ],
    [
      'one 300 s period at 99%',
      (c) => ({
        poolFees: {
          ...c.poolFees,
          baseFee: {
            ...c.poolFees.baseFee,
            firstFactor: 1,
            secondFactor: new BN(300),
            thirdFactor: new BN(980_000_000),
          },
        },
      }),
    ],
    [
      'another reduction factor (ending fee 300 bps)',
      (c) => ({
        poolFees: {
          ...c.poolFees,
          baseFee: { ...c.poolFees.baseFee, thirdFactor: new BN(96_000_000) },
        },
      }),
    ],
    [
      'the partner liquidity not permanently locked',
      () => ({ partnerLiquidityPercentage: 75, partnerPermanentLockedLiquidityPercentage: 0 }),
    ],
    ['a migration fee', () => ({ migrationFeePercentage: 10 })],
    [
      'a creator migration fee',
      () => ({ migrationFeePercentage: 10, creatorMigrationFeePercentage: 100 }),
    ],
    [
      'locked vesting',
      (c) => ({ lockedVestingConfig: { ...c.lockedVestingConfig, cliffUnlockAmount: new BN(5) } }),
    ],
    ['slot activation', () => ({ activationType: 0 })],
    [
      'another curve point',
      (c) => ({
        curve: c.curve.map((p, i) => (i === 0 ? { ...p, liquidity: p.liquidity.addn(1) } : p)),
      }),
    ],
  ])('assertLaunchCoinConfig refuses a coin config with %s', (_label, change) => {
    const current = { ...fixtureConfig, poolCreationFee: new BN(0) };
    expect(() => assertLaunchCoinConfig({ ...current, ...change(current) }, OWNER)).toThrow(
      LaunchCoinError,
    );
  });

  it('assertLaunchCoinConfig compares with buildLaunchpadCoinConfig(spec) when given the spec', () => {
    const current = { ...fixtureConfig, poolCreationFee: new BN(0) };
    const spec = coinSpec('Moon', 'MOON');
    expect(() => assertLaunchCoinConfig(current, OWNER, spec)).not.toThrow();
    // A config of another trading fee, or without anti-sniper, is not this spec's.
    expect(() => assertLaunchCoinConfig(current, OWNER, { ...spec, tradingFeeBps: 150 })).toThrow(
      /baseFee/,
    );
    expect(() => assertLaunchCoinConfig(current, OWNER, { ...spec, antiSniper: false })).toThrow(
      /baseFee/,
    );
    // The spec's owner must be the owner checked.
    expect(() => assertLaunchCoinConfig(current, Keypair.generate().publicKey, spec)).toThrow(
      LaunchCoinError,
    );
  });

  it('buildLaunchCoinTx passes the spec to the config check', async () => {
    const spec = coinSpec('Moon', 'MOON');
    const { params } = await setup({ spec });
    await expect(buildLaunchCoinTx(params)).resolves.toBeDefined();
    const other = await setup({ spec: { ...spec, tradingFeeBps: 120 } });
    await expectLaunchError(buildLaunchCoinTx(other.params), 'CONFIG_MISMATCH');
  });

  it('refuses when the pool or the mint already exist', async () => {
    const { params, connection } = await setup();
    const mint = (params.mint as Keypair).publicKey;
    const pool = deriveDbcPoolAddress(SOL_QUOTE_MINT, mint, CONFIG);
    connection.accounts.set(
      pool.toBase58(),
      account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, Buffer.alloc(8)),
    );
    await expectLaunchError(buildLaunchCoinTx(params), 'POOL_EXISTS');
    connection.accounts.delete(pool.toBase58());
    connection.accounts.set(mint.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
    await expectLaunchError(buildLaunchCoinTx(params), 'MINT_EXISTS');
  });
});

describe('buildLaunchCoinTx — inputs', () => {
  it('refuses the owner as pool creator, and duplicated keys', async () => {
    const { params } = await setup();
    await expectLaunchError(buildLaunchCoinTx({ ...params, creator: OWNER }), 'INVALID_INPUT');
    await expectLaunchError(buildLaunchCoinTx({ ...params, mint: OWNER }), 'INVALID_INPUT');
    await expectLaunchError(
      buildLaunchCoinTx({
        ...params,
        durableNonce: { nonceAccount: OWNER, authority: params.creator },
      }),
      'INVALID_INPUT',
    );
  });

  it('refuses an unknown rent payer', async () => {
    const { params } = await setup({ rentPayer: 'client' as never });
    await expectLaunchError(buildLaunchCoinTx(params), 'INVALID_INPUT');
  });

  it.each([
    ['', 'MOON', 'https://example.com/a.json'],
    [' Moon', 'MOON', 'https://example.com/a.json'],
    ['x'.repeat(33), 'MOON', 'https://example.com/a.json'],
    ['Moon', 'moon', 'https://example.com/a.json'],
    ['Moon', 'M', 'https://example.com/a.json'],
    ['Moon', 'MOONMOONMOO', 'https://example.com/a.json'],
    ['Moon', 'MOON', 'http://example.com/a.json'],
    ['Moon', 'MOON', 'not a url'],
    ['Moon', 'MOON', `https://example.com/${'a'.repeat(190)}`],
  ])('refuses metadata (%j, %j, %j)', (name, symbol, uri) => {
    expect(() => assertLaunchMetadata(name, symbol, uri)).toThrow(LaunchCoinError);
  });

  it('accepts 32-byte names and 10-character symbols', () => {
    expect(() =>
      assertLaunchMetadata('x'.repeat(32), 'ABCDEFGHIJ', 'https://example.com/a.json'),
    ).not.toThrow();
  });
});

describe('buildLaunchCoinTx — no referral on the first buy', () => {
  /** Index of `referral_token_account` in the DBC swap accounts (program id when absent). */
  const SWAP_REFERRAL_INDEX = 12;
  const swapOf = (instructions: TransactionInstruction[]) =>
    instructions.filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))[1]!;

  it('leaves the referral slot of the first buy empty by default', async () => {
    const { params } = await setup();
    const { summary, transaction } = await buildLaunchCoinTx(params);
    const referralSlot = swapOf(transaction.instructions).keys[SWAP_REFERRAL_INDEX]!;
    expect(referralSlot.pubkey.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(referralSlot.isWritable).toBe(false);
    expect(summary.referralTokenAccount).toBeNull();
    expect(summary.referralSource).toBe('none');
    expect(summary.referralOmittedForSize).toBe(false);
    expect(summary.txBytes).toBe(1120);
  });

  it('ignores FORGE_METEORA_REFERRAL_ACCOUNT, in env and in process.env', async () => {
    const referral = Keypair.generate().publicKey;
    const previous = process.env.FORGE_METEORA_REFERRAL_ACCOUNT;
    process.env.FORGE_METEORA_REFERRAL_ACCOUNT = referral.toBase58();
    try {
      const { params } = await setup({
        env: { FORGE_METEORA_REFERRAL_ACCOUNT: referral.toBase58() },
      });
      const { summary, transaction } = await buildLaunchCoinTx(params);
      expect(transaction.compileMessage().accountKeys.some((k) => k.equals(referral))).toBe(false);
      expect(summary.referralSource).toBe('none');
      // An invalid value is not read either.
      const bad = await setup({ env: { FORGE_METEORA_REFERRAL_ACCOUNT: 'not-a-key' } });
      await expect(buildLaunchCoinTx(bad.params)).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.FORGE_METEORA_REFERRAL_ACCOUNT;
      else process.env.FORGE_METEORA_REFERRAL_ACCOUNT = previous;
    }
  });

  it('refuses an explicit referral instead of dropping it, accepts an explicit null', async () => {
    const referral = Keypair.generate().publicKey;
    const { params, connection } = await setup({ referralTokenAccount: referral });
    connection.accounts.set(
      referral.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(Keypair.generate().publicKey)),
    );
    const error = await expectLaunchError(buildLaunchCoinTx(params), 'REFERRAL_UNSUPPORTED');
    expect(error.message).toContain('minimum fee');
    // Refused before any network call.
    expect(connection.calls).toEqual([]);

    const none = await buildLaunchCoinTx({ ...params, referralTokenAccount: null });
    expect(none.summary.referralTokenAccount).toBeNull();
    // Even without a first buy, a referral is a caller bug.
    await expectLaunchError(
      buildLaunchCoinTx({ ...params, firstBuyLamports: 0n }),
      'REFERRAL_UNSUPPORTED',
    );
  });

  it('quotes the first buy without a referral share', async () => {
    const { params } = await setup({ slippageBps: 0 });
    const { summary } = await buildLaunchCoinTx(params);
    // 1% minimum fee, all of it trading + protocol (no referral cut).
    expect(summary.costs.firstBuyFeeLamports).toBe(params.firstBuyLamports / 100n);
    expect(summary.minimumTokensOut).toBe(summary.expectedTokensOut);
  });

  it('keeps the size headroom of the referral: a 32-byte name, 10-character symbol and 106-byte URI fit', async () => {
    const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;
    const { params } = await setup({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri(106),
    });
    const { summary } = await buildLaunchCoinTx(params);
    expect(summary.txBytes).toBe(MAX_TRANSACTION_BYTES);
  });
});

describe('buildLaunchCoinTx — owner WSOL account', () => {
  const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, OWNER, true);
  const wsolCreations = (instructions: TransactionInstruction[]) =>
    instructions.filter(
      (ix) =>
        ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]!.pubkey.equals(ownerWsol),
    );

  it('creates it idempotently even when it exists at build time (closed before signing)', async () => {
    const { params, connection } = await setup();
    connection.accounts.set(
      ownerWsol.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(OWNER)),
    );
    const { transaction } = await buildLaunchCoinTx(params);
    const creations = wsolCreations(transaction.instructions);
    expect(creations).toHaveLength(1);
    const [create] = creations;
    expect([...create!.data]).toEqual([1]); // CreateIdempotent
    expect(create!.keys[0]!.pubkey.equals(OWNER)).toBe(true); // funded by the owner
    expect(create!.keys[2]!.pubkey.equals(OWNER)).toBe(true);
    expect(create!.keys[3]!.pubkey.equals(NATIVE_MINT)).toBe(true);
    // Before the SOL wrap and the swap that use it.
    const wrap = transaction.instructions.findIndex(
      (ix) =>
        ix.programId.equals(SystemProgram.programId) &&
        SystemInstruction.decodeInstructionType(ix) === 'Transfer' &&
        ix.keys[1]!.pubkey.equals(ownerWsol),
    );
    expect(wrap).toBeGreaterThan(0);
    expect(transaction.instructions.indexOf(create!)).toBeLessThan(wrap);
  });

  it('keeps the single SDK creation when the account is missing, at the same size', async () => {
    const missing = await setup();
    const withMissing = await buildLaunchCoinTx(missing.params);
    expect(wsolCreations(withMissing.transaction.instructions)).toHaveLength(1);
    expect([...wsolCreations(withMissing.transaction.instructions)[0]!.data]).toEqual([1]);

    const existing = await setup();
    existing.connection.accounts.set(
      ownerWsol.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(OWNER)),
    );
    const withExisting = await buildLaunchCoinTx(existing.params);
    expect(withExisting.summary.txBytes).toBe(withMissing.summary.txBytes);
  });

  it('adds no WSOL account without a first buy', async () => {
    const { params } = await setup({ firstBuyLamports: 0n });
    const { transaction } = await buildLaunchCoinTx(params);
    expect(wsolCreations(transaction.instructions)).toHaveLength(0);
  });
});

describe('buildLaunchCoinTx — size', () => {
  const R2_URI = `https://pub-${'0'.repeat(32)}.r2.dev/metadata/${'u'.repeat(36)}.json`;

  it('measures the standard launch (nonce by the creator, no priority fee)', async () => {
    const { params } = await setup();
    // name 4 + symbol 4 + uri 29 bytes of metadata: 112 bytes left for longer metadata.
    expect((await buildLaunchCoinTx(params)).summary.txBytes).toBe(1120);
  });

  it('measures the devnet test 3 shape plus the compute unit limit', async () => {
    const { params } = await setup({
      name: 'Forge Test Three',
      symbol: 'FT3',
      metadataUri: 'https://example.com/forge-test-3.json',
      durableNonce: undefined,
    });
    // 1,025 bytes measured on devnet + 40 bytes for setComputeUnitLimit.
    expect((await buildLaunchCoinTx(params)).summary.txBytes).toBe(1065);
  });

  it('matches the devnet launch transaction size (1166 bytes)', async () => {
    const { params } = await setup({
      name: 'Forge Core Devnet Coin',
      symbol: 'FCORE',
      metadataUri: 'https://example.com/forge/core-config-pool/metadata.json',
    });
    expect((await buildLaunchCoinTx(params)).summary.txBytes).toBe(1166);
  });

  it('fits a 32-byte name, a 10-character symbol and an R2 metadata URL', async () => {
    const { params } = await setup({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: R2_URI,
    });
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(R2_URI.length).toBe(102);
    expect(summary.txBytes).toBe(1228); // the create-pool data length takes a 2-byte shortvec
    expect(summary.txBytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    transaction.partialSign(params.mint as Keypair);
    expect(serializeTransactionBase64(transaction).length).toBeGreaterThan(0);
  });

  it('refuses a transaction over the size limit and says by how much', async () => {
    const { params } = await setup({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: R2_URI,
      computeUnitPriceMicroLamports: 1,
    });
    const error = await expectLaunchError(buildLaunchCoinTx(params), 'TX_TOO_LARGE');
    expect(error.message).toContain('1240 bytes');
  });

  it.each([
    ['N'.repeat(32), 'S'.repeat(10), 106],
    ['N', 'SS', 145],
    ['é'.repeat(16), 'S'.repeat(10), 106],
    ['Moon Coin', 'MOON', 135],
  ] as const)(
    'holds exactly LAUNCH_METADATA_BUDGET_BYTES of name + symbol + URI (%j, %j, %d-byte URI)',
    async (name, symbol, uriBytes) => {
      const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;
      const spec = coinSpec(name, symbol);
      const fits = uri(uriBytes);
      expect(launchMetadataBytes(name, symbol, fits)).toBe(LAUNCH_METADATA_BUDGET_BYTES);
      expect(() => assertSpecLaunchable(spec, fits)).not.toThrow();
      const { params } = await setup({ name, symbol, metadataUri: fits });
      expect((await buildLaunchCoinTx(params)).summary.txBytes).toBe(MAX_TRANSACTION_BYTES);

      // One more byte does not fit: assertSpecLaunchable refuses it up front, as the builder does.
      const over = uri(uriBytes + 1);
      let refused: unknown = null;
      try {
        assertSpecLaunchable(spec, over);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(LaunchCoinError);
      expect((refused as LaunchCoinError).code).toBe('TX_TOO_LARGE');
      const tooLarge = await setup({ name, symbol, metadataUri: over });
      await expectLaunchError(buildLaunchCoinTx(tooLarge.params), 'TX_TOO_LARGE');
    },
  );
});

describe('buildLaunchCoinTx — costs', () => {
  it('adds up what the owner pays when it pays the rent', async () => {
    const { params } = await setup();
    const { summary } = await buildLaunchCoinTx(params);
    const { costs } = summary;
    const poolSize = decoderProgramSize();
    const accountsRent = BigInt(
      rent(poolSize) + rent(MINT_SIZE) + rent(METADATA_ACCOUNT_SIZE) + 2 * rent(ACCOUNT_SIZE),
    );
    expect(costs.poolAccountsRentLamports).toBe(accountsRent);
    expect(costs.poolCreationFeeLamports).toBe(0n);
    expect(costs.metaplexFeeLamports).toBe(METAPLEX_CREATE_METADATA_FEE_LAMPORTS);
    expect(costs.ownerTokenAccountRentLamports).toBe(BigInt(rent(ACCOUNT_SIZE)));
    expect(costs.ownerTemporaryLamports).toBe(BigInt(rent(ACCOUNT_SIZE)));
    expect(costs.networkFeeLamports).toBe(25_000n);
    expect(costs.networkFeeSource).toBe('cluster');
    expect(costs.ownerTotalLamports).toBe(
      costs.firstBuyLamports +
        costs.networkFeeLamports +
        costs.ownerTokenAccountRentLamports +
        accountsRent +
        METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
    );
    expect(costs.platformFeeLamports).toBeUndefined();
    expect(costs.ownerRequiredBalanceLamports).toBe(
      costs.ownerTotalLamports + costs.ownerTemporaryLamports,
    );
    expect(costs.creatorTotalLamports).toBe(0n);
  });

  it('moves the pool costs to the creator when it pays the rent', async () => {
    const { params } = await setup(
      { rentPayer: 'creator' },
      { config: { poolCreationFee: new BN(0) } },
    );
    const { costs } = (await buildLaunchCoinTx(params)).summary;
    expect(costs.creatorTotalLamports).toBe(
      costs.poolAccountsRentLamports + costs.metaplexFeeLamports + costs.poolCreationFeeLamports,
    );
    expect(costs.ownerTotalLamports).toBe(
      costs.firstBuyLamports + costs.networkFeeLamports + costs.ownerTokenAccountRentLamports,
    );
  });

  it('keeps the temporary WSOL rent when the owner already has a WSOL account', async () => {
    // The account can be closed between build and signature: it is created again in the
    // transaction, so its rent must stay available.
    const { params, connection } = await setup();
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, OWNER, true);
    connection.accounts.set(
      wsol.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(OWNER)),
    );
    const { costs } = (await buildLaunchCoinTx(params)).summary;
    expect(costs.ownerTemporaryLamports).toBe(BigInt(rent(ACCOUNT_SIZE)));
  });

  it('estimates the network fee when the cluster does not answer', async () => {
    const { params } = await setup(
      { computeUnitPriceMicroLamports: 10_000 },
      { feeForMessage: new Error('rpc down') },
    );
    const { costs } = (await buildLaunchCoinTx(params)).summary;
    expect(costs.networkFeeSource).toBe('estimate');
    // 3 signatures x 5000 (from the nonce account) + 300,000 CU x 10,000 micro-lamports.
    expect(costs.networkFeeLamports).toBe(15_000n + 3_000n);
  });

  it('maps to the shared OwnerTransactionSummary', async () => {
    const { params } = await setup();
    const { summary } = await buildLaunchCoinTx(params);
    const shared = toOwnerTransactionSummary(summary);
    expect(OwnerTransactionSummary.parse(shared)).toEqual(shared);
    expect(shared).toEqual({
      coinName: 'Moon',
      coinSymbol: 'MOON',
      firstBuyLamports: solToLamports(0.01).toString(),
      estimatedNetworkFeeLamports: (
        summary.costs.ownerTotalLamports - summary.costs.firstBuyLamports
      ).toString(),
      ownerWallet: OWNER.toBase58(),
      ownerRequiredBalanceLamports: summary.costs.ownerRequiredBalanceLamports.toString(),
    });
  });

  it('tells the owner the balance to hold, temporary WSOL rent included', async () => {
    const { params } = await setup();
    const { summary } = await buildLaunchCoinTx(params);
    const shared = toOwnerTransactionSummary(summary);
    const wsolRent = BigInt(rent(ACCOUNT_SIZE));
    expect(summary.costs.ownerTemporaryLamports).toBe(wsolRent);
    // First buy + everything else the owner pays + the WSOL account held during the transaction.
    expect(BigInt(shared.ownerRequiredBalanceLamports!)).toBe(
      BigInt(shared.firstBuyLamports) + BigInt(shared.estimatedNetworkFeeLamports) + wsolRent,
    );
    // Without a first buy there is no temporary WSOL account.
    const none = await setup({ firstBuyLamports: 0n });
    const noBuy = toOwnerTransactionSummary((await buildLaunchCoinTx(none.params)).summary);
    expect(BigInt(noBuy.ownerRequiredBalanceLamports!)).toBe(
      BigInt(noBuy.estimatedNetworkFeeLamports),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// verifyLaunchCoinTransaction (launch-check.ts) on what buildLaunchCoinTx builds
// ---------------------------------------------------------------------------------------------

interface SignedLaunch {
  transaction: Transaction;
  summary: Awaited<ReturnType<typeof buildLaunchCoinTx>>['summary'];
  creator: Keypair;
  mint: Keypair;
  nonceAccount: PublicKey;
  params: BuildLaunchCoinTxParams;
  expected: ExpectedLaunchCoinTransaction;
}

/** The launch as the signer hands it out: built by core, signed by the creator and the mint. */
async function signedLaunch(
  overrides: Partial<BuildLaunchCoinTxParams> = {},
  options: { config?: Partial<PoolConfig> } = {},
  sign: 'both' | 'creator' | 'mint' = 'both',
): Promise<SignedLaunch> {
  const creator = Keypair.generate();
  const { params, connection, mint } = await setup(overrides, options);
  const nonceAccount = Keypair.generate().publicKey;
  connection.accounts.set(
    nonceAccount.toBase58(),
    account(SystemProgram.programId, nonceAccountData(creator.publicKey, NONCE_VALUE)),
  );
  const full: BuildLaunchCoinTxParams = {
    ...params,
    creator: creator.publicKey,
    durableNonce: { nonceAccount, authority: creator.publicKey },
  };
  const { transaction, summary } = await buildLaunchCoinTx(full);
  if (sign === 'both') transaction.partialSign(creator, mint);
  else transaction.partialSign(sign === 'creator' ? creator : mint);
  return {
    transaction,
    summary,
    creator,
    mint,
    nonceAccount,
    params: full,
    expected: {
      owner: full.owner,
      firstBuyLamports: full.firstBuyLamports,
      creator: creator.publicKey,
      mint: mint.publicKey,
      config: full.config,
      nonceAccount,
      name: full.name,
      symbol: full.symbol,
      metadataUri: full.metadataUri,
    },
  };
}

function cloneIx(ix: TransactionInstruction): TransactionInstruction {
  return new TransactionInstructionClass({
    programId: ix.programId,
    keys: ix.keys.map((k) => ({ ...k })),
    data: Buffer.from(ix.data),
  });
}

/**
 * The same launch with its instructions changed, re-signed by the creator and the mint (and any
 * extra signer): only its structure can betray it.
 */
function tampered(
  launch: SignedLaunch,
  mutate: (instructions: TransactionInstruction[]) => TransactionInstruction[] | void,
  options: { feePayer?: PublicKey; extraSigners?: Keypair[] } = {},
): Transaction {
  const instructions = launch.transaction.instructions.map(cloneIx);
  const changed = mutate(instructions) ?? instructions;
  const tx = new Transaction({
    feePayer: options.feePayer ?? launch.transaction.feePayer!,
    recentBlockhash: launch.transaction.recentBlockhash!,
  });
  tx.add(...changed);
  tx.partialSign(launch.creator, launch.mint, ...(options.extraSigners ?? []));
  return tx;
}

function checkCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchTransactionCheckError);
    return (error as LaunchTransactionCheckError).code;
  }
}

const isDbc = (ix: TransactionInstruction) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID);
const isSwap = (ix: TransactionInstruction) => isDbc(ix) && ix.data[0] === 248;
const isInit = (ix: TransactionInstruction) => isDbc(ix) && ix.data[0] === 140;

/** Replaces account `index` of the matching instructions. */
function withAccount(
  launch: SignedLaunch,
  match: (ix: TransactionInstruction) => boolean,
  index: number,
  pubkey: PublicKey,
): Transaction {
  return tampered(launch, (ixs) =>
    ixs.map((ix) => {
      // A random key cannot sign: keep the signer set, change only the account.
      if (match(ix)) ix.keys[index] = { ...ix.keys[index]!, pubkey, isSigner: false };
      return ix;
    }),
  );
}

describe('verifyLaunchCoinTransaction — accepts what core builds', () => {
  it('accepts the signed launch with every expected value, and says what it does', async () => {
    const launch = await signedLaunch();
    const verified = verifyLaunchCoinTransaction(launch.transaction, launch.expected);
    expect(verified.owner.equals(OWNER)).toBe(true);
    expect(verified.creator.equals(launch.creator.publicKey)).toBe(true);
    expect(verified.mint.equals(launch.mint.publicKey)).toBe(true);
    expect(verified.config.equals(CONFIG)).toBe(true);
    expect(verified.pool.equals(launch.summary.pool)).toBe(true);
    expect(verified.nonceAccount.equals(launch.nonceAccount)).toBe(true);
    expect(verified.nonce).toBe(NONCE_VALUE);
    expect(verified).toMatchObject({
      name: 'Moon',
      symbol: 'MOON',
      metadataUri: 'https://example.com/moon.json',
      firstBuyLamports: solToLamports(0.01),
      minimumTokensOut: launch.summary.minimumTokensOut,
      ownerSigned: false,
    });
  });

  it('accepts it knowing only the owner and the first buy, legacy, versioned or raw', async () => {
    const launch = await signedLaunch();
    const minimal = { owner: OWNER.toBase58(), firstBuyLamports: solToLamports(0.01) };
    const bytes = launch.transaction.serialize({ requireAllSignatures: false });
    expect(verifyLaunchCoinTransaction(launch.transaction, minimal).pool).toEqual(
      launch.summary.pool,
    );
    expect(() =>
      verifyLaunchCoinTransaction(VersionedTransaction.deserialize(bytes), minimal),
    ).not.toThrow();
    expect(() => verifyLaunchCoinTransaction(new Uint8Array(bytes), minimal)).not.toThrow();
    // The base64 round trip of jobs.owner_tx.
    const stored = deserializeTransactionBase64(serializeTransactionBase64(launch.transaction));
    expect(() => verifyLaunchCoinTransaction(stored, launch.expected)).not.toThrow();
  });

  it('accepts a launch without a first buy (no swap, no SOL moved)', async () => {
    const launch = await signedLaunch({ firstBuyLamports: 0n });
    const verified = verifyLaunchCoinTransaction(launch.transaction, launch.expected);
    expect(verified.firstBuyLamports).toBe(0n);
    expect(verified.minimumTokensOut).toBe(0n);
    // A first buy the owner expects but the transaction does not carry.
    expect(
      checkCode(() =>
        verifyLaunchCoinTransaction(launch.transaction, {
          ...launch.expected,
          firstBuyLamports: 1n,
        }),
      ),
    ).toBe('MISMATCH');
  });

  it('accepts a bounded priority fee', async () => {
    const launch = await signedLaunch({ computeUnitPriceMicroLamports: 1000 });
    expect(() => verifyLaunchCoinTransaction(launch.transaction, launch.expected)).not.toThrow();
  });

  it('accepts the owner-signed copy and refuses a bad owner signature', async () => {
    const owner = Keypair.generate();
    const launch = await signedLaunch(
      { owner: owner.publicKey },
      { config: { feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey } },
    );
    launch.transaction.partialSign(owner);
    expect(verifyLaunchCoinTransaction(launch.transaction, launch.expected).ownerSigned).toBe(true);
    const bytes = launch.transaction.serialize();
    bytes[1] = bytes[1]! ^ 0xff; // the owner (fee payer) signature comes first
    expect(checkCode(() => verifyLaunchCoinTransaction(bytes, launch.expected))).toBe(
      'INVALID_SIGNATURE',
    );
  });
});

describe('verifyLaunchCoinTransaction — refusals', () => {
  it.each([
    ['firstBuyLamports', { firstBuyLamports: solToLamports(0.01) + 1n }],
    ['config', { config: Keypair.generate().publicKey }],
    ['mint', { mint: Keypair.generate().publicKey }],
    ['creator', { creator: Keypair.generate().publicKey }],
    ['nonceAccount', { nonceAccount: Keypair.generate().publicKey }],
    ['name', { name: 'Mars' }],
    ['symbol', { symbol: 'MARS' }],
    ['metadataUri', { metadataUri: 'https://example.com/mars.json' }],
  ] as const)('refuses another %s than expected', async (_field, change) => {
    const launch = await signedLaunch();
    expect(
      checkCode(() =>
        verifyLaunchCoinTransaction(launch.transaction, { ...launch.expected, ...change }),
      ),
    ).toBe('MISMATCH');
  });

  it('refuses another owner (fee payer)', async () => {
    const launch = await signedLaunch();
    expect(
      checkCode(() =>
        verifyLaunchCoinTransaction(launch.transaction, {
          ...launch.expected,
          owner: Keypair.generate().publicKey,
        }),
      ),
    ).toBe('UNEXPECTED_SIGNERS');
  });

  it('refuses a missing creator or mint signature, and an invalid one', async () => {
    const onlyMint = await signedLaunch({}, {}, 'mint');
    expect(
      checkCode(() => verifyLaunchCoinTransaction(onlyMint.transaction, onlyMint.expected)),
    ).toBe('MISSING_SIGNATURE');
    const onlyCreator = await signedLaunch({}, {}, 'creator');
    expect(
      checkCode(() => verifyLaunchCoinTransaction(onlyCreator.transaction, onlyCreator.expected)),
    ).toBe('MISSING_SIGNATURE');
    // The creator slot holds bytes that are not its signature of this message.
    const launch = await signedLaunch();
    const bytes = launch.transaction.serialize({ requireAllSignatures: false });
    const slot = launch.transaction
      .compileMessage()
      .accountKeys.findIndex((k) => k.equals(launch.creator.publicKey));
    bytes[1 + 64 * slot] = bytes[1 + 64 * slot]! ^ 0x01;
    expect(checkCode(() => verifyLaunchCoinTransaction(bytes, launch.expected))).toBe(
      'INVALID_SIGNATURE',
    );
  });

  it('refuses SOL sent anywhere but the owner WSOL account, and another wrapped amount', async () => {
    const launch = await signedLaunch();
    const thief = Keypair.generate().publicKey;
    const steal = tampered(launch, (ixs) => {
      ixs.push(SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: thief, lamports: 1 }));
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(steal, launch.expected))).toBe('MISMATCH');
    const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, OWNER, true);
    const more = tampered(launch, (ixs) => {
      ixs.push(SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: ownerWsol, lamports: 1 }));
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(more, launch.expected))).toBe('MISMATCH');
  });

  it('refuses wrapped SOL closed to someone else, and any other token call', async () => {
    const launch = await signedLaunch();
    const thief = Keypair.generate().publicKey;
    const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, OWNER, true);
    const closeElsewhere = tampered(launch, (ixs) =>
      ixs.map((ix) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9
          ? createCloseAccountInstruction(ownerWsol, thief, OWNER)
          : ix,
      ),
    );
    expect(checkCode(() => verifyLaunchCoinTransaction(closeElsewhere, launch.expected))).toBe(
      'MISMATCH',
    );
    const ownerCoin = getAssociatedTokenAddressSync(launch.mint.publicKey, OWNER, true);
    const approve = tampered(launch, (ixs) => {
      ixs.push(createApproveInstruction(ownerCoin, thief, OWNER, 1n));
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(approve, launch.expected))).toBe(
      'UNEXPECTED_INSTRUCTION',
    );
  });

  it('refuses a token account created for someone else', async () => {
    const launch = await signedLaunch();
    const other = Keypair.generate().publicKey;
    const tx = tampered(launch, (ixs) => {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          OWNER,
          getAssociatedTokenAddressSync(NATIVE_MINT, other, true),
          other,
          NATIVE_MINT,
        ),
      );
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(tx, launch.expected))).toBe('MISMATCH');
  });

  it('refuses an unknown program and an extra signer', async () => {
    const launch = await signedLaunch();
    const memo = tampered(launch, (ixs) => {
      ixs.push(
        new TransactionInstructionClass({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from('hello'),
        }),
      );
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(memo, launch.expected))).toBe(
      'UNEXPECTED_INSTRUCTION',
    );
    // A fourth signer (here in the referral slot of the first buy, the size limit allows it).
    const extra = Keypair.generate();
    const fourth = tampered(
      launch,
      (ixs) =>
        ixs.map((ix) => {
          if (isSwap(ix))
            ix.keys[12] = { pubkey: extra.publicKey, isSigner: true, isWritable: true };
          return ix;
        }),
      { extraSigners: [extra] },
    );
    expect(checkCode(() => verifyLaunchCoinTransaction(fourth, launch.expected))).toBe(
      'UNEXPECTED_SIGNERS',
    );
  });

  it('refuses another fee payer', async () => {
    const launch = await signedLaunch();
    const payer = Keypair.generate();
    const tx = tampered(launch, () => undefined, {
      feePayer: payer.publicKey,
      extraSigners: [payer],
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(tx, launch.expected))).toBe(
      'UNEXPECTED_SIGNERS',
    );
  });

  it('refuses a nonce advance that is not first, or by another authority', async () => {
    const launch = await signedLaunch();
    const swapped = tampered(launch, ([nonce, limit, ...rest]) => [limit!, nonce!, ...rest]);
    expect(checkCode(() => verifyLaunchCoinTransaction(swapped, launch.expected))).toBe(
      'UNEXPECTED_INSTRUCTION',
    );
    const otherAuthority = Keypair.generate();
    const advance = tampered(
      launch,
      ([, ...rest]) => [
        SystemProgram.nonceAdvance({
          noncePubkey: launch.nonceAccount,
          authorizedPubkey: otherAuthority.publicKey,
        }),
        ...rest,
      ],
      { extraSigners: [otherAuthority] },
    );
    expect(checkCode(() => verifyLaunchCoinTransaction(advance, launch.expected))).toBe(
      'UNEXPECTED_SIGNERS',
    );
  });

  it('refuses any other use of the creator signature (a second nonce advance)', async () => {
    const launch = await signedLaunch();
    const tx = tampered(launch, (ixs) => {
      ixs.push(
        SystemProgram.nonceAdvance({
          noncePubkey: Keypair.generate().publicKey,
          authorizedPubkey: launch.creator.publicKey,
        }),
      );
    });
    expect(checkCode(() => verifyLaunchCoinTransaction(tx, launch.expected))).toBe('MISMATCH');
  });

  it('refuses a first buy with a referral, on another pool, or delivered elsewhere', async () => {
    const launch = await signedLaunch();
    for (const index of [12, 2, 4, 9]) {
      const tx = withAccount(launch, isSwap, index, Keypair.generate().publicKey);
      expect(checkCode(() => verifyLaunchCoinTransaction(tx, launch.expected))).not.toBeNull();
    }
    const referral = withAccount(launch, isSwap, 12, Keypair.generate().publicKey);
    expect(checkCode(() => verifyLaunchCoinTransaction(referral, launch.expected))).toBe(
      'MISMATCH',
    );
  });

  it('refuses a first buy of another amount or accepting nothing', async () => {
    const launch = await signedLaunch();
    const withData = (write: (data: Buffer) => void) =>
      tampered(launch, (ixs) =>
        ixs.map((ix) => {
          if (isSwap(ix)) write(ix.data as Buffer);
          return ix;
        }),
      );
    const bigger = withData((d) => d.writeBigUInt64LE(solToLamports(1), 8));
    expect(checkCode(() => verifyLaunchCoinTransaction(bigger, launch.expected))).toBe('MISMATCH');
    const nothing = withData((d) => d.writeBigUInt64LE(0n, 16));
    expect(checkCode(() => verifyLaunchCoinTransaction(nothing, launch.expected))).toBe('MISMATCH');
  });

  it('refuses a pool creation on another pool, metadata or rent payer', async () => {
    const launch = await signedLaunch();
    for (const index of [1, 5, 6, 8, 10, 14]) {
      const tx = withAccount(launch, isInit, index, Keypair.generate().publicKey);
      expect(checkCode(() => verifyLaunchCoinTransaction(tx, launch.expected))).toBe('MISMATCH');
    }
  });

  it('refuses an excessive priority fee', async () => {
    const launch = await signedLaunch({ computeUnitPriceMicroLamports: 1_000_000_000 });
    expect(checkCode(() => verifyLaunchCoinTransaction(launch.transaction, launch.expected))).toBe(
      'UNEXPECTED_INSTRUCTION',
    );
  });

  it('refuses a versioned (v0) message and garbage', async () => {
    const launch = await signedLaunch();
    const v0 = new VersionedTransaction(
      new TransactionMessage({
        payerKey: OWNER,
        recentBlockhash: NONCE_VALUE,
        instructions: launch.transaction.instructions,
      }).compileToV0Message(),
    );
    expect(checkCode(() => verifyLaunchCoinTransaction(v0, launch.expected))).toBe('MALFORMED');
    expect(
      checkCode(() => verifyLaunchCoinTransaction(new Uint8Array([1, 2, 3]), launch.expected)),
    ).toBe('MALFORMED');
  });
});

// ---------------------------------------------------------------------------------------------
// buildUserCoinLaunchTx
// ---------------------------------------------------------------------------------------------

interface UserSetup {
  wallet: PublicKey;
  mint: Keypair;
  /** FORGE_PLATFORM_FEE_WALLET of the env (a funded system account on the mocked chain). */
  platformWallet: PublicKey;
  connection: ReturnType<typeof mockConnection>;
  params: BuildUserCoinLaunchTxParams;
}

/** Platform fee of the default 0.01 SOL first buy: ceil(10,000,000 x 30 / 10,000). */
const USER_PLATFORM_FEE = 30_000n;

/**
 * A user (not the config's fee claimer) launching a coin on the fixture config. The fixture is a
 * launchpad coin config; as a launchpad config it is the one core builds for a spec with a 25%
 * creator share and a 0.001 SOL creation fee (encoded here), so the user-coin checks accept it.
 */
async function userSetup(
  overrides: Partial<BuildUserCoinLaunchTxParams> = {},
  options: { config?: Partial<PoolConfig>; feeForMessage?: number | null | Error } = {},
): Promise<UserSetup> {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate();
  const platformWallet = Keypair.generate().publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(
    CONFIG.toBase58(),
    account(
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      await encodeConfig({ poolCreationFee: new BN(1_000_000), ...options.config }),
    ),
  );
  accounts.set(NATIVE_MINT.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
  accounts.set(platformWallet.toBase58(), account(SystemProgram.programId, Buffer.alloc(0)));
  const connection = mockConnection({ accounts, feeForMessage: options.feeForMessage ?? 10_000 });
  const params: BuildUserCoinLaunchTxParams = {
    connection: connection as unknown as Connection,
    config: CONFIG,
    wallet,
    mint,
    name: 'Lisa Coin',
    symbol: 'LISA',
    metadataUri: 'https://example.com/lisa.json',
    firstBuyLamports: solToLamports(0.01),
    env: { FORGE_PLATFORM_FEE_WALLET: platformWallet.toBase58() },
    ...overrides,
  };
  return { wallet, mint, platformWallet, connection, params };
}

const dbcInstructions = (instructions: TransactionInstruction[]) =>
  instructions.filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID));

/**
 * Size of a user coin launch with short metadata (4-byte name and symbol, 29-byte URI): 950 bytes
 * without the platform fee transfer, 999 with it (one more account key and one instruction).
 */
const USER_COIN_STANDARD_TX_BYTES = 999;
const USER_COIN_WITHOUT_PLATFORM_FEE_TX_BYTES = 950;

describe('buildUserCoinLaunchTx — signers and accounts', () => {
  it('needs exactly the wallet (fee payer, first) and the mint', async () => {
    const { params, wallet, mint } = await userSetup();
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    expect(transaction.feePayer!.equals(wallet)).toBe(true);
    expect(missingSigners(transaction).map(String)).toEqual([wallet, mint.publicKey].map(String));
    expect(summary.signers.map(String)).toEqual([wallet, mint.publicKey].map(String));
    expect(summary.wallet.equals(wallet)).toBe(true);
    expect(summary.mint.equals(mint.publicKey)).toBe(true);
    expect(summary.pool.equals(deriveDbcPoolAddress(SOL_QUOTE_MINT, mint.publicKey, CONFIG))).toBe(
      true,
    );
  });

  it('makes the wallet pool creator and payer of the pool, and buyer of the first buy', async () => {
    const { params, wallet, mint } = await userSetup();
    const { transaction } = await buildUserCoinLaunchTx(params);
    const [create, swap] = dbcInstructions(transaction.instructions);
    // initialize_virtual_pool_with_spl_token: creator #2, base mint #3, payer #10.
    expect(create!.keys[2]!.pubkey.equals(wallet)).toBe(true);
    expect(create!.keys[2]!.isSigner).toBe(true);
    expect(create!.keys[3]!.pubkey.equals(mint.publicKey)).toBe(true);
    expect(create!.keys[10]!.pubkey.equals(wallet)).toBe(true);
    expect(create!.keys[10]!.isWritable).toBe(true);
    const walletCoin = getAssociatedTokenAddressSync(mint.publicKey, wallet, true);
    expect(swap!.keys.some((k) => k.pubkey.equals(walletCoin) && k.isWritable)).toBe(true);
    expect(swap!.keys.some((k) => k.pubkey.equals(wallet) && k.isSigner)).toBe(true);
    expect(transaction.instructions.indexOf(create!)).toBeLessThan(
      transaction.instructions.indexOf(swap!),
    );
  });

  it('does not require the wallet to be the config owner, and reports the fee claimer', async () => {
    const { params, wallet } = await userSetup();
    const { summary } = await buildUserCoinLaunchTx(params);
    expect(wallet.equals(OWNER)).toBe(false);
    expect(summary.feeClaimer.equals(OWNER)).toBe(true);
  });

  it('uses a recent blockhash, the compute unit limit first, no nonce advance', async () => {
    const { params } = await userSetup({ computeUnitPriceMicroLamports: 500 });
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    expect(transaction.recentBlockhash).toBe(BLOCKHASH);
    expect(transaction.lastValidBlockHeight).toBe(1_000);
    expect(summary.recentBlockhash).toBe(BLOCKHASH);
    expect(summary.lastValidBlockHeight).toBe(1_000);
    const [limit, price] = transaction.instructions;
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit!.data.readUInt32LE(1)).toBe(LAUNCH_COIN_COMPUTE_UNITS);
    expect(price!.data.readBigUInt64LE(1)).toBe(500n);
    expect(
      transaction.instructions.some(
        (ix) =>
          ix.programId.equals(SystemProgram.programId) &&
          SystemInstruction.decodeInstructionType(ix) === 'AdvanceNonceAccount',
      ),
    ).toBe(false);
  });

  it('never puts a referral on the first buy, whatever env says', async () => {
    const referral = Keypair.generate().publicKey;
    const { params } = await userSetup();
    const { transaction } = await buildUserCoinLaunchTx({
      ...params,
      env: { ...params.env, FORGE_METEORA_REFERRAL_ACCOUNT: referral.toBase58() },
    });
    const swap = dbcInstructions(transaction.instructions)[1]!;
    expect(swap.keys[12]!.pubkey.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(transaction.compileMessage().accountKeys.some((k) => k.equals(referral))).toBe(false);
  });

  it('survives the mint signing first, base64 and the wallet signing last', async () => {
    const user = Keypair.generate();
    const { params, mint } = await userSetup({ wallet: user.publicKey });
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    transaction.partialSign(mint);
    const base64 = serializeTransactionBase64(transaction);
    const received = deserializeTransactionBase64(base64);
    expect(missingSigners(received).map(String)).toEqual([user.publicKey.toBase58()]);
    received.partialSign(user);
    expect(received.verifySignatures(true)).toBe(true);
    expect(received.serialize().length).toBe(summary.txBytes);
  });
});

describe('buildUserCoinLaunchTx — first buy and costs', () => {
  it('quotes the same curve as the devnet launch (0.01 SOL at the minimum fee)', async () => {
    const { params } = await userSetup();
    const { summary } = await buildUserCoinLaunchTx(params);
    expect(summary.expectedTokensOut).toBe(3_158_618_642_371n);
    expect(summary.minimumTokensOut).toBe(
      (summary.expectedTokensOut * BigInt(10_000 - DEFAULT_FIRST_BUY_SLIPPAGE_BPS)) / 10_000n,
    );
    expect(summary.costs.firstBuyFeeLamports).toBe(100_000n);
    expect(summary.slippageBps).toBe(DEFAULT_FIRST_BUY_SLIPPAGE_BPS);
  });

  it('charges every lamport to the wallet, rent read from the cluster', async () => {
    const { params, connection } = await userSetup();
    const { costs } = (await buildUserCoinLaunchTx(params)).summary;
    const accountsRent = BigInt(
      rent(decoderProgramSize()) +
        rent(MINT_SIZE) +
        rent(METADATA_ACCOUNT_SIZE) +
        2 * rent(ACCOUNT_SIZE),
    );
    expect(connection.calls).toContain('getMinimumBalanceForRentExemption');
    expect(costs.poolAccountsRentLamports).toBe(accountsRent);
    expect(costs.poolCreationFeeLamports).toBe(1_000_000n);
    expect(costs.metaplexFeeLamports).toBe(METAPLEX_CREATE_METADATA_FEE_LAMPORTS);
    expect(costs.ownerTokenAccountRentLamports).toBe(BigInt(rent(ACCOUNT_SIZE)));
    expect(costs.ownerTemporaryLamports).toBe(BigInt(rent(ACCOUNT_SIZE)));
    expect(costs.networkFeeLamports).toBe(10_000n);
    expect(costs.networkFeeSource).toBe('cluster');
    expect(costs.ownerTotalLamports).toBe(
      solToLamports(0.01) +
        10_000n +
        BigInt(rent(ACCOUNT_SIZE)) +
        accountsRent +
        METAPLEX_CREATE_METADATA_FEE_LAMPORTS +
        1_000_000n +
        USER_PLATFORM_FEE,
    );
    expect(costs.platformFeeLamports).toBe(USER_PLATFORM_FEE);
    expect(costs.ownerRequiredBalanceLamports).toBe(
      costs.ownerTotalLamports + costs.ownerTemporaryLamports,
    );
    expect(costs.creatorTotalLamports).toBe(0n);
  });

  it('estimates the network fee from the two signatures when the cluster does not answer', async () => {
    const { params } = await userSetup(
      { computeUnitPriceMicroLamports: 10_000 },
      { feeForMessage: new Error('rpc down') },
    );
    const { costs } = (await buildUserCoinLaunchTx(params)).summary;
    expect(costs.networkFeeSource).toBe('estimate');
    expect(costs.networkFeeLamports).toBe(10_000n + 3_000n);
  });

  it('builds a pool creation alone for 0 lamports', async () => {
    const { params } = await userSetup({ firstBuyLamports: 0n });
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    expect(dbcInstructions(transaction.instructions)).toHaveLength(1);
    expect(
      transaction.instructions.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)),
    ).toBe(false);
    expect(summary.costs.firstBuyLamports).toBe(0n);
    expect(summary.costs.ownerTemporaryLamports).toBe(0n);
    expect(summary.expectedTokensOut).toBe(0n);
  });

  it('creates the WSOL account idempotently even when it exists at build time', async () => {
    const { params, connection, wallet } = await userSetup();
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
    connection.accounts.set(
      wsol.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(wallet)),
    );
    const { transaction } = await buildUserCoinLaunchTx(params);
    const creations = transaction.instructions.filter(
      (ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]!.pubkey.equals(wsol),
    );
    expect(creations).toHaveLength(1);
    expect([...creations[0]!.data]).toEqual([1]);
  });

  it('measures its size: no creator key, no nonce advance, one signature fewer', async () => {
    const { params } = await userSetup({
      name: 'Moon',
      symbol: 'MOON',
      metadataUri: 'https://example.com/moon.json',
    });
    const { summary } = await buildUserCoinLaunchTx(params);
    // The launchpad coin launch of the same metadata is 1,120 bytes (nonce held by the creator).
    expect(summary.txBytes).toBe(USER_COIN_STANDARD_TX_BYTES);
    expect(summary.txBytes).toBeLessThan(1120);
    const without = await buildUserCoinLaunchTx({ ...params, chargePlatformFee: false });
    expect(without.summary.txBytes).toBe(USER_COIN_WITHOUT_PLATFORM_FEE_TX_BYTES);
  });

  it('fits the largest metadata (32-byte name, 10-character symbol, 200-byte URI)', async () => {
    const uri = `https://example.com/${'a'.repeat(200 - 25)}.json`;
    expect(Buffer.byteLength(uri)).toBe(200);
    const { params } = await userSetup({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri,
    });
    const { summary } = await buildUserCoinLaunchTx(params);
    expect(summary.txBytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });
});

describe('launch builders — priority fee', () => {
  const isBudget = (ix: TransactionInstruction) =>
    ix.programId.equals(ComputeBudgetProgram.programId);
  const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;
  /** A 32-byte name and a 10-character symbol: `total` bytes of metadata in all. */
  const metadata = (total: number) => ({
    name: 'N'.repeat(32),
    symbol: 'S'.repeat(10),
    metadataUri: uri(total - 42),
  });

  it('prices the launchpad coin launch right after the nonce advance', async () => {
    const { params, connection } = await setup(
      { priority: {} },
      { feeForMessage: new Error('unavailable') },
    );
    connection.priorityFees = [0, 100_000, 100_000, 100_000];
    const { transaction, summary } = await buildLaunchCoinTx(params);
    const [advance, limit, price] = transaction.instructions;
    expect(SystemInstruction.decodeInstructionType(advance!)).toBe('AdvanceNonceAccount');
    expect(limit!.data.readUInt32LE(1)).toBe(LAUNCH_COIN_COMPUTE_UNITS);
    expect(price!.data.readBigUInt64LE(1)).toBe(100_000n);
    expect(transaction.instructions.filter(isBudget)).toHaveLength(2);
    expect(summary.priorityFeePlacement).toBe('limit_and_price');
    expect(summary.priorityFee).toEqual({
      computeUnitLimit: LAUNCH_COIN_COMPUTE_UNITS,
      microLamports: 100_000,
      priorityFeeLamports: 30_000n,
      maxLamports: 500_000n,
      source: 'recent_fees',
    });
    expect(summary.computeUnitPriceMicroLamports).toBe(100_000);
    // 12 bytes for the price instruction (1,120 without it).
    expect(summary.txBytes).toBe(1132);
    // Without the cluster's figure, the estimate counts the priority fee.
    expect(summary.costs.networkFeeSource).toBe('estimate');
    expect(summary.costs.networkFeeLamports).toBe(3n * 5000n + 30_000n);
    // The fees were read for the accounts the launch writes (the pool among them).
    expect(connection.priorityFeeAccounts).toContain(summary.pool.toBase58());
  });

  it('passes the browser check of the launch', async () => {
    const launch = await signedLaunch({ priority: { maxLamports: 1_000_000n } });
    expect(() => verifyLaunchCoinTransaction(launch.transaction, launch.expected)).not.toThrow();
    expect(launch.summary.priorityFee.source).toBe('no_recent_fees');
    expect(launch.summary.computeUnitPriceMicroLamports).toBe(10_000);
  });

  it('keeps both instructions while they fit (136 bytes of metadata: 1,232 bytes)', async () => {
    const { params, connection } = await setup({ ...metadata(136), priority: {} });
    connection.priorityFees = [50_000];
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.priorityFeePlacement).toBe('limit_and_price');
    expect(summary.txBytes).toBe(MAX_TRANSACTION_BYTES);
    expect(transaction.instructions.filter(isBudget)).toHaveLength(2);
  });

  it('puts the price alone when both do not fit, bounded for 1.4M CU', async () => {
    const { params, connection } = await setup({ ...metadata(144), priority: {} });
    connection.priorityFees = [2_000_000];
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.priorityFeePlacement).toBe('price_only');
    expect(summary.txBytes).toBe(MAX_TRANSACTION_BYTES);
    const budget = transaction.instructions.filter(isBudget);
    expect(budget).toHaveLength(1);
    expect(budget[0]!.data[0]).toBe(3);
    expect(transaction.instructions.indexOf(budget[0]!)).toBe(1);
    // 0.0005 SOL / 1.4M CU: the fee stays within the cap whatever limit the runtime applies.
    expect(summary.priorityFee.computeUnitLimit).toBe(MAX_TRANSACTION_COMPUTE_UNITS);
    expect(summary.priorityFee.microLamports).toBe(357_142);
    expect(summary.priorityFee.priorityFeeLamports).toBeLessThanOrEqual(500_000n);
    const launch = await signedLaunch({ ...metadata(144), priority: {} });
    expect(launch.summary.priorityFeePlacement).toBe('price_only');
    expect(() => verifyLaunchCoinTransaction(launch.transaction, launch.expected)).not.toThrow();
  });

  it('keeps the unpriced shape at the full metadata budget, and says so', async () => {
    const { params, connection } = await setup({ ...metadata(148), priority: {} });
    connection.priorityFees = [2_000_000];
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.priorityFeePlacement).toBe('omitted_for_size');
    expect(summary.txBytes).toBe(MAX_TRANSACTION_BYTES);
    const budget = transaction.instructions.filter(isBudget);
    expect(budget).toHaveLength(1);
    expect(budget[0]!.data[0]).toBe(2);
    expect(summary.priorityFee.microLamports).toBe(0);
    expect(summary.computeUnitPriceMicroLamports).toBe(0);
  });

  it('prices at the floor when the fees cannot be read', async () => {
    const { params, connection } = await setup({ priority: {} });
    connection.priorityFees = new Error('fetch failed');
    const { summary } = await buildLaunchCoinTx(params);
    expect(summary.priorityFee).toMatchObject({ microLamports: 10_000, source: 'rpc_unavailable' });
  });

  it('refuses a fixed price with a setting, and a bad setting', async () => {
    const both = await setup({ priority: {}, computeUnitPriceMicroLamports: 1 });
    await expectLaunchError(buildLaunchCoinTx(both.params), 'INVALID_INPUT');
    const bad = await setup({ priority: { maxLamports: 10n ** 9n } });
    await expectLaunchError(buildLaunchCoinTx(bad.params), 'INVALID_INPUT');
    const user = await userSetup({ priority: { percentile: -1 } });
    await expectLaunchError(buildUserCoinLaunchTx(user.params), 'INVALID_INPUT');
  });

  it('prices a user coin launch: limit then price first, 12 bytes more', async () => {
    const { params, connection } = await userSetup({
      name: 'Moon',
      symbol: 'MOON',
      metadataUri: 'https://example.com/moon.json',
      priority: {},
    });
    connection.priorityFees = [70_000];
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    const [limit, price] = transaction.instructions;
    expect(limit!.data.readUInt32LE(1)).toBe(LAUNCH_COIN_COMPUTE_UNITS);
    expect(price!.data.readBigUInt64LE(1)).toBe(70_000n);
    expect(summary.priorityFeePlacement).toBe('limit_and_price');
    expect(summary.priorityFee.priorityFeeLamports).toBe(21_000n);
    expect(summary.txBytes).toBe(USER_COIN_STANDARD_TX_BYTES + 12);
  });

  it('fits a priced user coin launch with the largest metadata', async () => {
    const { params, connection } = await userSetup({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri(200),
      priority: {},
    });
    connection.priorityFees = [70_000];
    const { summary } = await buildUserCoinLaunchTx(params);
    expect(summary.priorityFeePlacement).toBe('limit_and_price');
    expect(summary.txBytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });

  it('reads nothing and keeps the legacy shape without a setting', async () => {
    const { params, connection } = await setup();
    const { summary } = await buildLaunchCoinTx(params);
    expect(connection.calls).not.toContain('getRecentPrioritizationFees');
    expect(summary.priorityFee).toMatchObject({ microLamports: 0, source: 'fixed' });
    expect(summary.priorityFeePlacement).toBe('limit_and_price');
  });
});

describe('buildUserCoinLaunchTx — FORGE platform fee on the first buy', () => {
  const systemTransfers = (instructions: TransactionInstruction[]) =>
    instructions
      .filter(
        (ix) =>
          ix.programId.equals(SystemProgram.programId) &&
          SystemInstruction.decodeInstructionType(ix) === 'Transfer',
      )
      .map((ix) => SystemInstruction.decodeTransfer(ix));

  it('transfers 0.3% of the first buy to FORGE_PLATFORM_FEE_WALLET, as the last instruction', async () => {
    const { params, wallet, platformWallet } = await userSetup();
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    const last = transaction.instructions[transaction.instructions.length - 1]!;
    expect(last.programId.equals(SystemProgram.programId)).toBe(true);
    const fee = SystemInstruction.decodeTransfer(last);
    expect(fee.fromPubkey.equals(wallet)).toBe(true);
    expect(fee.toPubkey.equals(platformWallet)).toBe(true);
    expect(fee.lamports).toBe(USER_PLATFORM_FEE);
    expect(USER_PLATFORM_FEE).toBe(platformFeeLamports(solToLamports(0.01)));
    // Exactly one transfer to the fee wallet; the other one wraps the first buy.
    const transfers = systemTransfers(transaction.instructions);
    expect(transfers.filter((t) => t.toPubkey.equals(platformWallet))).toHaveLength(1);
    expect(transfers).toHaveLength(2);
    expect(summary.platformFeeLamports).toBe(USER_PLATFORM_FEE);
    expect(summary.platformFeeWallet!.equals(platformWallet)).toBe(true);
    expect(summary.costs.platformFeeLamports).toBe(USER_PLATFORM_FEE);
  });

  it('rounds the fee up to the lamport', async () => {
    const { params } = await userSetup({ firstBuyLamports: 1_000_001n });
    const { summary } = await buildUserCoinLaunchTx(params);
    expect(summary.platformFeeLamports).toBe(3_001n);
  });

  it('adds nothing without a first buy, and needs no fee wallet then', async () => {
    const { params } = await userSetup({ firstBuyLamports: 0n, env: {} });
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    expect(systemTransfers(transaction.instructions)).toHaveLength(0);
    expect(summary.platformFeeLamports).toBe(0n);
    expect(summary.platformFeeWallet).toBeNull();
    expect(summary.costs.platformFeeLamports).toBe(0n);
  });

  it('can be turned off explicitly', async () => {
    const { params, platformWallet } = await userSetup({ chargePlatformFee: false });
    const { transaction, summary } = await buildUserCoinLaunchTx(params);
    expect(
      systemTransfers(transaction.instructions).some((t) => t.toPubkey.equals(platformWallet)),
    ).toBe(false);
    expect(summary.platformFeeLamports).toBe(0n);
  });

  it('refuses a missing fee wallet address, before any network call', async () => {
    const { params, connection } = await userSetup({ env: {} });
    await expect(buildUserCoinLaunchTx(params)).rejects.toBeInstanceOf(ForgeAddressError);
    expect(connection.calls).toEqual([]);
  });

  it('refuses a fee wallet that does not exist or is not rent-exempt', async () => {
    const { params, connection, platformWallet } = await userSetup();
    connection.accounts.delete(platformWallet.toBase58());
    await expectLaunchError(buildUserCoinLaunchTx(params), 'PLATFORM_FEE_WALLET_NOT_READY');
    connection.accounts.set(
      platformWallet.toBase58(),
      account(SystemProgram.programId, Buffer.alloc(0), rent(0) - 1),
    );
    await expectLaunchError(buildUserCoinLaunchTx(params), 'PLATFORM_FEE_WALLET_NOT_READY');
  });
});

describe('buildUserCoinLaunchTx — refusals', () => {
  it.each<[string, Partial<PoolConfig>]>([
    ['first swap at minimum fee disabled', { enableFirstSwapWithMinFee: 0 }],
    ['quote is not SOL', { quoteMint: Keypair.generate().publicKey }],
    ['quote token is Token-2022', { quoteTokenFlag: 1 }],
    ['base token is Token-2022', { tokenType: 1 }],
  ])('refuses a config where %s', async (_label, change) => {
    const { params } = await userSetup({}, { config: change });
    await expectLaunchError(buildUserCoinLaunchTx(params), 'CONFIG_MISMATCH');
  });

  it('accepts a launchpad config core builds, for any owner and client values', () => {
    const owner = Keypair.generate().publicKey;
    // Fixture as a launchpad config: 25% creator share, 75 / 25 locked, 0.001 SOL creation fee.
    expect(() =>
      assertUserCoinConfig({ ...fixtureConfig, feeClaimer: owner, leftoverReceiver: owner }),
    ).not.toThrow();
    // A 10% creator share with the liquidity split that follows it, and no creation fee.
    expect(() =>
      assertUserCoinConfig({
        ...fixtureConfig,
        creatorTradingFeePercentage: 10,
        creatorPermanentLockedLiquidityPercentage: 10,
        partnerPermanentLockedLiquidityPercentage: 90,
        poolCreationFee: new BN(0),
      }),
    ).not.toThrow();
  });

  it.each<[string, (config: PoolConfig) => Partial<PoolConfig>]>([
    ['first swap at minimum fee disabled', () => ({ enableFirstSwapWithMinFee: 0 })],
    [
      'a leftover receiver other than the fee claimer',
      () => ({ leftoverReceiver: Keypair.generate().publicKey }),
    ],
    ['mutable metadata', () => ({ tokenUpdateAuthority: 0 })],
    [
      'a creator share above the client bound',
      () => ({
        creatorTradingFeePercentage: 60,
        creatorPermanentLockedLiquidityPercentage: 60,
        partnerPermanentLockedLiquidityPercentage: 40,
      }),
    ],
    [
      'a liquidity split that does not follow the creator share',
      () => ({ creatorTradingFeePercentage: 10 }),
    ],
    [
      'partner liquidity left unlocked',
      () => ({ partnerLiquidityPercentage: 75, partnerPermanentLockedLiquidityPercentage: 0 }),
    ],
    ['a creation fee above the client bound', () => ({ poolCreationFee: new BN(2_000_000_000) })],
    ['a migration fee', () => ({ migrationFeePercentage: 5 })],
    [
      'a creator migration fee',
      () => ({ migrationFeePercentage: 5, creatorMigrationFeePercentage: 50 }),
    ],
    [
      'locked vesting',
      (c) => ({ lockedVestingConfig: { ...c.lockedVestingConfig, amountPerPeriod: new BN(1) } }),
    ],
    [
      'another token supply',
      () => ({ preMigrationTokenSupply: new BN(1), postMigrationTokenSupply: new BN(1) }),
    ],
    ['slot activation', () => ({ activationType: 0 })],
    ['another migrated pool fee option', () => ({ migrationFeeOption: 1 })],
    ['another start price', () => ({ sqrtStartPrice: new BN(1) })],
    [
      'a dynamic fee',
      (c) => ({
        poolFees: { ...c.poolFees, dynamicFee: { ...c.poolFees.dynamicFee, initialized: 1 } },
      }),
    ],
  ])('refuses a launchpad config with %s', (_label, change) => {
    expect(() => assertUserCoinConfig({ ...fixtureConfig, ...change(fixtureConfig) })).toThrow(
      LaunchCoinError,
    );
  });

  it('refuses another fee schedule: cliff, periods, period, reduction, ending fee', () => {
    const base = fixtureConfig.poolFees.baseFee;
    const changes: Partial<typeof base>[] = [
      { cliffFeeNumerator: base.cliffFeeNumerator.subn(100_000) },
      { firstFactor: 1, secondFactor: new BN(300), thirdFactor: new BN(980_000_000) },
      { secondFactor: new BN(30) },
      { thirdFactor: base.thirdFactor.subn(1) },
      // Ending fee 300 bps: outside the client bounds.
      { thirdFactor: new BN(96_000_000) },
      { baseFeeMode: 1 },
    ];
    for (const change of changes) {
      const config = {
        ...fixtureConfig,
        poolFees: { ...fixtureConfig.poolFees, baseFee: { ...base, ...change } },
      };
      expect(() => assertUserCoinConfig(config)).toThrow(LaunchCoinError);
    }
  });

  it('pins the owner, the creation fee or the whole spec when given', () => {
    const spec = coinSpec('Moon', 'MOON');
    expect(() => assertUserCoinConfig(fixtureConfig, { owner: OWNER })).not.toThrow();
    expect(() =>
      assertUserCoinConfig(fixtureConfig, { owner: Keypair.generate().publicKey }),
    ).toThrow(/feeClaimer is/);
    expect(() =>
      assertUserCoinConfig(fixtureConfig, { owner: OWNER, poolCreationFeeLamports: 1_000_000n }),
    ).not.toThrow();
    expect(() =>
      assertUserCoinConfig(fixtureConfig, { owner: OWNER, poolCreationFeeLamports: 0n }),
    ).toThrow(/poolCreationFee is 1000000, expected 0/);
    expect(() => assertUserCoinConfig(fixtureConfig, { spec })).not.toThrow();
    expect(() =>
      assertUserCoinConfig(fixtureConfig, { spec: { ...spec, tradingFeeBps: 150 } }),
    ).toThrow(/baseFee/);
    expect(() =>
      assertUserCoinConfig(fixtureConfig, { spec: { ...spec, coinCreatorSharePct: 30 } }),
    ).toThrow(/creatorTradingFeePercentage is 25, expected 30/);
  });

  it('builds with expectedConfig and refuses a config that does not match it', async () => {
    const { params } = await userSetup({ expectedConfig: { owner: OWNER } });
    await expect(buildUserCoinLaunchTx(params)).resolves.toBeDefined();
    const other = await userSetup({ expectedConfig: { owner: Keypair.generate().publicKey } });
    await expectLaunchError(buildUserCoinLaunchTx(other.params), 'CONFIG_MISMATCH');
  });

  it('refuses a missing config, or one not owned by the DBC program', async () => {
    const { params, connection } = await userSetup();
    const info = connection.accounts.get(CONFIG.toBase58())!;
    connection.accounts.set(CONFIG.toBase58(), { ...info, owner: SystemProgram.programId });
    await expectLaunchError(buildUserCoinLaunchTx(params), 'CONFIG_MISMATCH');
    connection.accounts.delete(CONFIG.toBase58());
    await expectLaunchError(buildUserCoinLaunchTx(params), 'CONFIG_NOT_FOUND');
  });

  it('refuses when the pool or the mint already exist', async () => {
    const { params, connection, mint } = await userSetup();
    const pool = deriveDbcPoolAddress(SOL_QUOTE_MINT, mint.publicKey, CONFIG);
    connection.accounts.set(
      pool.toBase58(),
      account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, Buffer.alloc(8)),
    );
    await expectLaunchError(buildUserCoinLaunchTx(params), 'POOL_EXISTS');
    connection.accounts.delete(pool.toBase58());
    connection.accounts.set(
      mint.publicKey.toBase58(),
      account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)),
    );
    await expectLaunchError(buildUserCoinLaunchTx(params), 'MINT_EXISTS');
  });

  it('refuses bad inputs before any network call', async () => {
    const { params, connection, wallet } = await userSetup();
    const cases: Partial<BuildUserCoinLaunchTxParams>[] = [
      { mint: wallet },
      { config: wallet },
      { wallet: 'not-a-key' as unknown as PublicKey },
      { firstBuyLamports: MAX_FIRST_BUY_LAMPORTS + 1n },
      { firstBuyLamports: -1n },
      { slippageBps: 1001 },
      { symbol: 'lisa' },
      { metadataUri: 'http://example.com/lisa.json' },
      { computeUnitLimit: 0 },
    ];
    for (const change of cases) {
      await expectLaunchError(buildUserCoinLaunchTx({ ...params, ...change }), 'INVALID_INPUT');
    }
    expect(connection.calls).toEqual([]);
  });

  it('refuses a first buy the curve cannot take', async () => {
    // A curve that ends one step above its start price sells (almost) nothing.
    const { params } = await userSetup(
      {},
      { config: { migrationSqrtPrice: fixtureConfig.sqrtStartPrice.addn(1) } },
    );
    await expectLaunchError(buildUserCoinLaunchTx(params), 'FIRST_BUY_EXCEEDS_CURVE');
  });
});

function decoderProgramSize(): number {
  return DynamicBondingCurveClient.create(
    new Connection('http://127.0.0.1:8899'),
    'confirmed',
  ).pool.getProgram().account.virtualPool.size;
}
