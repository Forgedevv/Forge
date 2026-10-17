import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import {
  MAX_METEORA_REFERRAL_SEED_BYTES,
  METEORA_REFERRAL_ACCOUNT_SEED,
  METEORA_REFERRAL_SETUP_COMPUTE_UNITS,
  MeteoraReferralError,
  TOKEN_INITIALIZE_ACCOUNT3_TAG,
  assertMeteoraReferralSeed,
  buildCreateMeteoraReferralAccountIxs,
  buildCreateMeteoraReferralAccountTx,
  deriveMeteoraReferralAccount,
  inspectMeteoraReferralAccount,
  readMeteoraReferralAccount,
} from './meteora-referral.js';

const key = () => Keypair.generate().publicKey;
const RENT = 2_039_280n;
const BLOCKHASH = key().toBase58();

function tokenAccountData(fields: {
  mint?: PublicKey;
  owner: PublicKey;
  amount?: bigint;
  state?: number;
  delegate?: PublicKey;
  closeAuthority?: PublicKey;
}): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: fields.mint ?? NATIVE_MINT,
      owner: fields.owner,
      amount: fields.amount ?? 0n,
      delegateOption: fields.delegate ? 1 : 0,
      delegate: fields.delegate ?? PublicKey.default,
      state: fields.state ?? 1,
      isNativeOption: 1,
      isNative: RENT,
      delegatedAmount: 0n,
      closeAuthorityOption: fields.closeAuthority ? 1 : 0,
      closeAuthority: fields.closeAuthority ?? PublicKey.default,
    },
    data,
  );
  return data;
}

function info(owner: PublicKey, data: Buffer, lamports = Number(RENT)): AccountInfo<Buffer> {
  return { owner, data, lamports, executable: false };
}

describe('deriveMeteoraReferralAccount', () => {
  it('is createWithSeed(payer, seed, SPL Token), with the default seed', async () => {
    const payer = key();
    const expected = await PublicKey.createWithSeed(
      payer,
      METEORA_REFERRAL_ACCOUNT_SEED,
      TOKEN_PROGRAM_ID,
    );
    expect(deriveMeteoraReferralAccount(payer).equals(expected)).toBe(true);
    const other = await PublicKey.createWithSeed(payer, 'x', TOKEN_PROGRAM_ID);
    expect(deriveMeteoraReferralAccount(payer, 'x').equals(other)).toBe(true);
    expect(deriveMeteoraReferralAccount(payer, 'x').equals(expected)).toBe(false);
    expect(Buffer.byteLength(METEORA_REFERRAL_ACCOUNT_SEED)).toBeLessThanOrEqual(
      MAX_METEORA_REFERRAL_SEED_BYTES,
    );
  });

  it('refuses an empty seed, a seed over 32 bytes and control characters', () => {
    expect(() => assertMeteoraReferralSeed('')).toThrow(MeteoraReferralError);
    expect(() => assertMeteoraReferralSeed('a'.repeat(33))).toThrow(/33 bytes/);
    expect(() => assertMeteoraReferralSeed('a'.repeat(32))).not.toThrow();
    // 11 three-byte characters: 33 bytes.
    expect(() => assertMeteoraReferralSeed('€'.repeat(11))).toThrow(/bytes/);
    expect(() => assertMeteoraReferralSeed('seed\n')).toThrow(/control/);
    expect(() => deriveMeteoraReferralAccount(key(), '')).toThrow(MeteoraReferralError);
  });
});

