import { readFileSync } from 'node:fs';
import {
  Connection as Web3Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type AccountInfo,
  type Connection,
  type Transaction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAddressError } from './addresses.js';
import {
  CLAIM_LAMPORTS_PER_SIGNATURE,
  ClaimError,
  PARTNER_POOL_CREATION_FEE_CLAIMED_BIT,
  buildCreatorClaimTx,
  buildForgeCreatorClaimTx,
  buildPartnerClaimTx,
  buildPartnerPoolCreationFeeClaimTx,
  isClaimWorthwhile,
  minimumWorthwhileClaimLamports,
  partnerPoolCreationFeeShare,
  type ClaimTxResult,
} from './claims.js';
import { DbcReadError } from './reads.js';

/** Real devnet accounts (wave-1 test pools): see __fixtures__/dbc-devnet-accounts.json. */
interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/dbc-devnet-accounts.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, FixtureAccount> };
const fx = (name: string): FixtureAccount => {
  const a = FIXTURES.accounts[name];
  if (!a) throw new Error(`fixture ${name} missing`);
  return a;
};
const key = (name: string) => new PublicKey(fx(name).address);

/** Devnet throwaway wallets recorded in the fixtures. */
const FORGE_CREATOR = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
const PARTNER = new PublicKey('Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa');
const RECEIVER = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

/** Creator share claimable on the test 2 pool, partner share on the test 3 pool (fixtures). */
const TEST2_CREATOR_QUOTE = 1_737_887n;
const TEST3_PARTNER_QUOTE = 30_000_000n;

/** Mainnet rent formula: (128 + size) * 3480 lamports/byte-year * 2 years. */
const rent = (size: number) => (128 + size) * 6960;
const TOKEN_RENT = BigInt(rent(ACCOUNT_SIZE));

const coder = DynamicBondingCurveClient.create(
  new Web3Connection('http://127.0.0.1:8899'),
  'confirmed',
).pool.getProgram().coder.accounts;

function wsolAccount(owner: PublicKey, amount: bigint): AccountInfo<Buffer> {
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
      isNative: TOKEN_RENT,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: Number(TOKEN_RENT + amount),
    executable: false,
    rentEpoch: 0,
  };
}

function systemAccount(lamports: number): AccountInfo<Buffer> {
  return {
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    lamports,
    executable: false,
    rentEpoch: 0,
  };
}

interface MockOptions {
  /** Raw data overrides of fixture accounts, by address. */
  overrides?: Record<string, Buffer>;
  /** Extra accounts (token accounts, wallets), by address. */
  extra?: Record<string, AccountInfo<Buffer>>;
  /** Rent-exempt minimum override for a given data size. */
  rentOverride?: Record<number, number>;
}

function mockConnection(options: MockOptions = {}) {
  const byAddress = new Map(Object.values(FIXTURES.accounts).map((a) => [a.address, a]));
  const extra = new Map(Object.entries(options.extra ?? {}));
  const lookup = (address: PublicKey): AccountInfo<Buffer> | null => {
    const fromExtra = extra.get(address.toBase58());
    if (fromExtra) return fromExtra;
    const a = byAddress.get(address.toBase58());
    return a
      ? {
          data: options.overrides?.[a.address] ?? Buffer.from(a.data, 'base64'),
          owner: new PublicKey(a.owner),
          lamports: a.lamports,
          executable: false,
          rentEpoch: 0,
        }
      : null;
  };
  const getAccountInfoAndContext = vi.fn(async (address: PublicKey) => ({
    context: { slot: 1 },
    value: lookup(address),
  }));
  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 500,
  }));
  const connection = {
    commitment: 'confirmed',
    rpcEndpoint: 'http://mock.invalid',
    getAccountInfoAndContext,
    getAccountInfo: vi.fn(async (address: PublicKey) => lookup(address)),
    getMultipleAccountsInfo: vi.fn(async (addresses: PublicKey[]) => addresses.map(lookup)),
    getMinimumBalanceForRentExemption: vi.fn(
      async (size: number) => options.rentOverride?.[size] ?? rent(size),
    ),
    getLatestBlockhash,
  } as unknown as Connection;
  return { connection, getLatestBlockhash };
}

