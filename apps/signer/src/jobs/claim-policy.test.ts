/**
 * The creator claim policy against what core REALLY builds. `buildCreatorClaimTx` of @forge/core
 * runs here over real devnet accounts (__fixtures__/dbc-devnet-accounts.json, the capture core's
 * own tests use) through a mocked connection, with a fee payer that is not the receiver: the
 * signer's payer wallet on devnet (the creator wallets hold no SOL). That "exact" layout carries
 * an SPL self-transfer of the claimed amount, a close of the temporary WSOL account to the FEE
 * PAYER and a System transfer from the fee payer to the vault. Until the policy knew it, every
 * hourly FORGE creator claim was refused before signing ("token instruction not allowed") and no
 * creator fee was ever collected.
 */
import { readFileSync } from 'node:fs';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
  type Transaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildCreatorClaimTx } from '@forge/core';
import { JobError, assertCreatorClaimTx, type CreatorClaimExpectation } from './shared.js';

interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/dbc-devnet-accounts.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, FixtureAccount> };

/** Devnet throwaway creator wallet of the test 2 pool (recorded in the fixture). */
const FORGE_CREATOR = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
const TEST2_POOL = new PublicKey(FIXTURES.accounts.test2Pool!.address);
/** Creator share claimable on the test 2 pool (fixture). */
const TEST2_CREATOR_QUOTE = 1_737_887n;
const rent = (size: number) => (128 + size) * 6960;

/** Answers the account reads core and the DBC SDK make from the fixture; nothing else. */
function mockConnection(): Connection {
  const byAddress = new Map(Object.values(FIXTURES.accounts).map((a) => [a.address, a]));
  const lookup = (address: PublicKey): AccountInfo<Buffer> | null => {
    const a = byAddress.get(address.toBase58());
    return a
      ? {
          data: Buffer.from(a.data, 'base64'),
          owner: new PublicKey(a.owner),
          lamports: a.lamports,
          executable: false,
          rentEpoch: 0,
        }
      : null;
  };
  return {
    commitment: 'confirmed',
    rpcEndpoint: 'http://mock.invalid',
    getAccountInfoAndContext: async (address: PublicKey) => ({
      context: { slot: 1 },
      value: lookup(address),
    }),
    getAccountInfo: async (address: PublicKey) => lookup(address),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(lookup),
    getMinimumBalanceForRentExemption: async (size: number) => rent(size),
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500,
    }),
  } as unknown as Connection;
}

/** Instruction kinds of a claim transaction, in order. */
function shape(tx: Transaction): string[] {
  return tx.instructions.map((ix) => {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'ata';
    if (ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return 'claim';
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return ix.data[0] === 3 ? 'token:transfer' : ix.data[0] === 9 ? 'token:close' : 'token:?';
    }
    if (ix.programId.equals(SystemProgram.programId)) return 'system:transfer';
    return 'other';
  });
}

async function build(payer: PublicKey, receiver: PublicKey) {
  const built = await buildCreatorClaimTx(
    mockConnection(),
    { pool: TEST2_POOL, creator: FORGE_CREATOR, receiver, payer },
    { retry: { attempts: 1, baseDelayMs: 0 } },
  );
  const tx = built.transaction;
  if (!tx) throw new Error(`core built no transaction: ${built.skipReason}`);
  const expected: CreatorClaimExpectation = {
    dbcProgramId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    pool: TEST2_POOL,
    baseMint: built.summary.baseMint,
    creator: FORGE_CREATOR,
    feePayer: payer,
    receiver,
    claimedQuoteLamports: built.summary.claimable.quote,
  };
  return { tx, expected, summary: built.summary };
}