describe('buildCreateMeteoraReferralAccountIxs', () => {
  const payer = key();
  const owner = key();

  it('builds the exact createAccountWithSeed then InitializeAccount3 of a wrapped-SOL account of the owner', () => {
    const built = buildCreateMeteoraReferralAccountIxs({ payer, owner, rentLamports: RENT });
    expect(built.seed).toBe(METEORA_REFERRAL_ACCOUNT_SEED);
    expect(built.account.equals(deriveMeteoraReferralAccount(payer))).toBe(true);
    expect(built.instructions).toHaveLength(2);
    const [create, initialize] = built.instructions;

    const expectedCreate = SystemProgram.createAccountWithSeed({
      fromPubkey: payer,
      basePubkey: payer,
      seed: METEORA_REFERRAL_ACCOUNT_SEED,
      newAccountPubkey: built.account,
      lamports: Number(RENT),
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    });
    expect(Buffer.from(create!.data).equals(Buffer.from(expectedCreate.data))).toBe(true);
    expect(create!.keys).toEqual(expectedCreate.keys);
    expect(SystemInstruction.decodeInstructionType(create!)).toBe('CreateWithSeed');
    const decoded = SystemInstruction.decodeCreateWithSeed(create!);
    expect(decoded.fromPubkey.equals(payer)).toBe(true);
    expect(decoded.basePubkey.equals(payer)).toBe(true);
    expect(decoded.newAccountPubkey.equals(built.account)).toBe(true);
    expect(decoded.seed).toBe(METEORA_REFERRAL_ACCOUNT_SEED);
    expect(decoded.lamports).toBe(Number(RENT));
    expect(decoded.space).toBe(165);
    expect(decoded.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    // The payer signs (from = base); the new account does not.
    expect(create!.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      payer.toBase58(),
    ]);

    expect(initialize!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect([...initialize!.data]).toEqual([TOKEN_INITIALIZE_ACCOUNT3_TAG, ...owner.toBytes()]);
    expect(TOKEN_INITIALIZE_ACCOUNT3_TAG).toBe(18);
    expect(initialize!.keys).toEqual([
      { pubkey: built.account, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    ]);
  });

  it('never derives the associated account, and refuses a payer-owner, a bad rent or the default owner', () => {
    const built = buildCreateMeteoraReferralAccountIxs({ payer, owner, rentLamports: RENT });
    expect(built.account.equals(getAssociatedTokenAddressSync(NATIVE_MINT, owner, true))).toBe(
      false,
    );
    expect(() =>
      buildCreateMeteoraReferralAccountIxs({ payer, owner: payer, rentLamports: RENT }),
    ).toThrow(/payer must not be the owner/);
    expect(() => buildCreateMeteoraReferralAccountIxs({ payer, owner, rentLamports: 0n })).toThrow(
      /rentLamports/,
    );
    expect(() =>
      buildCreateMeteoraReferralAccountIxs({ payer, owner, rentLamports: 1n << 60n }),
    ).toThrow(/too large/);
    expect(() =>
      buildCreateMeteoraReferralAccountIxs({ payer, owner: PublicKey.default, rentLamports: RENT }),
    ).toThrow(/default key/);
    expect(() =>
      buildCreateMeteoraReferralAccountIxs({
        payer,
        owner,
        rentLamports: RENT,
        seed: 'a'.repeat(40),
      }),
    ).toThrow(MeteoraReferralError);
  });
});

describe('buildCreateMeteoraReferralAccountTx', () => {
  const payer = key();
  const owner = key();
  const params = {
    payer,
    owner,
    rentLamports: RENT,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 900,
  };

  it('sets the fee payer and the blockhash, with the payer as only signer, and is deterministic', () => {
    const a = buildCreateMeteoraReferralAccountTx(params);
    const b = buildCreateMeteoraReferralAccountTx(params);
    expect(a.transaction.feePayer!.equals(payer)).toBe(true);
    expect(a.transaction.recentBlockhash).toBe(BLOCKHASH);
    expect(a.lastValidBlockHeight).toBe(900);
    expect(a.transaction.instructions).toHaveLength(2);
    const message = a.transaction.compileMessage();
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0]!.equals(payer)).toBe(true);
    expect(a.transaction.serializeMessage().equals(b.transaction.serializeMessage())).toBe(true);
    expect(a.account.equals(deriveMeteoraReferralAccount(payer))).toBe(true);
    // The owner is only in the instruction data: not an account of the transaction.
    expect(message.accountKeys.some((k) => k.equals(owner))).toBe(false);
  });

  it('puts the compute budget pair first with a priced quote, nothing at a zero price', () => {
    const priced = buildCreateMeteoraReferralAccountTx({
      ...params,
      priorityFee: { computeUnitLimit: METEORA_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 1_000 },
    });
    expect(priced.transaction.instructions).toHaveLength(4);
    const [limit, price] = priced.transaction.instructions;
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit!.data[0]).toBe(2);
    expect(Buffer.from(limit!.data).readUInt32LE(1)).toBe(METEORA_REFERRAL_SETUP_COMPUTE_UNITS);
    expect(price!.data[0]).toBe(3);
    expect(Buffer.from(price!.data).readBigUInt64LE(1)).toBe(1_000n);
    const free = buildCreateMeteoraReferralAccountTx({
      ...params,
      priorityFee: { computeUnitLimit: METEORA_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 0 },
    });
    expect(free.transaction.instructions).toHaveLength(2);
  });

  it('refuses a missing blockhash or a bad block height', () => {
    expect(() => buildCreateMeteoraReferralAccountTx({ ...params, blockhash: '' })).toThrow(
      /blockhash/,
    );
    expect(() =>
      buildCreateMeteoraReferralAccountTx({ ...params, lastValidBlockHeight: -1 }),
    ).toThrow(/lastValidBlockHeight/);
  });
});