const noRetry = { retry: { attempts: 1, baseDelayMs: 0 } };

const programIs = (id: PublicKey) => (ix: Transaction['instructions'][number]) =>
  ix.programId.equals(id);

/** Instruction kinds of a claim transaction, in order. */
function shape(tx: Transaction): string[] {
  return tx.instructions.map((ix) => {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return `ata:${ix.data[0]}`;
    if (ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return 'claim';
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return ix.data[0] === 3 ? 'token:transfer' : ix.data[0] === 9 ? 'token:close' : 'token:?';
    }
    if (ix.programId.equals(SystemProgram.programId)) {
      return `system:${SystemInstruction.decodeInstructionType(ix)}`;
    }
    return 'other';
  });
}

/** `maxBaseAmount` / `maxQuoteAmount` arguments of the DBC claim instruction. */
function claimArgs(tx: Transaction): { maxBase: bigint; maxQuote: bigint } {
  const ix = tx.instructions.find(programIs(DYNAMIC_BONDING_CURVE_PROGRAM_ID))!;
  return { maxBase: ix.data.readBigUInt64LE(8), maxQuote: ix.data.readBigUInt64LE(16) };
}

const U64_MAX = 2n ** 64n - 1n;

function isWritable(tx: Transaction, account: PublicKey): boolean {
  const message = tx.compileMessage();
  const index = message.accountKeys.findIndex((k) => k.equals(account));
  return index >= 0 && message.isAccountWritable(index);
}

function isSigner(tx: Transaction, account: PublicKey): boolean {
  const message = tx.compileMessage();
  const index = message.accountKeys.findIndex((k) => k.equals(account));
  return index >= 0 && message.isAccountSigner(index);
}

