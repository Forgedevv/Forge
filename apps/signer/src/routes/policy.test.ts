/*
 * The route policies against what the REAL @forge/core builds (offline: an in-memory connection
 * serves the accounts core reads). A policy that refused core's own transactions would block
 * every launch; one that accepted a tampered one would let a FORGE key sign it.
 */
import { readFileSync } from 'node:fs';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { MINT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type Connection,
  type Transaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { PriorityFeeSetting } from '@forge/core';
import { DEFAULT_SIGNER_PRIORITY_FEE } from '../jobs/priority.js';
import { isJobError } from '../jobs/shared.js';
import { createForgeRouteCore } from './onchain.js';
import {
  DBC_DISCRIMINATORS,
  anchorDiscriminator,
  assertCreateConfigTx,
  assertCreateNonceTx,
  assertLaunchCoinTx,
} from './policy.js';
import { testSpec } from './testing.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./__fixtures__/launchpad-coin-config.json', import.meta.url), 'utf8'),
) as { address: string; owner: string; data: string };
/**
 * The captured devnet config still charged a 0.001 SOL creation fee, which the current builder no
 * longer sets and core now refuses: the fee (`poolCreationFee`, u64 at byte 368) is set to 0.
 */
const POOL_CREATION_FEE_OFFSET = 368;
{
  const data = Buffer.from(FIXTURE.data, 'base64');
  if (data.readBigUInt64LE(POOL_CREATION_FEE_OFFSET) !== 1_000_000n) {
    throw new Error('launchpad coin config fixture: unexpected poolCreationFee layout');
  }
  data.writeBigUInt64LE(0n, POOL_CREATION_FEE_OFFSET);
  FIXTURE.data = data.toString('base64');
}
const CONFIG = new PublicKey(FIXTURE.address);
const OWNER = new PublicKey(FIXTURE.owner);
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const NONCE_VALUE = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const rent = (size: number) => (128 + size) * 6960;

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: rent(data.length), executable: false, rentEpoch: 0 };
}

function nonceAccountData(authority: PublicKey, nonce: string): Buffer {
  const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(1, 4);
  authority.toBuffer().copy(data, 8);
  new PublicKey(nonce).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(5000n, 72);
  return data;
}

/** In-memory Connection: only the methods core and the route core call. */
function mockConnection(accounts: Map<string, AccountInfo<Buffer>>): Connection {
  const get = (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  return {
    getAccountInfo: async (key: PublicKey) => get(key),
    getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 7 }, value: get(key) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(get),
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
      context: { slot: 7 },
      value: keys.map(get),
    }),
    getMinimumBalanceForRentExemption: async (size: number) => rent(size),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 15_000 }),
    getSignaturesForAddress: async () => [],
    getRecentPrioritizationFees: async () => [
      { slot: 1, prioritizationFee: 0 },
      { slot: 2, prioritizationFee: 100_000 },
    ],
  } as unknown as Connection;
}

function expectPolicy(fn: () => void, rule?: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(isJobError(error, 'TX_POLICY')).toBe(true);
  if (rule) expect((error as Error).message).toMatch(rule);
}

