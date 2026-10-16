import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Keypair,
  PublicKey,
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
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID as DBC_SDK_DAMM_V2_PROGRAM_ID,
  MigrationFeeOption,
  MigrationOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, cpAmmCoder, derivePoolAuthority } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAddressError } from './addresses.js';
import { CLAIM_LAMPORTS_PER_SIGNATURE, ClaimError, type ClaimOptions } from './claims.js';
import {
  CLAIM_POSITION_FEE_ACCOUNTS,
  CLAIM_POSITION_FEE_DISCRIMINATOR,
  DAMM_V2_PROGRAM_ID,
  buildCreatorPositionFeeClaimTx,
  buildForgeCreatorPositionFeeClaimTx,
  dammV2TokenProgram,
  findCreatorDammV2Positions,
  getDammV2PoolState,
  isPositionClaimWorthwhile,
  migratedDammV2Pool,
  sumPendingFees,
  type PositionClaimTxResult,
} from './position-claims.js';
import { DbcReadError, getDbcPoolState, type DbcPoolState } from './reads.js';

/**
 * Real devnet accounts of the test 2 migration (captured read-only by
 * scripts/devnet-tests/src/capture-cp-amm-fixtures.ts): the migrated DBC pool and config, the DAMM
 * v2 pool and config, the creator's and the partner's locked positions, their NFT mints and NFT
 * token accounts. The wave-1 DBC fixtures provide a pool that has not migrated.
 */
interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
interface FixtureFile {
  accounts: Record<string, FixtureAccount>;
}
const load = (name: string): FixtureFile =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
const CP = load('cp-amm-devnet-accounts.json');
const DBC = load('dbc-devnet-accounts.json');
const ALL: Record<string, FixtureAccount> = { ...DBC.accounts, ...CP.accounts };
const fx = (name: string): FixtureAccount => {
  const a = ALL[name];
  if (!a) throw new Error(`fixture ${name} missing`);
  return a;
};
const key = (name: string) => new PublicKey(fx(name).address);

/** Devnet throwaway wallets recorded in the fixtures. */
const CREATOR = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
const PARTNER = new PublicKey('Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa');
const RECEIVER = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

/** The creator position was claimed in test 2: the fixture holds no pending fee. Tests patch it. */
const PENDING_QUOTE = 830_889n;
const PENDING_BASE = 1_234n;
/** Permanently locked liquidity of the creator position (fixture). */
const CREATOR_LOCKED = 4116568165138960358144621872091n;

/** Mainnet rent formula: (128 + size) * 3480 lamports/byte-year * 2 years. */
const rent = (size: number) => (128 + size) * 6960;
const TOKEN_RENT = BigInt(rent(ACCOUNT_SIZE));

const BASE_MINT = () => new PublicKey('tzcZtpFfGoHVYF9TZBVm2Kaw5wRFzfomyjVABZ7YKH7');
const creatorWsol = () => getAssociatedTokenAddressSync(NATIVE_MINT, CREATOR, true);
const receiverBase = (receiver: PublicKey) =>
  getAssociatedTokenAddressSync(BASE_MINT(), receiver, true);

function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  programId = TOKEN_PROGRAM_ID,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  const native = mint.equals(NATIVE_MINT);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: native ? 1 : 0,
      isNative: native ? TOKEN_RENT : 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: programId,
    lamports: Number(TOKEN_RENT + (native ? amount : 0n)),
    executable: false,
    rentEpoch: 0,
  };
}

/** Re-encodes a fixture position with some fields changed (raw IDL names, BN amounts). */
async function positionWith(name: string, patch: Record<string, unknown>): Promise<Buffer> {
  const decoded = cpAmmCoder.accounts.decode('Position', Buffer.from(fx(name).data, 'base64')) as Record<
    string,
    unknown
  >;
  return cpAmmCoder.accounts.encode('Position', { ...decoded, ...patch });
}

const withPendingFees = (quote = PENDING_QUOTE, base = 0n) =>
  positionWith('creatorPosition', {
    fee_b_pending: new BN(quote.toString()),
    fee_a_pending: new BN(base.toString()),
  });

interface MockOptions {
  /** Raw data overrides of fixture accounts, by address. */
  overrides?: Record<string, Buffer>;
  /** Extra accounts (token accounts, wallets), by address. */
  extra?: Record<string, AccountInfo<Buffer>>;
  rentOverride?: Record<number, number>;
  /** `getTokenAccountsByOwner` finds nothing (no position NFT). */
  noNftAccounts?: boolean;
}