describe('inspectMeteoraReferralAccount', () => {
  const payer = key();
  const owner = key();
  const address = deriveMeteoraReferralAccount(payer);

  it('absent without an account, ready for a standalone wrapped-SOL account of the owner', () => {
    expect(inspectMeteoraReferralAccount(address, null, { owner })).toEqual({ status: 'absent' });
    const ready = inspectMeteoraReferralAccount(
      address,
      info(TOKEN_PROGRAM_ID, tokenAccountData({ owner, amount: 7n, closeAuthority: owner })),
      { owner },
    );
    expect(ready).toEqual({ status: 'ready', lamports: RENT, amount: 7n });
  });

  it('reports every mismatch with its reason, never a creation', () => {
    const reason = (i: AccountInfo<Buffer> | null, at: PublicKey = address) => {
      const r = inspectMeteoraReferralAccount(at, i, { owner });
      return r.status === 'mismatch' ? r.reason : r.status;
    };
    expect(reason(info(SystemProgram.programId, Buffer.alloc(0), 5_000))).toBe(
      'not_a_token_account',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, Buffer.alloc(10)))).toBe('not_a_token_account');
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner, mint: key() })))).toBe(
      'wrong_mint',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner: key() })))).toBe('wrong_owner');
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner })), ata)).toBe(
      'associated_account',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner, state: 2 })))).toBe('frozen');
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner, delegate: key() })))).toBe(
      'delegated',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, tokenAccountData({ owner, closeAuthority: key() })))).toBe(
      'close_authority',
    );
    const detail = inspectMeteoraReferralAccount(
      address,
      info(TOKEN_PROGRAM_ID, tokenAccountData({ owner: payer })),
      {
        owner,
      },
    );
    expect(detail).toMatchObject({
      status: 'mismatch',
      detail: expect.stringContaining(payer.toBase58()),
    });
  });

  it('reads the account through a connection', async () => {
    const data = tokenAccountData({ owner });
    const connection = {
      getAccountInfo: async (k: PublicKey) =>
        k.equals(address) ? info(TOKEN_PROGRAM_ID, data) : null,
    } as unknown as Connection;
    expect(await readMeteoraReferralAccount({ connection, address, owner })).toMatchObject({
      status: 'ready',
    });
    expect(await readMeteoraReferralAccount({ connection, address: key(), owner })).toEqual({
      status: 'absent',
    });
  });
});