function launchSetup(options: { priority?: PriorityFeeSetting } = {}) {
  const creator = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const nonceAccount = Keypair.generate().publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(
    CONFIG.toBase58(),
    account(DYNAMIC_BONDING_CURVE_PROGRAM_ID, Buffer.from(FIXTURE.data, 'base64')),
  );
  accounts.set(NATIVE_MINT.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
  accounts.set(
    nonceAccount.toBase58(),
    account(SystemProgram.programId, nonceAccountData(creator, NONCE_VALUE)),
  );
  const core = createForgeRouteCore({
    connection: mockConnection(accounts),
    ...(options.priority ? { priority: options.priority } : {}),
  });
  const params = {
    config: CONFIG,
    creator,
    owner: OWNER,
    mint,
    name: 'Moon',
    symbol: 'MOON',
    metadataUri: 'https://meta.forge.test/coins/moonpad.json',
    firstBuyLamports: 10_000_000n,
    nonceAccount,
  };
  const expectation = (overrides: Partial<Parameters<typeof assertLaunchCoinTx>[1]> = {}) => ({
    dbcProgramId: core.dbcProgramId,
    owner: OWNER,
    creator,
    mint,
    config: CONFIG,
    pool: core.poolAddress(CONFIG, mint),
    nonceAccount,
    nonceValue: NONCE_VALUE,
    firstBuy: true,
    ...overrides,
  });
  return { core, params, expectation, creator, mint, nonceAccount };
}

describe('DBC discriminators', () => {
  it('match the pinned SDK IDL', () => {
    expect([...DBC_DISCRIMINATORS.createConfig]).toEqual([201, 207, 243, 114, 75, 111, 47, 189]);
    expect([...DBC_DISCRIMINATORS.initializePool]).toEqual([140, 85, 215, 176, 102, 54, 104, 79]);
    expect([...DBC_DISCRIMINATORS.swap.subarray(0, 4)]).toEqual([248, 198, 158, 145]);
    expect(anchorDiscriminator('swap')).toEqual(DBC_DISCRIMINATORS.swap);
  });
});

describe('config creation policy (real core)', () => {
  async function built(kind: 'launchpad' | 'launchpadCoin') {
    const core = createForgeRouteCore({
      connection: mockConnection(new Map()),
    });
    const payer = Keypair.generate().publicKey;
    const config = Keypair.generate().publicKey;
    const spec = testSpec(OWNER.toBase58());
    const tx = await core.buildCreateConfigTx({
      spec,
      kind,
      config,
      payer,
      computeUnitPriceMicroLamports: 0,
    });
    return { core, payer, config, tx: tx.transaction, spec };
  }

  it('accepts both configs built by core', async () => {
    for (const kind of ['launchpad', 'launchpadCoin'] as const) {
      const { core, payer, config, tx } = await built(kind);
      assertCreateConfigTx(tx, { dbcProgramId: core.dbcProgramId, payer, config, owner: OWNER });
    }
  });

  it('refuses another fee claimer, payer or config, and any extra instruction', async () => {
    const { core, payer, config, tx } = await built('launchpad');
    const base = { dbcProgramId: core.dbcProgramId, payer, config, owner: OWNER };
    expectPolicy(
      () => assertCreateConfigTx(tx, { ...base, owner: Keypair.generate().publicKey }),
      /fee claimer/,
    );
    expectPolicy(() => assertCreateConfigTx(tx, { ...base, config: Keypair.generate().publicKey }));
    expectPolicy(() => assertCreateConfigTx(tx, { ...base, payer: Keypair.generate().publicKey }));
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1n,
      }),
    );
    expectPolicy(() => assertCreateConfigTx(tx, base), /program not allowed/);
  });

  it('refuses a priority fee above the cap', async () => {
    const { core, payer, config, tx } = await built('launchpad');
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }));
    expectPolicy(
      () =>
        assertCreateConfigTx(tx, { dbcProgramId: core.dbcProgramId, payer, config, owner: OWNER }),
      /compute unit price/,
    );
  });

  it('hashes the exact parameters: another fee, another hash', () => {
    const core = createForgeRouteCore({
      connection: mockConnection(new Map()),
    });
    const spec = testSpec(OWNER.toBase58());
    const a = core.configParamsHash(spec, 'launchpad');
    expect(core.configParamsHash(spec, 'launchpad')).toBe(a);
    expect(core.configParamsHash({ ...spec, tradingFeeBps: 150 }, 'launchpad')).not.toBe(a);
    expect(core.configParamsHash(spec, 'launchpadCoin')).not.toBe(a);
  });
});

describe('nonce account creation policy (real core)', () => {
  it('accepts core’s transaction and refuses another authority or amount', async () => {
    const core = createForgeRouteCore({
      connection: mockConnection(new Map()),
    });
    const payer = Keypair.generate().publicKey;
    const nonceAccount = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const built = await core.buildCreateNonceAccountTx({
      payer,
      nonceAccount,
      authority,
      computeUnitPriceMicroLamports: 0,
    });
    const expected = { payer, nonceAccount, authority, rentLamports: built.rentLamports };
    assertCreateNonceTx(built.transaction, expected);
    expect(built.rentLamports).toBe(BigInt(rent(NONCE_ACCOUNT_LENGTH)));
    expectPolicy(
      () =>
        assertCreateNonceTx(built.transaction, {
          ...expected,
          authority: Keypair.generate().publicKey,
        }),
      /authority/,
    );
    expectPolicy(
      () => assertCreateNonceTx(built.transaction, { ...expected, rentLamports: 1n }),
      /rent/,
    );
  });
});