/** Minimal Connection serving the fixtures to core and to the two Meteora SDKs (no network). */
function mockConnection(options: MockOptions = {}) {
  const byAddress = new Map(Object.values(ALL).map((a) => [a.address, a]));
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
  const known = (): PublicKey[] => [
    ...[...byAddress.keys()].map((k) => new PublicKey(k)),
    ...[...extra.keys()].map((k) => new PublicKey(k)),
  ];
  const getLatestBlockhash = vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 }));
  const getTokenAccountsByOwner = vi.fn(
    async (owner: PublicKey, filter: { programId?: PublicKey; mint?: PublicKey }) => {
      const value: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }> = [];
      if (!options.noNftAccounts) {
        for (const pubkey of known()) {
          const info = lookup(pubkey);
          if (!info || info.data.length !== ACCOUNT_SIZE) continue;
          if (filter.programId && !info.owner.equals(filter.programId)) continue;
          const decoded = AccountLayout.decode(info.data);
          if (!new PublicKey(decoded.owner).equals(owner)) continue;
          if (filter.mint && !new PublicKey(decoded.mint).equals(filter.mint)) continue;
          value.push({ pubkey, account: info });
        }
      }
      return { context: { slot: 1 }, value };
    },
  );
  const connection = {
    commitment: 'confirmed',
    rpcEndpoint: 'http://mock.invalid',
    getAccountInfoAndContext: vi.fn(async (address: PublicKey) => ({
      context: { slot: 1 },
      value: lookup(address),
    })),
    getAccountInfo: vi.fn(async (address: PublicKey) => lookup(address)),
    getMultipleAccountsInfo: vi.fn(async (addresses: PublicKey[]) => addresses.map(lookup)),
    getMultipleAccountsInfoAndContext: vi.fn(async (addresses: PublicKey[]) => ({
      context: { slot: 1 },
      value: addresses.map(lookup),
    })),
    getTokenAccountsByOwner,
    getMinimumBalanceForRentExemption: vi.fn(
      async (size: number) => options.rentOverride?.[size] ?? rent(size),
    ),
    getLatestBlockhash,
  } as unknown as Connection;
  return { connection, getLatestBlockhash, getTokenAccountsByOwner };
}

const noRetry = { retry: { attempts: 1, baseDelayMs: 0 } };

/** Instruction kinds of a claim transaction, in order. */
function shape(tx: Transaction): string[] {
  return tx.instructions.map((ix) => {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return `ata:${ix.data[0]}`;
    if (ix.programId.equals(DAMM_V2_PROGRAM_ID)) return 'claim';
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return ix.data[0] === 3 ? 'token:transfer' : ix.data[0] === 9 ? 'token:close' : 'token:?';
    }
    if (ix.programId.equals(SystemProgram.programId)) return 'system';
    return 'other';
  });
}

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

async function dbcState(name: string, mock = mockConnection()): Promise<DbcPoolState> {
  return getDbcPoolState(mock.connection, key(name), noRetry);
}