describe("creator claim policy against core's real transaction", () => {
  const vault = Keypair.generate().publicKey;

  it('accepts the exact layout when the signer payer wallet pays (devnet): self-transfer, close to the payer, forward from the payer', async () => {
    const payer = Keypair.generate().publicKey;
    const { tx, expected, summary } = await build(payer, vault);
    expect(summary.claimable.quote).toBe(TEST2_CREATOR_QUOTE);
    expect(summary.quoteIsExact).toBe(true);
    expect(shape(tx)).toEqual([
      'ata',
      'ata',
      'claim',
      'token:transfer',
      'token:close',
      'system:transfer',
    ]);
    // Closed to the fee payer, which forwards exactly the claimed amount to the vault.
    expect(tx.instructions[4]!.keys[1]!.pubkey.equals(payer)).toBe(true);
    expect(tx.instructions[5]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(() => assertCreatorClaimTx(tx, expected)).not.toThrow();
  });

  it('accepts the exact layout when the creator wallet pays its own claim', async () => {
    const { tx, expected } = await build(FORGE_CREATOR, vault);
    expect(shape(tx)).toEqual([
      'ata',
      'ata',
      'claim',
      'token:transfer',
      'token:close',
      'system:transfer',
    ]);
    expect(tx.instructions[4]!.keys[1]!.pubkey.equals(FORGE_CREATOR)).toBe(true);
    expect(() => assertCreatorClaimTx(tx, expected)).not.toThrow();
  });

  it('accepts the uncapped layout when the receiver pays (closed to the receiver, nothing forwarded)', async () => {
    const { tx, expected, summary } = await build(vault, vault);
    expect(summary.quoteIsExact).toBe(false);
    expect(shape(tx)).toEqual(['ata', 'ata', 'claim', 'token:close']);
    expect(() => assertCreatorClaimTx(tx, expected)).not.toThrow();
  });

  it('refuses the layout when the expectation names another fee payer or receiver', async () => {
    const payer = Keypair.generate().publicKey;
    const { tx, expected } = await build(payer, vault);
    expect(() => assertCreatorClaimTx(tx, { ...expected, feePayer: FORGE_CREATOR })).toThrow(
      JobError,
    );
    expect(() =>
      assertCreatorClaimTx(tx, { ...expected, receiver: Keypair.generate().publicKey }),
    ).toThrow(JobError);
    expect(() =>
      assertCreatorClaimTx(tx, { ...expected, claimedQuoteLamports: undefined }),
    ).toThrow(/claimed amount unknown/);
  });

  const deviations: Array<[string, (tx: Transaction, payer: PublicKey) => void, RegExp]> = [
    [
      'a self-transfer of another amount',
      (tx) => {
        const ix = tx.instructions[3]!;
        tx.instructions[3] = createTransferInstruction(
          ix.keys[0]!.pubkey,
          ix.keys[1]!.pubkey,
          ix.keys[2]!.pubkey,
          TEST2_CREATOR_QUOTE + 1n,
        );
      },
      /token transfer amount/,
    ],
    [
      'a token transfer to another account',
      (tx) => {
        const ix = tx.instructions[3]!;
        tx.instructions[3] = createTransferInstruction(
          ix.keys[0]!.pubkey,
          Keypair.generate().publicKey,
          ix.keys[2]!.pubkey,
          TEST2_CREATOR_QUOTE,
        );
      },
      /token transfer between unexpected accounts/,
    ],
    [
      'a token transfer authorized by the fee payer instead of the creator',
      (tx, payer) => {
        // (A stranger as authority is refused even earlier: it would have to sign.)
        const ix = tx.instructions[3]!;
        tx.instructions[3] = createTransferInstruction(
          ix.keys[0]!.pubkey,
          ix.keys[1]!.pubkey,
          payer,
          TEST2_CREATOR_QUOTE,
        );
      },
      /token transfer authority/,
    ],
    [
      'a second token transfer',
      (tx) => {
        tx.instructions.splice(4, 0, tx.instructions[3]!);
      },
      /more than one token transfer/,
    ],
    [
      'the self-transfer after the close',
      (tx) => {
        const [transfer] = tx.instructions.splice(3, 1);
        tx.instructions.splice(4, 0, transfer!);
      },
      /token transfer outside the claim and the close/,
    ],
    [
      'the temporary account closed to a stranger',
      (tx) => {
        const close = tx.instructions[4]!;
        tx.instructions[4] = createCloseAccountInstruction(
          close.keys[0]!.pubkey,
          Keypair.generate().publicKey,
          close.keys[2]!.pubkey,
        );
      },
      /closed to a non-receiver/,
    ],
    [
      'the forward sent from the creator while the account was closed to the payer',
      (tx) => {
        tx.instructions[5] = SystemProgram.transfer({
          fromPubkey: FORGE_CREATOR,
          toPubkey: vault,
          lamports: TEST2_CREATOR_QUOTE,
        });
      },
      /other than the close destination/,
    ],
    [
      'a forward of another amount',
      (tx, payer) => {
        tx.instructions[5] = SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: vault,
          lamports: TEST2_CREATOR_QUOTE - 1n,
        });
      },
      /forwarded amount differs/,
    ],
    [
      'the forward before the close',
      (tx) => {
        const [forward] = tx.instructions.splice(5, 1);
        tx.instructions.splice(4, 0, forward!);
      },
      /transfer before the temporary account is closed/,
    ],
    [
      'no forward at all',
      (tx) => {
        tx.instructions.pop();
      },
      /not forwarded/,
    ],
    [
      'a second forward',
      (tx) => {
        tx.add(tx.instructions[5]!);
      },
      /more than one transfer/,
    ],
  ];
  for (const [name, deviate, rule] of deviations) {
    it(`refuses ${name}`, async () => {
      const payer = Keypair.generate().publicKey;
      const { tx, expected } = await build(payer, vault);
      deviate(tx, payer);
      expect(() => assertCreatorClaimTx(tx, expected)).toThrow(rule);
    });
  }
});