describe('buildCreatorClaimTx — claim to another receiver (FORGE: the multisig)', () => {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, FORGE_CREATOR, true, TOKEN_PROGRAM_ID);

  async function build(payer?: PublicKey, mock = mockConnection()): Promise<ClaimTxResult> {
    return buildCreatorClaimTx(
      mock.connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER, payer },
      noRetry,
    );
  }

  it('claims exactly the claimable SOL, returns the WSOL rent and pays the receiver exactly', async () => {
    const result = await build();
    expect(result.skipReason).toBeNull();
    expect(result.summary.kind).toBe('creator');
    expect(result.summary.claimable).toEqual({ base: 0n, quote: TEST2_CREATOR_QUOTE });
    expect(result.summary.receiverQuoteLamports).toBe(TEST2_CREATOR_QUOTE);
    expect(result.summary.quoteIsExact).toBe(true);
    expect(result.lastValidBlockHeight).toBe(500);

    const tx = result.transaction!;
    expect(tx.feePayer?.equals(FORGE_CREATOR)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(shape(tx)).toEqual([
      'ata:1',
      'ata:1',
      'claim',
      'token:transfer',
      'token:close',
      'system:Transfer',
    ]);

    // Claim capped to the build-time amount (an exact transfer follows), base uncapped.
    expect(claimArgs(tx)).toEqual({ maxBase: U64_MAX, maxQuote: TEST2_CREATOR_QUOTE });
    const claim = tx.instructions[2]!;
    expect(claim.keys.some((k) => k.pubkey.equals(FORGE_CREATOR) && k.isSigner)).toBe(true);
    expect(claim.keys.some((k) => k.pubkey.equals(key('test2Pool')))).toBe(true);
    // Coin fees to the receiver's account, SOL fees to the creator's temporary WSOL account.
    const baseMint = result.summary.baseMint;
    const receiverBase = getAssociatedTokenAddressSync(baseMint, RECEIVER, true);
    expect(claim.keys.some((k) => k.pubkey.equals(receiverBase))).toBe(true);
    expect(claim.keys.some((k) => k.pubkey.equals(wsol))).toBe(true);

    // Both token accounts are created idempotently by the payer.
    const [baseAta, wsolAta] = tx.instructions;
    expect(baseAta!.keys[0]!.pubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(baseAta!.keys[1]!.pubkey.equals(receiverBase)).toBe(true);
    expect(baseAta!.keys[2]!.pubkey.equals(RECEIVER)).toBe(true);
    expect(wsolAta!.keys[1]!.pubkey.equals(wsol)).toBe(true);
    expect(wsolAta!.keys[2]!.pubkey.equals(FORGE_CREATOR)).toBe(true);

    // The on-chain assertion: a self-transfer of the full amount on the WSOL account.
    const check = tx.instructions[3]!;
    expect(check.keys[0]!.pubkey.equals(wsol)).toBe(true);
    expect(check.keys[1]!.pubkey.equals(wsol)).toBe(true);
    expect(check.keys[2]!.pubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(check.data.readBigUInt64LE(1)).toBe(TEST2_CREATOR_QUOTE);

    // The WSOL account is closed back to the payer (its rent returns), never to the receiver.
    const close = tx.instructions[4]!;
    expect(close.keys[0]!.pubkey.equals(wsol)).toBe(true);
    expect(close.keys[1]!.pubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(close.keys[2]!.pubkey.equals(FORGE_CREATOR)).toBe(true);

    // Then exactly the claimed SOL goes to the receiver.
    const transfer = SystemInstruction.decodeTransfer(tx.instructions[5]!);
    expect(transfer.fromPubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(transfer.toPubkey.equals(RECEIVER)).toBe(true);
    expect(transfer.lamports).toBe(TEST2_CREATOR_QUOTE);
  });

  it('costs the creator (as payer) only the network fee and the one-time coin account rent', async () => {
    const { summary } = await build();
    expect(summary.costs).toEqual({
      networkFeeLamports: CLAIM_LAMPORTS_PER_SIGNATURE,
      receiverTokenAccountRentLamports: TOKEN_RENT,
      temporaryLamports: TOKEN_RENT,
      payerTotalLamports: CLAIM_LAMPORTS_PER_SIGNATURE + TOKEN_RENT,
      payerRequiredBalanceLamports: CLAIM_LAMPORTS_PER_SIGNATURE + 2n * TOKEN_RENT,
    });
    expect(summary.netLamports).toBe(
      TEST2_CREATOR_QUOTE - CLAIM_LAMPORTS_PER_SIGNATURE - TOKEN_RENT,
    );
  });

  it('costs nothing but the fee once the receiver coin account exists', async () => {
    const { summary } = await build(undefined, mockConnection());
    const baseMint = summary.baseMint;
    const receiverBase = getAssociatedTokenAddressSync(baseMint, RECEIVER, true);
    const second = await build(
      undefined,
      mockConnection({
        extra: {
          [receiverBase.toBase58()]: {
            ...wsolAccount(RECEIVER, 0n),
            data: Buffer.alloc(ACCOUNT_SIZE),
          },
          [wsol.toBase58()]: wsolAccount(FORGE_CREATOR, 0n),
        },
      }),
    );
    expect(second.summary.costs.receiverTokenAccountRentLamports).toBe(0n);
    expect(second.summary.costs.temporaryLamports).toBe(0n);
    expect(second.summary.costs.payerTotalLamports).toBe(CLAIM_LAMPORTS_PER_SIGNATURE);
    expect(second.summary.netLamports).toBe(TEST2_CREATOR_QUOTE - CLAIM_LAMPORTS_PER_SIGNATURE);
  });

  it('leaves the creator wallet read-only with a separate payer', async () => {
    const payer = Keypair.generate().publicKey;
    const { transaction, summary } = await build(payer);
    const tx = transaction!;
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(summary.payer.equals(payer)).toBe(true);
    // The creator signs, but no instruction can debit or credit it.
    expect(isSigner(tx, FORGE_CREATOR)).toBe(true);
    expect(isWritable(tx, FORGE_CREATOR)).toBe(false);
    expect(tx.instructions[0]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(tx.instructions[1]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(tx.instructions[4]!.keys[1]!.pubkey.equals(payer)).toBe(true);
    const transfer = SystemInstruction.decodeTransfer(tx.instructions[5]!);
    expect(transfer.fromPubkey.equals(payer)).toBe(true);
    expect(transfer.toPubkey.equals(RECEIVER)).toBe(true);
    expect(summary.costs.networkFeeLamports).toBe(2n * CLAIM_LAMPORTS_PER_SIGNATURE);
  });

  it('refuses a creator WSOL account holding WSOL when another wallet pays', async () => {
    const payer = Keypair.generate().publicKey;
    const mock = mockConnection({ extra: { [wsol.toBase58()]: wsolAccount(FORGE_CREATOR, 5n) } });
    const err = await build(payer, mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as ClaimError).code).toBe('claimer_wsol_not_empty');
    // The creator paying itself gets its own WSOL back: allowed.
    const own = await build(
      undefined,
      mockConnection({ extra: { [wsol.toBase58()]: wsolAccount(FORGE_CREATOR, 5n) } }),
    );
    expect(own.transaction).not.toBeNull();
  });

  it('refuses a receiver that would not be rent-exempt after the transfer', async () => {
    // Receiver missing (0 lamports) and a 0-byte rent-exempt minimum above the claimed amount.
    const mock = mockConnection({ rentOverride: { 0: Number(TEST2_CREATOR_QUOTE) + 1 } });
    const err = await build(undefined, mock).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('receiver_not_rent_exempt');
    // A funded receiver is fine.
    const funded = mockConnection({
      rentOverride: { 0: Number(TEST2_CREATOR_QUOTE) + 1 },
      extra: { [RECEIVER.toBase58()]: systemAccount(10) },
    });
    expect((await build(undefined, funded)).transaction).not.toBeNull();
  });
});

describe('buildCreatorClaimTx — claim to the payer itself (template creators)', () => {
  it('claims everything, closes the WSOL account to the creator and transfers nothing', async () => {
    const result = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: FORGE_CREATOR },
      noRetry,
    );
    const tx = result.transaction!;
    expect(shape(tx)).toEqual(['ata:1', 'ata:1', 'claim', 'token:close']);
    expect(claimArgs(tx)).toEqual({ maxBase: U64_MAX, maxQuote: U64_MAX });
    expect(tx.instructions[3]!.keys[1]!.pubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(result.summary.quoteIsExact).toBe(false);
    expect(result.summary.receiverQuoteLamports).toBe(TEST2_CREATOR_QUOTE);
  });
});

describe('buildCreatorClaimTx — checks and skips', () => {
  it('returns no transaction when nothing is claimable', async () => {
    const { connection, getLatestBlockhash } = mockConnection();
    const result = await buildCreatorClaimTx(
      connection,
      { pool: key('test1Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    );
    expect(result.transaction).toBeNull();
    expect(result.skipReason).toBe('nothing_to_claim');
    expect(result.lastValidBlockHeight).toBeNull();
    expect(result.summary.claimable).toEqual({ base: 0n, quote: 0n });
    expect(result.summary.netLamports).toBe(0n);
    expect(isClaimWorthwhile(result.summary)).toBe(false);
    expect(getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('flags a first claim that costs more (coin account rent) than it collects', async () => {
    const result = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    );
    // 1,737,887 lamports claimable < 2,039,280 rent of the receiver's coin account + fee.
    expect(result.summary.netLamports).toBeLessThan(0n);
    expect(isClaimWorthwhile(result.summary)).toBe(false);
    expect(minimumWorthwhileClaimLamports(result.summary.costs)).toBe(
      CLAIM_LAMPORTS_PER_SIGNATURE + TOKEN_RENT + 1n,
    );
    const skipped = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      { ...noRetry, minNetLamports: 0n },
    );
    expect(skipped.transaction).toBeNull();
    expect(skipped.skipReason).toBe('not_worthwhile');
  });

  it('skips a claim that does not net more than minNetLamports', async () => {
    const params = { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER };
    // The receiver's coin account already exists: only the network fee is paid.
    const fresh = await buildCreatorClaimTx(mockConnection().connection, params, noRetry);
    const receiverBase = getAssociatedTokenAddressSync(fresh.summary.baseMint, RECEIVER, true);
    const withAccount = () =>
      mockConnection({
        extra: {
          [receiverBase.toBase58()]: {
            ...wsolAccount(RECEIVER, 0n),
            data: Buffer.alloc(ACCOUNT_SIZE),
          },
        },
      }).connection;
    const full = await buildCreatorClaimTx(withAccount(), params, noRetry);
    const net = full.summary.netLamports;
    expect(net).toBe(TEST2_CREATOR_QUOTE - CLAIM_LAMPORTS_PER_SIGNATURE);
    expect(isClaimWorthwhile(full.summary)).toBe(true);
    expect(isClaimWorthwhile(full.summary, net)).toBe(false);
    expect(minimumWorthwhileClaimLamports(full.summary.costs)).toBe(
      full.summary.costs.payerTotalLamports + 1n,
    );
    expect(minimumWorthwhileClaimLamports(full.summary.costs, 1000n)).toBe(
      full.summary.costs.payerTotalLamports + 1001n,
    );

    const skipped = await buildCreatorClaimTx(withAccount(), params, {
      ...noRetry,
      minNetLamports: net,
    });
    expect(skipped.transaction).toBeNull();
    expect(skipped.skipReason).toBe('not_worthwhile');
    expect(skipped.summary.netLamports).toBe(net);

    const kept = await buildCreatorClaimTx(withAccount(), params, {
      ...noRetry,
      minNetLamports: net - 1n,
    });
    expect(kept.transaction).not.toBeNull();
  });

  it('pins the receiver with expectedReceiver', async () => {
    const vault = Keypair.generate().publicKey;
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      {
        pool: key('test2Pool'),
        creator: FORGE_CREATOR,
        receiver: RECEIVER,
        expectedReceiver: vault,
      },
      noRetry,
    ).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('receiver_mismatch');
    const ok = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: vault, expectedReceiver: vault },
      noRetry,
    );
    expect(ok.summary.receiver.equals(vault)).toBe(true);
  });

  it('rejects a signer that is not the pool creator', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: PARTNER, receiver: RECEIVER },
      noRetry,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as ClaimError).code).toBe('not_pool_creator');
  });

  it('rejects the system program as receiver', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: PublicKey.default },
      noRetry,
    ).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('invalid_receiver');
  });

  it('rejects a pool that is not SOL-quoted', async () => {
    const config = Buffer.from(fx('test2Config').data, 'base64');
    const at = config.indexOf(NATIVE_MINT.toBuffer());
    expect(at).toBeGreaterThan(0);
    Keypair.generate().publicKey.toBuffer().copy(config, at);
    const { connection } = mockConnection({ overrides: { [fx('test2Config').address]: config } });
    const err = await buildCreatorClaimTx(
      connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    ).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('unsupported_quote_mint');
  });

  it('fails clearly on an unknown pool', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: PublicKey.unique(), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbcReadError);
  });
});