describe('constants', () => {
  it('pins the cp-amm program id and the claim_position_fee discriminator', () => {
    expect(DAMM_V2_PROGRAM_ID.equals(CP_AMM_PROGRAM_ID)).toBe(true);
    expect(DAMM_V2_PROGRAM_ID.equals(DBC_SDK_DAMM_V2_PROGRAM_ID)).toBe(true);
    expect(DAMM_V2_PROGRAM_ID.toBase58()).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    const expected = createHash('sha256').update('global:claim_position_fee').digest().subarray(0, 8);
    expect(CLAIM_POSITION_FEE_DISCRIMINATOR.equals(expected)).toBe(true);
    expect(dammV2TokenProgram(0).equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(dammV2TokenProgram(1).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});

describe('migratedDammV2Pool (pure)', () => {
  it('derives the DAMM v2 pool of the migrated test 2 pool like the SDK migration did', async () => {
    const state = await dbcState('dbcPool');
    const migrated = migratedDammV2Pool(state);
    expect(migrated?.dammPool.equals(key('dammPool'))).toBe(true);
    expect(migrated?.dammConfig.equals(key('dammConfig'))).toBe(true);
    expect(state.config.migrationFeeOption).toBe(MigrationFeeOption.FixedBps25);
  });

  it('is null for a pool still trading, a DAMM v1 migration or an unknown fee option', async () => {
    expect(migratedDammV2Pool(await dbcState('test1Pool'))).toBeNull();
    const state = await dbcState('dbcPool');
    expect(
      migratedDammV2Pool({
        virtualPool: state.virtualPool,
        config: { ...state.config, migrationOption: MigrationOption.MET_DAMM },
      }),
    ).toBeNull();
    // Every option of the pinned SDK (fixed fees and customizable) has a DAMM v2 config.
    const customizable = migratedDammV2Pool({
      virtualPool: state.virtualPool,
      config: { ...state.config, migrationFeeOption: MigrationFeeOption.Customizable },
    });
    expect(customizable?.dammConfig.equals(DAMM_V2_MIGRATION_FEE_ADDRESS[6]!)).toBe(true);
    expect(
      migratedDammV2Pool({
        virtualPool: state.virtualPool,
        config: { ...state.config, migrationFeeOption: 7 },
      }),
    ).toBeNull();
  });
});

describe('findCreatorDammV2Positions', () => {
  it('finds the creator position of the migrated pool, checked and summarized', async () => {
    const mock = mockConnection();
    const found = await findCreatorDammV2Positions(
      mock.connection,
      { pool: key('dbcPool'), creator: CREATOR },
      noRetry,
    );
    expect(found).not.toBeNull();
    expect(found!.pool.equals(key('dbcPool'))).toBe(true);
    expect(found!.dammPool.equals(key('dammPool'))).toBe(true);
    expect(found!.dammConfig.equals(key('dammConfig'))).toBe(true);
    expect(found!.creator.equals(CREATOR)).toBe(true);
    expect(found!.positions).toHaveLength(1);
    const p = found!.positions[0]!;
    expect(p.position.equals(key('creatorPosition'))).toBe(true);
    expect(p.nftMint.equals(key('creatorPositionNftMint'))).toBe(true);
    expect(p.positionNftAccount.equals(key('creatorPositionNftAccount'))).toBe(true);
    expect(p.dammPool.equals(key('dammPool'))).toBe(true);
    expect(p.liquidity).toEqual({ unlocked: 1n, vested: 0n, permanentLocked: CREATOR_LOCKED });
    // Claimed in test 2: nothing pending in the captured state.
    expect(p.pendingFees).toEqual({ base: 0n, quote: 0n });
    expect(found!.claimable).toEqual({ base: 0n, quote: 0n });
    // The NFT accounts are looked up by owner under Token-2022, as the SDK does.
    expect(mock.getTokenAccountsByOwner).toHaveBeenCalledWith(
      CREATOR,
      expect.objectContaining({ programId: TOKEN_2022_PROGRAM_ID }),
    );
  });

  it('accepts an already-read state and reports pending fees', async () => {
    const mock = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees(PENDING_QUOTE, PENDING_BASE) },
    });
    const state = await dbcState('dbcPool', mock);
    const found = await findCreatorDammV2Positions(mock.connection, { pool: state, creator: CREATOR });
    expect(found!.positions[0]!.pendingFees).toEqual({ base: PENDING_BASE, quote: PENDING_QUOTE });
    expect(found!.claimable).toEqual({ base: PENDING_BASE, quote: PENDING_QUOTE });
    expect(sumPendingFees(found!.positions)).toEqual(found!.claimable);
  });

  it('returns null before migration and refuses a wallet that is not the creator', async () => {
    const mock = mockConnection();
    expect(
      await findCreatorDammV2Positions(mock.connection, { pool: key('test1Pool'), creator: CREATOR }),
    ).toBeNull();
    const err = await findCreatorDammV2Positions(mock.connection, {
      pool: key('dbcPool'),
      creator: PARTNER,
    }).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('not_pool_creator');
  });

  it('finds nothing when the creator holds no position NFT', async () => {
    const mock = mockConnection({ noNftAccounts: true });
    const found = await findCreatorDammV2Positions(mock.connection, {
      pool: key('dbcPool'),
      creator: CREATOR,
    });
    expect(found!.positions).toEqual([]);
  });

  it('fails clearly when the DAMM v2 pool is missing or is another pool', async () => {
    const err = await getDammV2PoolState(mockConnection().connection, PublicKey.unique(), noRetry).catch(
      (e: unknown) => e,
    );
    expect((err as ClaimError).code).toBe('damm_pool_not_found');
    // The DBC pool's base mint changed: the derived DAMM v2 pool holds other mints.
    const state = await dbcState('dbcPool');
    const otherMint = Keypair.generate().publicKey;
    const poolData = Buffer.from(fx('dbcPool').data, 'base64');
    const at = poolData.indexOf(state.virtualPool.poolState.baseMint.toBuffer());
    expect(at).toBeGreaterThan(0);
    otherMint.toBuffer().copy(poolData, at);
    const derived = migratedDammV2Pool({
      virtualPool: {
        ...state.virtualPool,
        poolState: { ...state.virtualPool.poolState, baseMint: otherMint },
      },
      config: state.config,
    })!.dammPool;
    const mock = mockConnection({
      overrides: { [fx('dbcPool').address]: poolData },
      extra: {
        [derived.toBase58()]: {
          data: Buffer.from(fx('dammPool').data, 'base64'),
          owner: DAMM_V2_PROGRAM_ID,
          lamports: fx('dammPool').lamports,
          executable: false,
          rentEpoch: 0,
        },
      },
    });
    const mismatch = await findCreatorDammV2Positions(mock.connection, {
      pool: key('dbcPool'),
      creator: CREATOR,
    }).catch((e: unknown) => e);
    expect((mismatch as ClaimError).code).toBe('damm_pool_mismatch');
  });
});

describe('buildCreatorPositionFeeClaimTx', () => {
  async function build(
    params: Partial<Parameters<typeof buildCreatorPositionFeeClaimTx>[1]> = {},
    mock?: ReturnType<typeof mockConnection>,
    options: ClaimOptions = noRetry,
  ): Promise<PositionClaimTxResult> {
    const m =
      mock ??
      mockConnection({
        overrides: { [fx('creatorPosition').address]: await withPendingFees() },
      });
    return buildCreatorPositionFeeClaimTx(
      m.connection,
      { pool: key('dbcPool'), creator: CREATOR, receiver: RECEIVER, ...params },
      options,
    );
  }

  it('claims the position fees to the receiver: coin to its account, SOL unwrapped to it', async () => {
    const result = await build();
    expect(result.skipReason).toBeNull();
    const s = result.summary;
    expect(s.kind).toBe('position');
    expect(s.pool.equals(key('dbcPool'))).toBe(true);
    expect(s.dammPool.equals(key('dammPool'))).toBe(true);
    expect(s.baseMint.equals(BASE_MINT())).toBe(true);
    expect(s.claimer.equals(CREATOR)).toBe(true);
    expect(s.receiver.equals(RECEIVER)).toBe(true);
    expect(s.payer.equals(CREATOR)).toBe(true);
    expect(s.positions.map((p) => p.position.toBase58())).toEqual([fx('creatorPosition').address]);
    expect(s.claimable).toEqual({ base: 0n, quote: PENDING_QUOTE });
    expect(s.quoteIsExact).toBe(false);
    // The temporary WSOL account is closed to the receiver: fees plus its rent.
    expect(s.receiverQuoteLamports).toBe(PENDING_QUOTE + TOKEN_RENT);
    expect(result.lastValidBlockHeight).toBe(500);

    const tx = result.transaction!;
    expect(tx.feePayer?.equals(CREATOR)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures.every((sig) => sig.signature === null)).toBe(true);
    expect(shape(tx)).toEqual(['ata:1', 'ata:1', 'claim', 'token:close']);

    // Both token accounts are created idempotently by the payer.
    const [baseAta, wsolAta, claim, close] = tx.instructions as [
      Transaction['instructions'][number],
      Transaction['instructions'][number],
      Transaction['instructions'][number],
      Transaction['instructions'][number],
    ];
    expect(baseAta.keys[0]!.pubkey.equals(CREATOR)).toBe(true);
    expect(baseAta.keys[1]!.pubkey.equals(receiverBase(RECEIVER))).toBe(true);
    expect(baseAta.keys[2]!.pubkey.equals(RECEIVER)).toBe(true);
    expect(baseAta.keys[3]!.pubkey.equals(BASE_MINT())).toBe(true);
    expect(wsolAta.keys[0]!.pubkey.equals(CREATOR)).toBe(true);
    expect(wsolAta.keys[1]!.pubkey.equals(creatorWsol())).toBe(true);
    expect(wsolAta.keys[2]!.pubkey.equals(CREATOR)).toBe(true);
    expect(wsolAta.keys[3]!.pubkey.equals(NATIVE_MINT)).toBe(true);

    // The claim: exactly the SDK 1.5.1 account layout on the expected accounts, no arguments.
    expect(Buffer.from(claim.data).equals(CLAIM_POSITION_FEE_DISCRIMINATOR)).toBe(true);
    const k = (i: number) => claim.keys[i]!;
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.poolAuthority).pubkey.equals(derivePoolAuthority())).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.pool).pubkey.equals(key('dammPool'))).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.position).pubkey.equals(key('creatorPosition'))).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenAAccount).pubkey.equals(receiverBase(RECEIVER))).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenBAccount).pubkey.equals(creatorWsol())).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenAMint).pubkey.equals(BASE_MINT())).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenBMint).pubkey.equals(NATIVE_MINT)).toBe(true);
    expect(
      k(CLAIM_POSITION_FEE_ACCOUNTS.positionNftAccount).pubkey.equals(key('creatorPositionNftAccount')),
    ).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.owner).pubkey.equals(CREATOR)).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.owner).isSigner).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenAProgram).pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.tokenBProgram).pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(k(CLAIM_POSITION_FEE_ACCOUNTS.program).pubkey.equals(DAMM_V2_PROGRAM_ID)).toBe(true);
    expect(claim.keys).toHaveLength(15);

    // The temporary WSOL account is closed to the receiver by the creator.
    expect(close.keys[0]!.pubkey.equals(creatorWsol())).toBe(true);
    expect(close.keys[1]!.pubkey.equals(RECEIVER)).toBe(true);
    expect(close.keys[2]!.pubkey.equals(CREATOR)).toBe(true);
  });

  it('costs the payer the fee, the one-time coin account rent and the WSOL rent that reaches the receiver', async () => {
    const { summary } = await build();
    expect(summary.costs).toEqual({
      networkFeeLamports: CLAIM_LAMPORTS_PER_SIGNATURE,
      receiverTokenAccountRentLamports: TOKEN_RENT,
      unwrapAccountRentLamports: TOKEN_RENT,
      payerTotalLamports: CLAIM_LAMPORTS_PER_SIGNATURE + 2n * TOKEN_RENT,
      payerRequiredBalanceLamports: CLAIM_LAMPORTS_PER_SIGNATURE + 2n * TOKEN_RENT,
    });
    // The WSOL rent passes through to the receiver: only the fee and the coin account rent are lost.
    expect(summary.netLamports).toBe(PENDING_QUOTE - CLAIM_LAMPORTS_PER_SIGNATURE - TOKEN_RENT);
    expect(isPositionClaimWorthwhile(summary)).toBe(false);
    const skipped = await build({}, undefined, { ...noRetry, minNetLamports: 0n });
    expect(skipped.transaction).toBeNull();
    expect(skipped.skipReason).toBe('not_worthwhile');
  });

  it('costs only the fee and the pass-through rent once the receiver coin account exists', async () => {
    const mock = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees() },
      extra: { [receiverBase(RECEIVER).toBase58()]: tokenAccount(BASE_MINT(), RECEIVER, 0n) },
    });
    const { summary, transaction } = await build({}, mock);
    expect(summary.costs.receiverTokenAccountRentLamports).toBe(0n);
    expect(summary.costs.payerTotalLamports).toBe(CLAIM_LAMPORTS_PER_SIGNATURE + TOKEN_RENT);
    expect(summary.netLamports).toBe(PENDING_QUOTE - CLAIM_LAMPORTS_PER_SIGNATURE);
    expect(isPositionClaimWorthwhile(summary)).toBe(true);
    expect(isPositionClaimWorthwhile(summary, summary.netLamports)).toBe(false);
    // The idempotent creation stays: it is a no-op on-chain.
    expect(shape(transaction!)).toEqual(['ata:1', 'ata:1', 'claim', 'token:close']);
  });

  it('leaves the creator wallet read-only with a separate payer', async () => {
    const payer = Keypair.generate().publicKey;
    const { transaction, summary } = await build({ payer });
    const tx = transaction!;
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(summary.payer.equals(payer)).toBe(true);
    expect(isSigner(tx, CREATOR)).toBe(true);
    expect(isWritable(tx, CREATOR)).toBe(false);
    expect(isWritable(tx, RECEIVER)).toBe(true);
    expect(tx.instructions[0]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(tx.instructions[1]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(summary.costs.networkFeeLamports).toBe(2n * CLAIM_LAMPORTS_PER_SIGNATURE);
  });

  it('claims several positions in one transaction, each once, sorted by address', async () => {
    // The partner position re-keyed to the creator: a second position of the creator.
    const second = Keypair.generate();
    const secondNft = Keypair.generate().publicKey;
    const { derivePositionNftAccount } = await import('@meteora-ag/cp-amm-sdk');
    const secondNftAccount = derivePositionNftAccount(secondNft);
    const mock = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees() },
      extra: {
        [second.publicKey.toBase58()]: {
          data: await positionWith('partnerPosition', { nft_mint: secondNft }),
          owner: DAMM_V2_PROGRAM_ID,
          lamports: fx('partnerPosition').lamports,
          executable: false,
          rentEpoch: 0,
        },
        [secondNftAccount.toBase58()]: tokenAccount(secondNft, CREATOR, 1n, TOKEN_2022_PROGRAM_ID),
      },
    });
    const explicit = await build(
      { positions: [second.publicKey, key('creatorPosition'), second.publicKey] },
      mock,
    );
    const ordered = [second.publicKey.toBase58(), fx('creatorPosition').address].sort();
    expect(explicit.summary.positions.map((p) => p.position.toBase58())).toEqual(ordered);
    expect(explicit.summary.claimable.quote).toBe(PENDING_QUOTE + 830_889n);
    expect(shape(explicit.transaction!)).toEqual(['ata:1', 'ata:1', 'claim', 'claim', 'token:close']);
    const claims = explicit.transaction!.instructions.filter((ix) => ix.programId.equals(DAMM_V2_PROGRAM_ID));
    expect(claims.map((ix) => ix.keys[CLAIM_POSITION_FEE_ACCOUNTS.position]!.pubkey.toBase58())).toEqual(ordered);
    expect(
      claims.every((ix) => ix.keys[CLAIM_POSITION_FEE_ACCOUNTS.tokenBAccount]!.pubkey.equals(creatorWsol())),
    ).toBe(true);
  });

  it('refuses a position held by someone else, unknown, or on another pool', async () => {
    const notOwned = await build({ positions: [key('creatorPosition'), key('partnerPosition')] }).catch(
      (e: unknown) => e,
    );
    expect(notOwned).toBeInstanceOf(ClaimError);
    expect((notOwned as ClaimError).code).toBe('position_not_owned');

    const unknown = await build({ positions: [PublicKey.unique()] }).catch((e: unknown) => e);
    expect((unknown as ClaimError).code).toBe('position_not_found');

    const mock = mockConnection({
      overrides: {
        [fx('creatorPosition').address]: await positionWith('creatorPosition', {
          pool: Keypair.generate().publicKey,
        }),
      },
    });
    const other = await build({ positions: [key('creatorPosition')] }, mock).catch((e: unknown) => e);
    expect((other as ClaimError).code).toBe('position_mismatch');

    // The NFT moved to another wallet: not the creator's position any more.
    const moved = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees() },
      extra: {
        [fx('creatorPositionNftAccount').address]: tokenAccount(
          key('creatorPositionNftMint'),
          Keypair.generate().publicKey,
          1n,
          TOKEN_2022_PROGRAM_ID,
        ),
      },
    });
    const gone = await build({ positions: [key('creatorPosition')] }, moved).catch((e: unknown) => e);
    expect((gone as ClaimError).code).toBe('position_not_owned');
  });

  it('skips when the creator has no position or nothing is pending', async () => {
    const none = await build({}, mockConnection({ noNftAccounts: true }));
    expect(none.transaction).toBeNull();
    expect(none.skipReason).toBe('no_position');
    expect(none.summary.positions).toEqual([]);
    expect(none.summary.netLamports).toBe(0n);

    const empty = mockConnection();
    const nothing = await build({}, empty);
    expect(nothing.transaction).toBeNull();
    expect(nothing.skipReason).toBe('nothing_to_claim');
    expect(nothing.summary.claimable).toEqual({ base: 0n, quote: 0n });
    expect(nothing.summary.positions).toHaveLength(1);
    expect(empty.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('still claims coin fees alone (SOL side empty)', async () => {
    const mock = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees(0n, PENDING_BASE) },
    });
    const result = await build({}, mock);
    expect(result.transaction).not.toBeNull();
    expect(result.summary.claimable).toEqual({ base: PENDING_BASE, quote: 0n });
    expect(result.summary.receiverQuoteLamports).toBe(TOKEN_RENT);
    expect(isPositionClaimWorthwhile(result.summary)).toBe(false);
  });

  it('refuses a pool that has not migrated', async () => {
    const err = await build({ pool: key('test1Pool') }).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('not_migrated');
  });

  it('accepts a creator WSOL account holding WSOL: it reaches the receiver with the close', async () => {
    // Anyone can send 1 lamport of WSOL to the creator's account; refusing it would let anyone
    // block the pool's claims. The temporary account is closed to the receiver, so the WSOL is
    // simply received, and counted.
    const held = async () =>
      mockConnection({
        overrides: { [fx('creatorPosition').address]: await withPendingFees() },
        extra: { [creatorWsol().toBase58()]: tokenAccount(NATIVE_MINT, CREATOR, 5n) },
      });
    const result = await build({}, await held());
    expect(result.transaction).not.toBeNull();
    expect(result.transaction!.instructions.at(-1)!.keys[1]!.pubkey.equals(RECEIVER)).toBe(true);
    expect(result.summary.existingWsolLamports).toBe(5n);
    // An existing account costs no rent; its whole balance is handed over on close.
    expect(result.summary.costs.unwrapAccountRentLamports).toBe(0n);
    expect(result.summary.receiverQuoteLamports).toBe(PENDING_QUOTE + TOKEN_RENT + 5n);
    expect(result.summary.netLamports).toBe(
      PENDING_QUOTE + TOKEN_RENT + 5n - result.summary.costs.payerTotalLamports,
    );
    // The creator as its own receiver: the same.
    const own = await build({ receiver: CREATOR }, await held());
    expect(own.transaction!.instructions.at(-1)!.keys[1]!.pubkey.equals(CREATOR)).toBe(true);
    expect(own.summary.existingWsolLamports).toBe(5n);
    expect(own.summary.receiverQuoteLamports).toBe(PENDING_QUOTE + TOKEN_RENT + 5n);
    // An empty or new account: nothing counted.
    const empty = await build(
      {},
      mockConnection({ overrides: { [fx('creatorPosition').address]: await withPendingFees() } }),
    );
    expect(empty.summary.existingWsolLamports).toBe(0n);
  });

  it('pins the receiver with expectedReceiver and rejects unusable receivers', async () => {
    const vault = Keypair.generate().publicKey;
    const err = await build({ expectedReceiver: vault }).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('receiver_mismatch');
    const ok = await build({ receiver: vault, expectedReceiver: vault });
    expect(ok.summary.receiver.equals(vault)).toBe(true);
    const bad = await build({ receiver: PublicKey.default }).catch((e: unknown) => e);
    expect((bad as ClaimError).code).toBe('invalid_receiver');
  });

  it('rejects a signer that is not the pool creator and an unknown pool', async () => {
    const err = await build({ creator: PARTNER }).catch((e: unknown) => e);
    expect((err as ClaimError).code).toBe('not_pool_creator');
    const missing = await build({ pool: PublicKey.unique() }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(DbcReadError);
  });
});

