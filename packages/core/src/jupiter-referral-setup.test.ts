import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH } from './payments.js';
import {
  JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR,
  JUPITER_PROJECT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_SIZE,
  JUPITER_REFERRAL_NAME_MAX_BYTES,
  JUPITER_REFERRAL_NAME_MAX_CHARS,
  JUPITER_REFERRAL_PROGRAM_ID,
  JUPITER_REFERRAL_SETUP_COMPUTE_UNITS,
  JUPITER_ULTRA_REFERRAL_PROJECT,
  JupiterReferralError,
  assertJupiterReferralName,
  buildJupiterInitializeReferralAccountWithNameIx,
  buildJupiterReferralSetupTx,
  buildJupiterReferralTokenAccountV2Ix,
  deriveJupiterReferralAccount,
  deriveJupiterReferralTokenAccountV2,
  encodeJupiterReferralName,
  inspectJupiterReferralAccount,
  inspectJupiterReferralTokenAccountV2,
  readJupiterReferralSetup,
} from './jupiter-referral.js';

const key = () => Keypair.generate().publicKey;
const BLOCKHASH = key().toBase58();

function encodeReferralAccount(a: {
  partner: PublicKey;
  project: PublicKey;
  shareBps?: number;
  name: string | null;
}): Buffer {
  const share = Buffer.alloc(2);
  share.writeUInt16LE(a.shareBps ?? 8_000);
  let name: Buffer;
  if (a.name === null) {
    name = Buffer.from([0]);
  } else {
    const bytes = Buffer.from(a.name, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    name = Buffer.concat([Buffer.from([1]), len, bytes]);
  }
  const data = Buffer.concat([
    JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
    a.partner.toBuffer(),
    a.project.toBuffer(),
    share,
    name,
  ]);
  // The program allocates `ReferralAccount::LEN`; the tail is zero padding.
  return Buffer.concat([data, Buffer.alloc(JUPITER_REFERRAL_ACCOUNT_SIZE - data.length)]);
}

function encodeProject(base: PublicKey, admin: PublicKey): Buffer {
  const name = Buffer.from('jupiter', 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  const share = Buffer.alloc(2);
  share.writeUInt16LE(80);
  return Buffer.concat([
    JUPITER_PROJECT_DISCRIMINATOR,
    base.toBuffer(),
    admin.toBuffer(),
    len,
    name,
    share,
  ]);
}

function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function info(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 1, executable: false };
}

describe('program facts', () => {
  it('pins the discriminator, the account size and the name limits of initialize_referral_account_with_name', () => {
    expect([...JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR]).toEqual([
      241, 190, 107, 26, 244, 236, 119, 229,
    ]);
    expect(
      createHash('sha256')
        .update('global:initialize_referral_account_with_name')
        .digest()
        .subarray(0, 8)
        .equals(JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR),
    ).toBe(true);
    // ReferralAccount::LEN = 8 + 32 + 32 + 50 * 4 + 2 (lib.rs).
    expect(JUPITER_REFERRAL_ACCOUNT_SIZE).toBe(274);
    // `params.name.chars().count() < 20`; a PDA seed is at most 32 bytes.
    expect(JUPITER_REFERRAL_NAME_MAX_CHARS).toBe(19);
    expect(JUPITER_REFERRAL_NAME_MAX_BYTES).toBe(32);
  });
});

describe('assertJupiterReferralName / encodeJupiterReferralName', () => {
  it('accepts 1 to 19 printable characters within 32 bytes', () => {
    expect(assertJupiterReferralName('forge')).toBe('forge');
    expect(assertJupiterReferralName('a'.repeat(19))).toHaveLength(19);
    expect(assertJupiterReferralName('FORGE_launch-2026')).toBe('FORGE_launch-2026');
    // 10 three-byte characters: 10 chars, 30 bytes.
    expect(assertJupiterReferralName('€'.repeat(10))).toHaveLength(10);
  });

  it('refuses an empty name, 20 characters, 33 bytes, whitespace and control characters', () => {
    const code = (name: string) => {
      try {
        assertJupiterReferralName(name);
      } catch (error) {
        return error instanceof JupiterReferralError ? error.code : 'other';
      }
      return 'accepted';
    };
    expect(code('')).toBe('invalid_params');
    expect(code('a'.repeat(20))).toBe('invalid_params');
    // 11 three-byte characters: 11 chars (allowed), 33 bytes (refused).
    expect(code('€'.repeat(11))).toBe('invalid_params');
    expect(code('forge app')).toBe('invalid_params');
    expect(code('forge\n')).toBe('invalid_params');
    expect(code('forge​')).toBe('invalid_params');
    expect(code(' forge')).toBe('invalid_params');
    expect(() => assertJupiterReferralName('a'.repeat(20))).toThrow(/20 characters/);
  });

  it('encodes the Borsh string: u32 length then the bytes', () => {
    expect([...encodeJupiterReferralName('forge')]).toEqual([5, 0, 0, 0, 102, 111, 114, 103, 101]);
    expect([...encodeJupiterReferralName('€')]).toEqual([3, 0, 0, 0, 0xe2, 0x82, 0xac]);
    expect(() => encodeJupiterReferralName('')).toThrow(JupiterReferralError);
  });
});

describe('buildJupiterInitializeReferralAccountWithNameIx', () => {
  const payer = key();
  const partner = key();
  const project = JUPITER_ULTRA_REFERRAL_PROJECT;
  const referralAccount = deriveJupiterReferralAccount(project, 'forge');

  it("builds the IDL's accounts in order (payer the only signer, partner read-only) and the data", () => {
    const ix = buildJupiterInitializeReferralAccountWithNameIx(
      { payer, partner, project, referralAccount },
      'forge',
    );
    expect(ix.programId.equals(JUPITER_REFERRAL_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toEqual([
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: partner, isSigner: false, isWritable: false },
      { pubkey: project, isSigner: false, isWritable: false },
      { pubkey: referralAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    expect([...ix.data]).toEqual([
      ...JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR,
      5,
      0,
      0,
      0,
      102,
      111,
      114,
      103,
      101,
    ]);
    const custom = key();
    const other = buildJupiterInitializeReferralAccountWithNameIx(
      {
        payer,
        partner,
        project,
        referralAccount: deriveJupiterReferralAccount(project, 'forge', custom),
      },
      'forge',
      custom,
    );
    expect(other.programId.equals(custom)).toBe(true);
  });

  it('refuses a referral account that is not the PDA of the name, coinciding keys and a bad name', () => {
    expect(() =>
      buildJupiterInitializeReferralAccountWithNameIx(
        { payer, partner, project, referralAccount: key() },
        'forge',
      ),
    ).toThrow(/PDA/);
    expect(() =>
      buildJupiterInitializeReferralAccountWithNameIx(
        {
          payer,
          partner,
          project,
          referralAccount: deriveJupiterReferralAccount(project, 'other'),
        },
        'forge',
      ),
    ).toThrow(/PDA/);
    expect(() =>
      buildJupiterInitializeReferralAccountWithNameIx(
        { payer, partner: payer, project, referralAccount },
        'forge',
      ),
    ).toThrow(/must differ/);
    expect(() =>
      buildJupiterInitializeReferralAccountWithNameIx(
        { payer, partner, project, referralAccount },
        'a'.repeat(20),
      ),
    ).toThrow(JupiterReferralError);
  });
});

describe('buildJupiterReferralTokenAccountV2Ix', () => {
  const payer = key();
  const referralAccount = deriveJupiterReferralAccount(JUPITER_ULTRA_REFERRAL_PROJECT, 'forge');

  it('is the idempotent creation of the referral account associated token account, paid by the payer', () => {
    for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const mint = key();
      const built = buildJupiterReferralTokenAccountV2Ix({
        payer,
        referralAccount,
        mint,
        tokenProgram,
      });
      const ata = getAssociatedTokenAddressSync(mint, referralAccount, true, tokenProgram);
      expect(built.tokenAccount.equals(ata)).toBe(true);
      expect(
        built.tokenAccount.equals(
          deriveJupiterReferralTokenAccountV2(referralAccount, mint, tokenProgram),
        ),
      ).toBe(true);
      const expected = createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ata,
        referralAccount,
        mint,
        tokenProgram,
      );
      expect(built.instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
      expect([...built.instruction.data]).toEqual([1]);
      expect(built.instruction.keys).toEqual(expected.keys);
      expect(built.instruction.keys[0]).toEqual({
        pubkey: payer,
        isSigner: true,
        isWritable: true,
      });
      expect(built.instruction.keys[2]).toEqual({
        pubkey: referralAccount,
        isSigner: false,
        isWritable: false,
      });
    }
  });

  it('refuses a non-token program and coinciding keys', () => {
    expect(() =>
      buildJupiterReferralTokenAccountV2Ix({
        payer,
        referralAccount,
        mint: key(),
        tokenProgram: key(),
      }),
    ).toThrow(/token program/);
    expect(() =>
      buildJupiterReferralTokenAccountV2Ix({
        payer: referralAccount,
        referralAccount,
        mint: key(),
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
    ).toThrow(/must differ/);
  });
});

describe('buildJupiterReferralSetupTx', () => {
  const payer = key();
  const partner = key();
  const usdc = key();
  const base = {
    payer,
    partner,
    name: 'forge',
    createReferralAccount: true,
    tokenAccounts: [
      { mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID },
      { mint: usdc, tokenProgram: TOKEN_PROGRAM_ID },
    ],
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 700,
  };

  it('composes the initialization then one collection account per mint, Ultra project by default, payer only signer', () => {
    const built = buildJupiterReferralSetupTx(base);
    const referralAccount = deriveJupiterReferralAccount(JUPITER_ULTRA_REFERRAL_PROJECT, 'forge');
    expect(built.project.equals(JUPITER_ULTRA_REFERRAL_PROJECT)).toBe(true);
    expect(built.referralAccount.equals(referralAccount)).toBe(true);
    expect(built.name).toBe('forge');
    expect(built.lastValidBlockHeight).toBe(700);
    expect(built.tokenAccounts.map((t) => t.tokenAccount.toBase58())).toEqual([
      deriveJupiterReferralTokenAccountV2(
        referralAccount,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ).toBase58(),
      deriveJupiterReferralTokenAccountV2(referralAccount, usdc, TOKEN_PROGRAM_ID).toBase58(),
    ]);
    const tx = built.transaction;
    expect(tx.feePayer!.equals(payer)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      JUPITER_REFERRAL_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    ]);
    expect(
      Buffer.from(tx.instructions[0]!.data).equals(
        buildJupiterInitializeReferralAccountWithNameIx(
          { payer, partner, project: JUPITER_ULTRA_REFERRAL_PROJECT, referralAccount },
          'forge',
        ).data,
      ),
    ).toBe(true);
    const message = tx.compileMessage();
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0]!.equals(payer)).toBe(true);
    const partnerIndex = message.accountKeys.findIndex((k) => k.equals(partner));
    expect(partnerIndex).toBeGreaterThan(0);
    expect(message.isAccountWritable(partnerIndex)).toBe(false);
    expect(message.isAccountSigner(partnerIndex)).toBe(false);
    // Deterministic: the same inputs give the same bytes.
    expect(
      buildJupiterReferralSetupTx(base)
        .transaction.serializeMessage()
        .equals(tx.serializeMessage()),
    ).toBe(true);
  });

  it('builds only the collection accounts when the referral account exists, with the compute budget first', () => {
    const built = buildJupiterReferralSetupTx({
      ...base,
      createReferralAccount: false,
      tokenAccounts: [{ mint: usdc, tokenProgram: TOKEN_2022_PROGRAM_ID }],
      priorityFee: { computeUnitLimit: JUPITER_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 2_500 },
    });
    const ixs = built.transaction.instructions;
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ixs[0]!.data[0]).toBe(2);
    expect(Buffer.from(ixs[0]!.data).readUInt32LE(1)).toBe(JUPITER_REFERRAL_SETUP_COMPUTE_UNITS);
    expect(ixs[1]!.data[0]).toBe(3);
    expect(Buffer.from(ixs[1]!.data).readBigUInt64LE(1)).toBe(2_500n);
    expect(ixs[2]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[2]!.keys[5]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const free = buildJupiterReferralSetupTx({
      ...base,
      priorityFee: { computeUnitLimit: JUPITER_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 0 },
    });
    expect(free.transaction.instructions).toHaveLength(3);
  });

  it('refuses an empty plan, a duplicate mint, a bad name, a bad blockhash and a custom project PDA mismatch', () => {
    expect(() =>
      buildJupiterReferralSetupTx({ ...base, createReferralAccount: false, tokenAccounts: [] }),
    ).toThrow(/nothing to set up/);
    expect(() =>
      buildJupiterReferralSetupTx({
        ...base,
        tokenAccounts: [
          { mint: usdc, tokenProgram: TOKEN_PROGRAM_ID },
          { mint: usdc, tokenProgram: TOKEN_PROGRAM_ID },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => buildJupiterReferralSetupTx({ ...base, name: 'forge app' })).toThrow(
      JupiterReferralError,
    );
    expect(() => buildJupiterReferralSetupTx({ ...base, blockhash: '' })).toThrow(/blockhash/);
    expect(() => buildJupiterReferralSetupTx({ ...base, lastValidBlockHeight: 1.5 })).toThrow(
      /lastValidBlockHeight/,
    );
    const project = key();
    const custom = buildJupiterReferralSetupTx({ ...base, project });
    expect(custom.referralAccount.equals(deriveJupiterReferralAccount(project, 'forge'))).toBe(
      true,
    );
    expect(custom.transaction.instructions[0]!.keys[2]!.pubkey.equals(project)).toBe(true);
  });
});

describe('inspection', () => {
  const partner = key();
  const project = JUPITER_ULTRA_REFERRAL_PROJECT;
  const referralAccount = deriveJupiterReferralAccount(project, 'forge');
  const expected = { partner, project, name: 'forge' };

  it('inspects the referral account: absent, ready, or a mismatch with its reason', () => {
    expect(inspectJupiterReferralAccount(null, expected)).toEqual({ status: 'absent' });
    const ready = inspectJupiterReferralAccount(
      info(JUPITER_REFERRAL_PROGRAM_ID, encodeReferralAccount({ partner, project, name: 'forge' })),
      expected,
    );
    expect(ready).toMatchObject({ status: 'ready', account: { shareBps: 8_000, name: 'forge' } });
    const reason = (i: AccountInfo<Buffer>) => {
      const r = inspectJupiterReferralAccount(i, expected);
      return r.status === 'mismatch' ? r.reason : r.status;
    };
    expect(reason(info(SystemProgram.programId, Buffer.alloc(0)))).toBe('not_a_referral_account');
    expect(reason(info(JUPITER_REFERRAL_PROGRAM_ID, Buffer.alloc(20)))).toBe(
      'not_a_referral_account',
    );
    expect(
      reason(
        info(
          JUPITER_REFERRAL_PROGRAM_ID,
          encodeReferralAccount({ partner: key(), project, name: 'forge' }),
        ),
      ),
    ).toBe('partner_mismatch');
    expect(
      reason(
        info(
          JUPITER_REFERRAL_PROGRAM_ID,
          encodeReferralAccount({ partner, project: key(), name: 'forge' }),
        ),
      ),
    ).toBe('project_mismatch');
    expect(
      reason(
        info(JUPITER_REFERRAL_PROGRAM_ID, encodeReferralAccount({ partner, project, name: null })),
      ),
    ).toBe('name_mismatch');
    const named = inspectJupiterReferralAccount(
      info(JUPITER_REFERRAL_PROGRAM_ID, encodeReferralAccount({ partner, project, name: 'other' })),
      expected,
    );
    expect(named).toMatchObject({
      status: 'mismatch',
      reason: 'name_mismatch',
      detail: expect.stringContaining('other'),
    });
    const custom = key();
    expect(
      inspectJupiterReferralAccount(
        info(custom, encodeReferralAccount({ partner, project, name: 'forge' })),
        {
          ...expected,
          programId: custom,
        },
      ),
    ).toMatchObject({ status: 'ready' });
  });

  it('inspects a v2 collection account', () => {
    const mint = key();
    const ata = deriveJupiterReferralTokenAccountV2(referralAccount, mint, TOKEN_PROGRAM_ID);
    const e = { referralAccount, mint, tokenProgram: TOKEN_PROGRAM_ID };
    expect(inspectJupiterReferralTokenAccountV2(ata, null, e)).toEqual({ status: 'absent' });
    expect(
      inspectJupiterReferralTokenAccountV2(
        ata,
        info(TOKEN_PROGRAM_ID, encodeTokenAccount(mint, referralAccount, 9n)),
        e,
      ),
    ).toEqual({ status: 'ready', amount: 9n });
    const reason = (i: AccountInfo<Buffer>) => {
      const r = inspectJupiterReferralTokenAccountV2(ata, i, e);
      return r.status === 'mismatch' ? r.reason : r.status;
    };
    expect(reason(info(TOKEN_2022_PROGRAM_ID, encodeTokenAccount(mint, referralAccount, 0n)))).toBe(
      'not_a_token_account',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, Buffer.alloc(3)))).toBe('not_a_token_account');
    expect(reason(info(TOKEN_PROGRAM_ID, encodeTokenAccount(key(), referralAccount, 0n)))).toBe(
      'wrong_mint',
    );
    expect(reason(info(TOKEN_PROGRAM_ID, encodeTokenAccount(mint, key(), 0n)))).toBe('wrong_owner');
  });
});

describe('readJupiterReferralSetup', () => {
  const partner = key();
  const admin = key();
  const base = key();
  const project = JUPITER_ULTRA_REFERRAL_PROJECT;
  const referralAccount = deriveJupiterReferralAccount(project, 'forge');
  const usdc = key();
  const t22 = key();

  function fakeConnection(options: {
    genesis?: string;
    project?: boolean;
    referral?: Buffer;
    mints?: Map<string, PublicKey>;
    tokenAccounts?: Map<string, AccountInfo<Buffer>>;
  }): Connection {
    const accounts = new Map<string, AccountInfo<Buffer>>();
    if (options.project !== false) {
      accounts.set(
        project.toBase58(),
        info(JUPITER_REFERRAL_PROGRAM_ID, encodeProject(base, admin)),
      );
    }
    if (options.referral)
      accounts.set(referralAccount.toBase58(), info(JUPITER_REFERRAL_PROGRAM_ID, options.referral));
    const mints =
      options.mints ??
      new Map([
        [NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID],
        [usdc.toBase58(), TOKEN_PROGRAM_ID],
        [t22.toBase58(), TOKEN_2022_PROGRAM_ID],
      ]);
    for (const [mint, owner] of mints) accounts.set(mint, info(owner, Buffer.alloc(82)));
    for (const [address, i] of options.tokenAccounts ?? []) accounts.set(address, i);
    return {
      getGenesisHash: async () => options.genesis ?? CLUSTER_GENESIS_HASH['mainnet-beta'],
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((k) => accounts.get(k.toBase58()) ?? null),
    } as unknown as Connection;
  }

  it('refuses any cluster but mainnet-beta before reading anything', async () => {
    let reads = 0;
    const connection = {
      getGenesisHash: async () => CLUSTER_GENESIS_HASH.devnet,
      getMultipleAccountsInfo: async () => {
        reads++;
        return [];
      },
    } as unknown as Connection;
    await expect(
      readJupiterReferralSetup({ connection, partner, name: 'forge', mints: [NATIVE_MINT] }),
    ).rejects.toMatchObject({ code: 'wrong_cluster' });
    expect(reads).toBe(0);
  });

  it('reports every account absent on a fresh setup, with the token program of each mint', async () => {
    const state = await readJupiterReferralSetup({
      connection: fakeConnection({}),
      partner,
      name: 'forge',
      mints: [NATIVE_MINT, usdc, t22],
    });
    expect(state.project.equals(project)).toBe(true);
    expect(state.projectAccount.admin.equals(admin)).toBe(true);
    expect(state.referralAccount.equals(referralAccount)).toBe(true);
    expect(state.referral).toEqual({ status: 'absent' });
    expect(state.tokenAccounts.map((t) => [t.tokenProgram.toBase58(), t.status.status])).toEqual([
      [TOKEN_PROGRAM_ID.toBase58(), 'absent'],
      [TOKEN_PROGRAM_ID.toBase58(), 'absent'],
      [TOKEN_2022_PROGRAM_ID.toBase58(), 'absent'],
    ]);
    expect(
      state.tokenAccounts[2]!.tokenAccount.equals(
        deriveJupiterReferralTokenAccountV2(referralAccount, t22, TOKEN_2022_PROGRAM_ID),
      ),
    ).toBe(true);
  });

  it('reports what exists (ready) and what does not match', async () => {
    const wsolAta = deriveJupiterReferralTokenAccountV2(
      referralAccount,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    );
    const usdcAta = deriveJupiterReferralTokenAccountV2(referralAccount, usdc, TOKEN_PROGRAM_ID);
    const state = await readJupiterReferralSetup({
      connection: fakeConnection({
        referral: encodeReferralAccount({ partner, project, name: 'forge' }),
        tokenAccounts: new Map([
          [
            wsolAta.toBase58(),
            info(TOKEN_PROGRAM_ID, encodeTokenAccount(NATIVE_MINT, referralAccount, 0n)),
          ],
          [usdcAta.toBase58(), info(TOKEN_PROGRAM_ID, encodeTokenAccount(usdc, key(), 0n))],
        ]),
      }),
      partner,
      name: 'forge',
      mints: [NATIVE_MINT, usdc],
    });
    expect(state.referral.status).toBe('ready');
    expect(state.tokenAccounts[0]!.status).toEqual({ status: 'ready', amount: 0n });
    expect(state.tokenAccounts[1]!.status).toMatchObject({
      status: 'mismatch',
      reason: 'wrong_owner',
    });
    const foreign = await readJupiterReferralSetup({
      connection: fakeConnection({
        referral: encodeReferralAccount({ partner: key(), project, name: 'forge' }),
      }),
      partner,
      name: 'forge',
      mints: [NATIVE_MINT],
    });
    expect(foreign.referral).toMatchObject({ status: 'mismatch', reason: 'partner_mismatch' });
  });

  it('fails closed on a missing project, a missing mint, a non-mint, a bad name or a duplicate mint', async () => {
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({ project: false }),
        partner,
        name: 'forge',
        mints: [NATIVE_MINT],
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({}),
        partner,
        name: 'forge',
        mints: [key()],
      }),
    ).rejects.toMatchObject({ code: 'mint_not_found' });
    const notMint = key();
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({
          mints: new Map([[notMint.toBase58(), SystemProgram.programId]]),
        }),
        partner,
        name: 'forge',
        mints: [notMint],
      }),
    ).rejects.toMatchObject({ code: 'not_a_mint' });
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({}),
        partner,
        name: 'bad name',
        mints: [NATIVE_MINT],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({}),
        partner,
        name: 'forge',
        mints: [usdc, usdc],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      readJupiterReferralSetup({
        connection: fakeConnection({}),
        partner,
        name: 'forge',
        mints: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