describe('buildForgeCreatorClaimTx', () => {
  it('always sends the creator fees to the FORGE multisig vault', async () => {
    const vault = Keypair.generate().publicKey;
    const result = await buildForgeCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR },
      { ...noRetry, env: { FORGE_MULTISIG_VAULT: vault.toBase58() } },
    );
    expect(result.summary.receiver.equals(vault)).toBe(true);
    const transfer = SystemInstruction.decodeTransfer(result.transaction!.instructions.at(-1)!);
    expect(transfer.toPubkey.equals(vault)).toBe(true);
    expect(transfer.lamports).toBe(TEST2_CREATOR_QUOTE);
  });

  it('refuses to build without FORGE_MULTISIG_VAULT', async () => {
    await expect(
      buildForgeCreatorClaimTx(
        mockConnection().connection,
        { pool: key('test2Pool'), creator: FORGE_CREATOR },
        { ...noRetry, env: {} },
      ),
    ).rejects.toBeInstanceOf(ForgeAddressError);
  });
});

describe('buildPartnerClaimTx', () => {
  it('builds an unsigned partner claim, receiver defaulting to the fee claimer', async () => {
    const result = await buildPartnerClaimTx(
      mockConnection().connection,
      { pool: key('test3Pool'), feeClaimer: PARTNER },
      noRetry,
    );
    expect(result.summary.kind).toBe('partner');
    expect(result.summary.claimable).toEqual({ base: 0n, quote: TEST3_PARTNER_QUOTE });
    expect(result.summary.receiver.equals(PARTNER)).toBe(true);
    const tx = result.transaction!;
    expect(tx.feePayer?.equals(PARTNER)).toBe(true);
    expect(shape(tx)).toEqual(['ata:1', 'ata:1', 'claim', 'token:close']);
    const claimIx = tx.instructions.find(programIs(DYNAMIC_BONDING_CURVE_PROGRAM_ID))!;
    expect(claimIx.keys.some((k) => k.pubkey.equals(PARTNER) && k.isSigner)).toBe(true);
    expect(claimIx.keys.some((k) => k.pubkey.equals(key('test3Config')))).toBe(true);
    expect(tx.instructions[3]!.keys[1]!.pubkey.equals(PARTNER)).toBe(true);
  });

  it('sends exactly the partner share to an explicit receiver (e.g. the FORGE multisig vault)', async () => {
    const result = await buildPartnerClaimTx(
      mockConnection().connection,
      { pool: key('test1Pool'), feeClaimer: PARTNER, receiver: RECEIVER },
      noRetry,
    );
    expect(result.summary.claimable.quote).toBe(1_600_000n);
    const tx = result.transaction!;
    expect(shape(tx)).toEqual([
      'ata:1',
      'ata:1',
      'claim',
      'token:transfer',
      'token:close',
      'system:Transfer',
    ]);
    expect(claimArgs(tx).maxQuote).toBe(1_600_000n);
    // Closed back to the payer (the fee claimer), not to the receiver.
    expect(tx.instructions[4]!.keys[1]!.pubkey.equals(PARTNER)).toBe(true);
    const transfer = SystemInstruction.decodeTransfer(tx.instructions[5]!);
    expect(transfer.toPubkey.equals(RECEIVER)).toBe(true);
    expect(transfer.lamports).toBe(1_600_000n);
  });

  it('rejects a signer that is not the config fee claimer', async () => {
    const err = await buildPartnerClaimTx(
      mockConnection().connection,
      { pool: key('test3Pool'), feeClaimer: FORGE_CREATOR },
      noRetry,
    ).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('not_fee_claimer');
  });
});

