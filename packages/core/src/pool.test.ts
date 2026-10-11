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
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { OwnerTransactionSummary } from '@forge/shared';
import { ForgeAddressError } from './addresses.js';
import { MIGRATION_THRESHOLD_LAMPORTS, SOL_QUOTE_MINT, solToLamports } from './constants.js';
import {
  DEFAULT_FIRST_BUY_SLIPPAGE_BPS,
  LAUNCH_COIN_COMPUTE_UNITS,
  LaunchCoinError,
  MAX_FIRST_BUY_LAMPORTS,
  METADATA_ACCOUNT_SIZE,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
  REFERRAL_TX_BYTES,
  assertFirstBuyLamports,
  assertLaunchCoinConfig,
  assertLaunchMetadata,
  buildLaunchCoinTx,
  defaultLaunchReferral,
  toOwnerTransactionSummary,
  type BuildLaunchCoinTxParams,
  type LaunchCoinErrorCode,
} from './pool.js';
import {
  DurableNonceError,
  MAX_TRANSACTION_BYTES,
  RentExemptionError,
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
 * Re-encodes the fixture with some fields changed. Anchor's `encode` uses a 1000-byte buffer and
 * a pool config is 1048 bytes, so the account layout is used directly.
 */
async function encodeConfig(changes: Partial<PoolConfig> = {}): Promise<Buffer> {
  const layouts = (
    decoder as unknown as {
      accountLayouts: Map<string, { layout: { encode(value: unknown, buffer: Buffer): number } }>;
    }
  ).accountLayouts;
  const buffer = Buffer.alloc(2048);
  const length = layouts.get('poolConfig')!.layout.encode({ ...fixtureConfig, ...changes }, buffer);
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

  it('refuses the creator as rent payer when the config charges a pool creation fee', async () => {
    // The fixture charges 0.001 SOL: the FORGE creator wallet would pay the client's own fee.
    const { params } = await setup({ rentPayer: 'creator' });
    const error = await expectLaunchError(buildLaunchCoinTx(params), 'RENT_PAYER_REFUSED');
    expect(error.message).toContain('1000000 lamports');
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
    expect(() => assertLaunchCoinConfig(fixtureConfig, OWNER)).not.toThrow();
    expect(BigInt(fixtureConfig.migrationQuoteThreshold.toString())).toBe(
      MIGRATION_THRESHOLD_LAMPORTS,
    );
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

describe('buildLaunchCoinTx — referral', () => {
  it('accepts a rent-exempt WSOL token account', async () => {
    const referral = Keypair.generate().publicKey;
    const { params, connection } = await setup({ referralTokenAccount: referral });
    connection.accounts.set(
      referral.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(Keypair.generate().publicKey)),
    );
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.referralTokenAccount!.equals(referral)).toBe(true);
    const swap = transaction.instructions.filter((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    )[1]!;
    expect(swap.keys.some((k) => k.pubkey.equals(referral))).toBe(true);
  });

  it('refuses a missing, non-WSOL or non rent-exempt referral', async () => {
    const referral = Keypair.generate().publicKey;
    const { params, connection } = await setup({ referralTokenAccount: referral });
    await expectLaunchError(buildLaunchCoinTx(params), 'REFERRAL_INVALID');

    connection.accounts.set(referral.toBase58(), account(SystemProgram.programId, Buffer.alloc(0)));
    await expectLaunchError(buildLaunchCoinTx(params), 'REFERRAL_INVALID');

    connection.accounts.set(
      referral.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(Keypair.generate().publicKey), 1000),
    );
    const error = await buildLaunchCoinTx(params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RentExemptionError);
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

describe('buildLaunchCoinTx — default FORGE referral', () => {
  const R2_URI = `https://pub-${'0'.repeat(32)}.r2.dev/metadata/${'u'.repeat(36)}.json`;

  async function withForgeReferral(overrides: Partial<BuildLaunchCoinTxParams> = {}) {
    const referral = Keypair.generate().publicKey;
    const s = await setup({
      env: { FORGE_METEORA_REFERRAL_ACCOUNT: referral.toBase58() },
      ...overrides,
    });
    s.connection.accounts.set(
      referral.toBase58(),
      account(TOKEN_PROGRAM_ID, wsolTokenAccountData(Keypair.generate().publicKey)),
    );
    return { ...s, referral };
  }

  const swapOf = (instructions: TransactionInstruction[]) =>
    instructions.filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))[1]!;

  it('puts the FORGE referral on the first buy when it is configured', async () => {
    const { params, referral } = await withForgeReferral();
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.referralSource).toBe('forge');
    expect(summary.referralOmittedForSize).toBe(false);
    expect(summary.referralTokenAccount!.equals(referral)).toBe(true);
    expect(swapOf(transaction.instructions).keys.some((k) => k.pubkey.equals(referral))).toBe(true);
    // Standard launch (1,120 bytes) + one account key.
    expect(summary.txBytes).toBe(1120 + REFERRAL_TX_BYTES);
  });

  it('keeps it on the devnet launch shape (1,198 bytes)', async () => {
    const { params } = await withForgeReferral({
      name: 'Forge Core Devnet Coin',
      symbol: 'FCORE',
      metadataUri: 'https://example.com/forge/core-config-pool/metadata.json',
    });
    const { summary } = await buildLaunchCoinTx(params);
    expect(summary.referralSource).toBe('forge');
    expect(summary.txBytes).toBe(1166 + REFERRAL_TX_BYTES);
  });

  it('leaves it out when the transaction would be too large, and says so', async () => {
    const { params, referral } = await withForgeReferral({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: R2_URI,
    });
    const { summary, transaction } = await buildLaunchCoinTx(params);
    expect(summary.referralOmittedForSize).toBe(true);
    expect(summary.referralSource).toBe('none');
    expect(summary.referralTokenAccount).toBeNull();
    expect(summary.txBytes).toBe(1228);
    expect(transaction.compileMessage().accountKeys.some((k) => k.equals(referral))).toBe(false);
  });

  it('fits up to 116 bytes of metadata (32-byte name, 10-character symbol, 74-byte URI)', async () => {
    const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;
    expect(uri(74)).toHaveLength(74);
    const kept = await withForgeReferral({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri(74),
    });
    const fits = await buildLaunchCoinTx(kept.params);
    expect(fits.summary.referralSource).toBe('forge');
    expect(fits.summary.txBytes).toBe(MAX_TRANSACTION_BYTES);

    const dropped = await withForgeReferral({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri(75),
    });
    const tooLarge = await buildLaunchCoinTx(dropped.params);
    expect(tooLarge.summary.referralOmittedForSize).toBe(true);
    expect(tooLarge.summary.txBytes).toBe(MAX_TRANSACTION_BYTES + 1 - REFERRAL_TX_BYTES);
  });

  it('never drops an explicit referral: TX_TOO_LARGE instead', async () => {
    const { params, referral } = await withForgeReferral({
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: R2_URI,
    });
    const error = await expectLaunchError(
      buildLaunchCoinTx({ ...params, referralTokenAccount: referral }),
      'TX_TOO_LARGE',
    );
    expect(error.message).toContain(`${1228 + REFERRAL_TX_BYTES} bytes`);
  });

  it('is disabled by an explicit null and unused without a first buy', async () => {
    const { params } = await withForgeReferral();
    const none = await buildLaunchCoinTx({ ...params, referralTokenAccount: null });
    expect(none.summary.referralSource).toBe('none');
    expect(none.summary.referralTokenAccount).toBeNull();
    expect(none.summary.txBytes).toBe(1120);

    const noBuy = await buildLaunchCoinTx({ ...params, firstBuyLamports: 0n });
    expect(noBuy.summary.referralSource).toBe('none');
  });

  it('is not used when FORGE_METEORA_REFERRAL_ACCOUNT is not set', async () => {
    const { params } = await setup({ env: {} });
    const { summary } = await buildLaunchCoinTx(params);
    expect(summary.referralSource).toBe('none');
    expect(defaultLaunchReferral({})).toBeNull();
    expect(defaultLaunchReferral({ FORGE_METEORA_REFERRAL_ACCOUNT: '' })).toBeNull();
  });

  it('fails loudly on an invalid or unusable FORGE referral', async () => {
    const bad = await setup({ env: { FORGE_METEORA_REFERRAL_ACCOUNT: 'not-a-key' } });
    await expect(buildLaunchCoinTx(bad.params)).rejects.toBeInstanceOf(ForgeAddressError);

    const missing = await setup({
      env: { FORGE_METEORA_REFERRAL_ACCOUNT: Keypair.generate().publicKey.toBase58() },
    });
    await expectLaunchError(buildLaunchCoinTx(missing.params), 'REFERRAL_INVALID');
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
    expect(costs.poolCreationFeeLamports).toBe(1_000_000n);
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
        METAPLEX_CREATE_METADATA_FEE_LAMPORTS +
        1_000_000n,
    );
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
    });
  });
});

function decoderProgramSize(): number {
  return DynamicBondingCurveClient.create(
    new Connection('http://127.0.0.1:8899'),
    'confirmed',
  ).pool.getProgram().account.virtualPool.size;
}
