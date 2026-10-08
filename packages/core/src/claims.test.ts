import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaimError, buildCreatorClaimTx, buildPartnerClaimTx } from './claims.js';
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

function mockConnection(overrides: Record<string, Buffer> = {}) {
  const byAddress = new Map(Object.values(FIXTURES.accounts).map((a) => [a.address, a]));
  const getAccountInfoAndContext = vi.fn(async (address: PublicKey) => {
    const a = byAddress.get(address.toBase58());
    const value: AccountInfo<Buffer> | null = a
      ? {
          data: overrides[a.address] ?? Buffer.from(a.data, 'base64'),
          owner: new PublicKey(a.owner),
          lamports: a.lamports,
          executable: false,
          rentEpoch: 0,
        }
      : null;
    return { context: { slot: 1 }, value };
  });
  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 500,
  }));
  const connection = {
    commitment: 'confirmed',
    rpcEndpoint: 'http://mock.invalid',
    getAccountInfoAndContext,
    getLatestBlockhash,
  } as unknown as Connection;
  return { connection, getLatestBlockhash };
}

const noRetry = { retry: { attempts: 1, baseDelayMs: 0 } };

describe('buildCreatorClaimTx', () => {
  it('builds an unsigned claim of the creator share to the receiver', async () => {
    const { connection } = mockConnection();
    const result = await buildCreatorClaimTx(
      connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    );
    expect(result.summary.kind).toBe('creator');
    expect(result.summary.claimable).toEqual({ base: 0n, quote: 1_737_887n });
    expect(result.summary.receiver.equals(RECEIVER)).toBe(true);
    expect(result.summary.payer.equals(FORGE_CREATOR)).toBe(true);
    expect(result.lastValidBlockHeight).toBe(500);

    const tx = result.transaction!;
    expect(tx.feePayer?.equals(FORGE_CREATOR)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);

    const claimIx = tx.instructions.find((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    );
    expect(claimIx).toBeDefined();
    expect(claimIx!.keys.some((k) => k.pubkey.equals(FORGE_CREATOR) && k.isSigner)).toBe(true);
    expect(claimIx!.keys.some((k) => k.pubkey.equals(key('test2Pool')))).toBe(true);
    // The temporary WSOL account of the creator is closed to the receiver.
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, FORGE_CREATOR, true, TOKEN_PROGRAM_ID);
    const close = tx.instructions.at(-1)!;
    expect(close.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(close.keys[0]!.pubkey.equals(wsol)).toBe(true);
    expect(close.keys[1]!.pubkey.equals(RECEIVER)).toBe(true);
  });

  it('honours an explicit payer', async () => {
    const payer = Keypair.generate().publicKey;
    const result = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER, payer },
      noRetry,
    );
    expect(result.transaction!.feePayer?.equals(payer)).toBe(true);
  });

  it('returns no transaction when nothing is claimable', async () => {
    const { connection, getLatestBlockhash } = mockConnection();
    const result = await buildCreatorClaimTx(
      connection,
      { pool: key('test1Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    );
    expect(result.transaction).toBeNull();
    expect(result.lastValidBlockHeight).toBeNull();
    expect(result.summary.claimable).toEqual({ base: 0n, quote: 0n });
    expect(getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('rejects a signer that is not the pool creator', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: PARTNER, receiver: RECEIVER },
      noRetry,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as ClaimError).code).toBe('not_pool_creator');
  });

  it('rejects the system program as receiver', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: PublicKey.default },
      noRetry,
    ).catch((e) => e);
    expect((err as ClaimError).code).toBe('invalid_receiver');
  });

  it('rejects a pool that is not SOL-quoted', async () => {
    const config = Buffer.from(fx('test2Config').data, 'base64');
    const at = config.indexOf(NATIVE_MINT.toBuffer());
    expect(at).toBeGreaterThan(0);
    Keypair.generate().publicKey.toBuffer().copy(config, at);
    const { connection } = mockConnection({ [fx('test2Config').address]: config });
    const err = await buildCreatorClaimTx(
      connection,
      { pool: key('test2Pool'), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    ).catch((e) => e);
    expect((err as ClaimError).code).toBe('unsupported_quote_mint');
  });

  it('fails clearly on an unknown pool', async () => {
    const err = await buildCreatorClaimTx(
      mockConnection().connection,
      { pool: PublicKey.unique(), creator: FORGE_CREATOR, receiver: RECEIVER },
      noRetry,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DbcReadError);
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
    expect(result.summary.claimable).toEqual({ base: 0n, quote: 30_000_000n });
    expect(result.summary.receiver.equals(PARTNER)).toBe(true);
    const tx = result.transaction!;
    expect(tx.feePayer?.equals(PARTNER)).toBe(true);
    const claimIx = tx.instructions.find((ix) =>
      ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    );
    expect(claimIx!.keys.some((k) => k.pubkey.equals(PARTNER) && k.isSigner)).toBe(true);
    expect(claimIx!.keys.some((k) => k.pubkey.equals(key('test3Config')))).toBe(true);
  });

  it('sends the partner share to an explicit receiver (e.g. the FORGE multisig vault)', async () => {
    const result = await buildPartnerClaimTx(
      mockConnection().connection,
      { pool: key('test1Pool'), feeClaimer: PARTNER, receiver: RECEIVER },
      noRetry,
    );
    expect(result.summary.claimable.quote).toBe(1_600_000n);
    const close = result.transaction!.instructions.at(-1)!;
    expect(close.keys[1]!.pubkey.equals(RECEIVER)).toBe(true);
  });

  it('rejects a signer that is not the config fee claimer', async () => {
    const err = await buildPartnerClaimTx(
      mockConnection().connection,
      { pool: key('test3Pool'), feeClaimer: FORGE_CREATOR },
      noRetry,
    ).catch((e) => e);
    expect((err as ClaimError).code).toBe('not_fee_claimer');
  });
});