describe('buildPartnerPoolCreationFeeClaimTx', () => {
  async function poolWithCreationFeeBits(name: string, bits: number): Promise<Buffer> {
    const decoded = coder.decode<VirtualPool>('virtualPool', Buffer.from(fx(name).data, 'base64'));
    return coder.encode('virtualPool', {
      ...decoded,
      poolState: { ...decoded.poolState, creationFeeBits: bits },
    });
  }

  it('claims the partner share (90%) of the pool creation fee', async () => {
    const result = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection({ extra: { [PARTNER.toBase58()]: systemAccount(1_000_000_000) } }).connection,
      { pool: key('test2Pool'), feeClaimer: PARTNER },
      noRetry,
    );
    expect(result.skipReason).toBeNull();
    expect(result.summary.poolCreationFeeLamports).toBe(1_000_000n);
    expect(result.summary.partnerShareLamports).toBe(900_000n);
    expect(result.summary.claimableLamports).toBe(900_000n);
    expect(result.summary.alreadyClaimed).toBe(false);
    expect(result.summary.netLamports).toBe(900_000n - CLAIM_LAMPORTS_PER_SIGNATURE);
    const tx = result.transaction!;
    expect(tx.feePayer?.equals(PARTNER)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    // Anchor discriminator of `claim_partner_pool_creation_fee`.
    expect([...ix.data.subarray(0, 8)]).toEqual([250, 238, 26, 4, 139, 10, 101, 248]);
    expect(ix.keys[0]!.pubkey.equals(key('test2Config'))).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(key('test2Pool'))).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(PARTNER) && ix.keys[2]!.isSigner).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(PARTNER) && ix.keys[3]!.isWritable).toBe(true);
  });

  it('sends it to an explicit receiver with an explicit payer', async () => {
    const payer = Keypair.generate().publicKey;
    const result = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection({ extra: { [RECEIVER.toBase58()]: systemAccount(1_000_000) } }).connection,
      { pool: key('test3Pool'), feeClaimer: PARTNER, receiver: RECEIVER, payer },
      noRetry,
    );
    const tx = result.transaction!;
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(tx.instructions[0]!.keys[3]!.pubkey.equals(RECEIVER)).toBe(true);
    expect(result.summary.networkFeeLamports).toBe(2n * CLAIM_LAMPORTS_PER_SIGNATURE);
  });

  it('skips a pool whose fee was already claimed, or a config without fee', async () => {
    const claimed = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection({
        overrides: {
          [fx('test2Pool').address]: await poolWithCreationFeeBits(
            'test2Pool',
            PARTNER_POOL_CREATION_FEE_CLAIMED_BIT,
          ),
        },
      }).connection,
      { pool: key('test2Pool'), feeClaimer: PARTNER },
      noRetry,
    );
    expect(claimed.transaction).toBeNull();
    expect(claimed.skipReason).toBe('already_claimed');
    expect(claimed.summary.alreadyClaimed).toBe(true);
    expect(claimed.summary.claimableLamports).toBe(0n);

    // Only the protocol bit set: the partner can still claim.
    const protocolOnly = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection({
        overrides: { [fx('test2Pool').address]: await poolWithCreationFeeBits('test2Pool', 0b01) },
        extra: { [PARTNER.toBase58()]: systemAccount(1_000_000_000) },
      }).connection,
      { pool: key('test2Pool'), feeClaimer: PARTNER },
      noRetry,
    );
    expect(protocolOnly.transaction).not.toBeNull();

    const noFee = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection().connection,
      { pool: key('test1Pool'), feeClaimer: PARTNER },
      noRetry,
    );
    expect(noFee.transaction).toBeNull();
    expect(noFee.skipReason).toBe('no_pool_creation_fee');
  });

  it('rejects a signer that is not the fee claimer and a receiver left below rent', async () => {
    const err = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), feeClaimer: FORGE_CREATOR },
      noRetry,
    ).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('not_fee_claimer');

    const poor = await buildPartnerPoolCreationFeeClaimTx(
      mockConnection({ rentOverride: { 0: 900_001 } }).connection,
      { pool: key('test2Pool'), feeClaimer: PARTNER, receiver: RECEIVER },
      noRetry,
    ).catch((e: unknown) => e);
    expect((poor as ClaimError).code).toBe('receiver_not_rent_exempt');
  });

  it('splits the fee like the program (protocol 10%, rounded down)', () => {
    expect(partnerPoolCreationFeeShare(1_000_000n)).toBe(900_000n);
    expect(partnerPoolCreationFeeShare(1_000_001n)).toBe(900_001n);
    expect(partnerPoolCreationFeeShare(0n)).toBe(0n);
  });
});