describe('launch policy (real core, devnet config fixture)', () => {
  it('accepts the launch core builds, and reads the nonce with its slot', async () => {
    const { core, params, expectation, creator, nonceAccount } = launchSetup();
    const { transaction, summary } = await core.buildLaunchCoinTx(params);
    assertLaunchCoinTx(transaction, expectation());
    expect(summary.durableNonce?.nonce).toBe(NONCE_VALUE);
    expect(await core.readNonce(nonceAccount, creator, 'confirmed')).toEqual({
      nonce: NONCE_VALUE,
      slot: 7,
    });
    expect(await core.readNonce(Keypair.generate().publicKey, creator, 'confirmed')).toBeNull();
  });

  it('never puts a referral on the first buy, whatever the environment says', async () => {
    const { core, params } = launchSetup();
    const previous = process.env.FORGE_METEORA_REFERRAL_ACCOUNT;
    // An account that does not exist: core would refuse it (REFERRAL_INVALID) if it were used.
    process.env.FORGE_METEORA_REFERRAL_ACCOUNT = Keypair.generate().publicKey.toBase58();
    try {
      const { summary } = await core.buildLaunchCoinTx(params);
      expect(summary.referralSource).toBe('none');
      expect(summary.referralTokenAccount).toBeNull();
      expect(core.firstBuyReferral).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.FORGE_METEORA_REFERRAL_ACCOUNT;
      else process.env.FORGE_METEORA_REFERRAL_ACCOUNT = previous;
    }
  });

  it('accepts the priced launch in both placements, and refuses a second price', async () => {
    const priced = launchSetup({ priority: DEFAULT_SIGNER_PRIORITY_FEE });
    const built = await priced.core.buildLaunchCoinTx(priced.params);
    expect(built.summary.priorityFeePlacement).toBe('limit_and_price');
    expect(built.summary.computeUnitPriceMicroLamports).toBe(100_000);
    assertLaunchCoinTx(built.transaction, priced.expectation());

    // The longest metadata the launch accepts but for 4 bytes: the price goes alone.
    const tight = launchSetup({ priority: DEFAULT_SIGNER_PRIORITY_FEE });
    const uri = `https://example.com/${'a'.repeat(102 - 25)}.json`;
    const alone = await tight.core.buildLaunchCoinTx({
      ...tight.params,
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      metadataUri: uri,
    });
    expect(alone.summary.priorityFeePlacement).toBe('price_only');
    assertLaunchCoinTx(alone.transaction, tight.expectation());

    built.transaction.instructions.splice(
      2,
      0,
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    );
    expectPolicy(() => assertLaunchCoinTx(built.transaction, priced.expectation()), /duplicate/);
  });

  it('accepts a launch without a first buy', async () => {
    const { core, params, expectation } = launchSetup();
    const { transaction } = await core.buildLaunchCoinTx({ ...params, firstBuyLamports: 0n });
    assertLaunchCoinTx(transaction, expectation({ firstBuy: false }));
    expectPolicy(() => assertLaunchCoinTx(transaction, expectation({ firstBuy: true })));
  });

  it('refuses anything else the creator signature could authorize', async () => {
    const { core, params, expectation, creator, nonceAccount } = launchSetup();
    const attacker = Keypair.generate().publicKey;
    const tamper = async (extra: TransactionInstruction): Promise<Transaction> => {
      const { transaction } = await core.buildLaunchCoinTx(params);
      transaction.add(extra);
      return transaction;
    };
    // Withdraw the nonce rent, hand the nonce to someone else, move SOL from the creator.
    for (const extra of [
      SystemProgram.nonceWithdraw({
        noncePubkey: nonceAccount,
        authorizedPubkey: creator,
        toPubkey: attacker,
        lamports: 1,
      }),
      SystemProgram.nonceAuthorize({
        noncePubkey: nonceAccount,
        authorizedPubkey: creator,
        newAuthorizedPubkey: attacker,
      }),
      SystemProgram.transfer({ fromPubkey: creator, toPubkey: attacker, lamports: 1n }),
    ]) {
      const tx = await tamper(extra);
      expectPolicy(() => assertLaunchCoinTx(tx, expectation()));
    }
    // Any other DBC instruction (e.g. transfer_pool_creator) signed by the creator.
    const transferCreator = new TransactionInstruction({
      programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      keys: [
        { pubkey: core.poolAddress(CONFIG, params.mint), isSigner: false, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: creator, isSigner: true, isWritable: false },
        { pubkey: attacker, isSigner: false, isWritable: false },
      ],
      data: anchorDiscriminator('transfer_pool_creator'),
    });
    const tx = await tamper(transferCreator);
    expectPolicy(() => assertLaunchCoinTx(tx, expectation()), /DBC instruction not allowed/);
  });

  it('refuses a launch on another config, pool, mint, nonce or fee payer', async () => {
    const { core, params, expectation } = launchSetup();
    const { transaction } = await core.buildLaunchCoinTx(params);
    const other = () => Keypair.generate().publicKey;
    for (const overrides of [
      { config: other() },
      { pool: other() },
      { mint: other() },
      { nonceAccount: other() },
      { nonceValue: BLOCKHASH },
      { owner: other() },
      { creator: other() },
    ]) {
      expectPolicy(() => assertLaunchCoinTx(transaction, expectation(overrides)));
    }
  });

  it('refuses a launch whose nonce advance is not first', async () => {
    const { core, params, expectation } = launchSetup();
    const { transaction } = await core.buildLaunchCoinTx(params);
    const [advance, ...rest] = transaction.instructions;
    transaction.instructions = [...rest, advance!];
    expectPolicy(() => assertLaunchCoinTx(transaction, expectation()), /nonce advance/);
  });
});