describe('buildForgeCreatorPositionFeeClaimTx', () => {
  it('always sends the position fees to the FORGE multisig vault', async () => {
    const vault = Keypair.generate().publicKey;
    const mock = mockConnection({
      overrides: { [fx('creatorPosition').address]: await withPendingFees() },
    });
    const result = await buildForgeCreatorPositionFeeClaimTx(
      mock.connection,
      { pool: key('dbcPool'), creator: CREATOR },
      { ...noRetry, env: { FORGE_MULTISIG_VAULT: vault.toBase58() } },
    );
    expect(result.summary.receiver.equals(vault)).toBe(true);
    const close = result.transaction!.instructions.at(-1)!;
    expect(close.keys[1]!.pubkey.equals(vault)).toBe(true);
    const claim = result.transaction!.instructions[2]!;
    expect(claim.keys[CLAIM_POSITION_FEE_ACCOUNTS.tokenAAccount]!.pubkey.equals(receiverBase(vault))).toBe(
      true,
    );
  });

  it('refuses to build without FORGE_MULTISIG_VAULT', async () => {
    await expect(
      buildForgeCreatorPositionFeeClaimTx(
        mockConnection().connection,
        { pool: key('dbcPool'), creator: CREATOR },
        { ...noRetry, env: {} },
      ),
    ).rejects.toBeInstanceOf(ForgeAddressError);
  });
});
