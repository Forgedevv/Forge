import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH } from './payments.js';
import {
  JUPITER_CLAIM_DISCRIMINATOR,
  JUPITER_CLAIM_V2_DISCRIMINATOR,
  JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR,
  JUPITER_PROJECT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
  JUPITER_REFERRAL_PROGRAM_ID,
  JupiterReferralError,
  buildJupiterCreateAdminTokenAccountIx,
  buildJupiterReferralClaimIx,
  buildJupiterReferralClaimTx,
  decodeJupiterProject,
  decodeJupiterReferralAccount,
  deriveJupiterProjectAuthority,
  deriveJupiterReferralTokenAccount,
  deriveJupiterReferralTokenAccountV2,
} from './jupiter-referral.js';

const key = () => Keypair.generate().publicKey;

function encodeReferralAccount(a: {
  partner: PublicKey;
  project: PublicKey;
  shareBps: number;
  name: string | null;
}): Buffer {
  const name =
    a.name === null
      ? Buffer.from([0])
      : Buffer.concat([
          Buffer.from([1]),
          (() => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(Buffer.byteLength(a.name!));
            return b;
          })(),
          Buffer.from(a.name, 'utf8'),
        ]);
  const share = Buffer.alloc(2);
  share.writeUInt16LE(a.shareBps);
  return Buffer.concat([
    JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
    a.partner.toBuffer(),
    a.project.toBuffer(),
    share,
    name,
  ]);
}

function encodeProject(p: {
  base: PublicKey;
  admin: PublicKey;
  name: string;
  defaultShareBps: number;
}): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(Buffer.byteLength(p.name));
  const share = Buffer.alloc(2);
  share.writeUInt16LE(p.defaultShareBps);
  return Buffer.concat([
    JUPITER_PROJECT_DISCRIMINATOR,
    p.base.toBuffer(),
    p.admin.toBuffer(),
    len,
    Buffer.from(p.name, 'utf8'),
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

describe('IDL constants', () => {
  it('pins the program id and the Anchor discriminators of the referral IDL', () => {
    expect(JUPITER_REFERRAL_PROGRAM_ID.toBase58()).toBe(
      'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3',
    );
    // sha256("global:claim")[0..8], the standard Anchor value of a `claim` instruction.
    expect([...JUPITER_CLAIM_DISCRIMINATOR]).toEqual([62, 198, 214, 193, 213, 159, 108, 210]);
    expect([...JUPITER_CLAIM_V2_DISCRIMINATOR]).toEqual([229, 87, 46, 162, 21, 157, 231, 114]);
    expect([...JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR]).toEqual([
      102, 86, 232, 205, 140, 111, 8, 116,
    ]);
    expect([...JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR]).toEqual([237, 162, 80, 78, 196, 233, 91, 2]);
    expect([...JUPITER_PROJECT_DISCRIMINATOR]).toEqual([205, 168, 189, 202, 181, 247, 142, 19]);
  });

  it('derives the collection accounts and the project authority with the IDL seeds', () => {
    const referral = key();
    const mint = key();
    const [v1] = PublicKey.findProgramAddressSync(
      [Buffer.from('referral_ata'), referral.toBuffer(), mint.toBuffer()],
      JUPITER_REFERRAL_PROGRAM_ID,
    );
    expect(deriveJupiterReferralTokenAccount(referral, mint).equals(v1)).toBe(true);
    expect(
      deriveJupiterReferralTokenAccountV2(referral, mint, TOKEN_PROGRAM_ID).equals(
        getAssociatedTokenAddressSync(mint, referral, true, TOKEN_PROGRAM_ID),
      ),
    ).toBe(true);
    const base = key();
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from('project_authority'), base.toBuffer()],
      JUPITER_REFERRAL_PROGRAM_ID,
    );
    expect(deriveJupiterProjectAuthority(base).equals(authority)).toBe(true);
  });
});

describe('account decoding', () => {
  it('decodes a referral account with and without a name', () => {
    const partner = key();
    const project = key();
    const named = decodeJupiterReferralAccount(
      encodeReferralAccount({ partner, project, shareBps: 8_000, name: 'forge' }),
    );
    expect(named).toEqual({ partner, project, shareBps: 8_000, name: 'forge' });
    const unnamed = decodeJupiterReferralAccount(
      encodeReferralAccount({ partner, project, shareBps: 1, name: null }),
    );
    expect(unnamed.name).toBeNull();
  });

  it('decodes a project', () => {
    const base = key();
    const admin = key();
    expect(decodeJupiterProject(encodeProject({ base, admin, name: 'jup', defaultShareBps: 80 }))).toEqual(
      { base, admin, name: 'jup', defaultShareBps: 80 },
    );
  });

  it('refuses other data', () => {
    expect(() => decodeJupiterReferralAccount(Buffer.alloc(80))).toThrow(JupiterReferralError);
    const referral = encodeReferralAccount({ partner: key(), project: key(), shareBps: 1, name: null });
    expect(() => decodeJupiterProject(Buffer.concat([referral, Buffer.alloc(8)]))).toThrow(
      /not a Jupiter referral project/,
    );
    const truncated = encodeReferralAccount({ partner: key(), project: key(), shareBps: 1, name: 'x' });
    expect(() => decodeJupiterReferralAccount(truncated.subarray(0, truncated.length - 1))).toThrow(
      JupiterReferralError,
    );
  });
});

describe('claim instructions', () => {
  const accounts = {
    payer: key(),
    project: key(),
    admin: key(),
    projectAdminTokenAccount: key(),
    referralAccount: key(),
    referralTokenAccount: key(),
    partner: key(),
    partnerTokenAccount: key(),
    mint: key(),
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  it('lays the v1 claim accounts out in the IDL order', () => {
    const ix = buildJupiterReferralClaimIx(accounts, 'v1');
    expect(ix.programId.equals(JUPITER_REFERRAL_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ix.data).equals(JUPITER_CLAIM_DISCRIMINATOR)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [
        accounts.payer,
        accounts.project,
        accounts.admin,
        accounts.projectAdminTokenAccount,
        accounts.referralAccount,
        accounts.referralTokenAccount,
        accounts.partner,
        accounts.partnerTokenAccount,
        accounts.mint,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
      ].map((k) => k.toBase58()),
    );
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],
      [false, false],
      [false, false],
      [false, true],
      [false, false],
      [false, true],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it('lays the v2 claim accounts out with the program accounts in the v2 order', () => {
    const ix = buildJupiterReferralClaimIx({ ...accounts, tokenProgram: TOKEN_2022_PROGRAM_ID }, 'v2');
    expect(Buffer.from(ix.data).equals(JUPITER_CLAIM_V2_DISCRIMINATOR)).toBe(true);
    expect(ix.keys.slice(9).map((k) => k.pubkey.toBase58())).toEqual(
      [SystemProgram.programId, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID].map((k) =>
        k.toBase58(),
      ),
    );
  });

  it('refuses a non token program', () => {
    expect(() =>
      buildJupiterReferralClaimIx({ ...accounts, tokenProgram: SystemProgram.programId }, 'v1'),
    ).toThrow(/tokenProgram/);
  });

  it('builds create_admin_token_account in the IDL order', () => {
    const ix = buildJupiterCreateAdminTokenAccountIx({
      project: accounts.project,
      projectAuthority: accounts.partner,
      admin: accounts.admin,
      projectAdminTokenAccount: accounts.projectAdminTokenAccount,
      mint: accounts.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    expect(Buffer.from(ix.data).equals(JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [
        accounts.project,
        accounts.partner,
        accounts.admin,
        accounts.projectAdminTokenAccount,
        accounts.mint,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ].map((k) => k.toBase58()),
    );
    expect(ix.keys.some((k) => k.isSigner)).toBe(false);
  });
});

describe('buildJupiterReferralClaimTx', () => {
  const vault = key();
  const referralAccount = key();
  const project = key();
  const base = key();
  const admin = key();
  const mint = key();
  const payer = key();

  function fakeConnection(options: {
    genesis?: string;
    v1Amount?: bigint;
    v2Amount?: bigint;
    partnerAtaExists?: boolean;
    adminAtaExists?: boolean;
    partner?: PublicKey;
  }): Connection {
    const partner = options.partner ?? vault;
    const v1 = deriveJupiterReferralTokenAccount(referralAccount, mint);
    const v2 = deriveJupiterReferralTokenAccountV2(referralAccount, mint, TOKEN_PROGRAM_ID);
    const partnerAta = getAssociatedTokenAddressSync(mint, partner, true, TOKEN_PROGRAM_ID);
    const adminAta = getAssociatedTokenAddressSync(mint, admin, true, TOKEN_PROGRAM_ID);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>([
      [
        referralAccount.toBase58(),
        {
          owner: JUPITER_REFERRAL_PROGRAM_ID,
          data: encodeReferralAccount({ partner, project, shareBps: 8_000, name: 'forge' }),
        },
      ],
      [
        project.toBase58(),
        {
          owner: JUPITER_REFERRAL_PROGRAM_ID,
          data: encodeProject({ base, admin, name: 'jupiter', defaultShareBps: 80 }),
        },
      ],
      [mint.toBase58(), { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) }],
    ]);
    if (options.v1Amount) {
      accounts.set(v1.toBase58(), {
        owner: TOKEN_PROGRAM_ID,
        data: encodeTokenAccount(mint, JUPITER_REFERRAL_PROGRAM_ID, options.v1Amount),
      });
    }
    if (options.v2Amount) {
      accounts.set(v2.toBase58(), {
        owner: TOKEN_PROGRAM_ID,
        data: encodeTokenAccount(mint, referralAccount, options.v2Amount),
      });
    }
    if (options.partnerAtaExists) {
      accounts.set(partnerAta.toBase58(), {
        owner: TOKEN_PROGRAM_ID,
        data: encodeTokenAccount(mint, partner, 0n),
      });
    }
    if (options.adminAtaExists) {
      accounts.set(adminAta.toBase58(), {
        owner: TOKEN_PROGRAM_ID,
        data: encodeTokenAccount(mint, admin, 0n),
      });
    }
    const info = (k: PublicKey) => {
      const a = accounts.get(k.toBase58());
      return a ? { owner: a.owner, data: a.data, lamports: 1, executable: false } : null;
    };
    return {
      getGenesisHash: async () => options.genesis ?? CLUSTER_GENESIS_HASH['mainnet-beta'],
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
      getAccountInfo: async (k: PublicKey) => info(k),
      getLatestBlockhash: async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 500 }),
    } as unknown as Connection;
  }

  it('refuses any cluster but mainnet-beta', async () => {
    await expect(
      buildJupiterReferralClaimTx({
        connection: fakeConnection({ genesis: CLUSTER_GENESIS_HASH.devnet, v1Amount: 5n }),
        referralAccount,
        mint,
        payer,
      }),
    ).rejects.toMatchObject({ code: 'wrong_cluster' });
  });

  it('returns no transaction when nothing is collected', async () => {
    const r = await buildJupiterReferralClaimTx({
      connection: fakeConnection({}),
      referralAccount,
      mint,
      payer,
      expectedPartner: vault,
    });
    expect(r.transaction).toBeNull();
    expect(r.summary.claims).toEqual([]);
    expect(r.summary.partner.equals(vault)).toBe(true);
  });

  it('claims both collection accounts to the vault and creates the missing token accounts', async () => {
    const r = await buildJupiterReferralClaimTx({
      connection: fakeConnection({ v1Amount: 1_000n, v2Amount: 2_000n }),
      referralAccount,
      mint,
      payer,
      expectedPartner: vault,
    });
    expect(r.transaction).not.toBeNull();
    expect(r.lastValidBlockHeight).toBe(500);
    expect(r.summary.claims.map((c) => [c.version, c.amount])).toEqual([
      ['v1', 1_000n],
      ['v2', 2_000n],
    ]);
    expect(r.summary.createsPartnerTokenAccount).toBe(true);
    expect(r.summary.createsAdminTokenAccount).toBe(true);
    const ixs = r.transaction!.instructions;
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      JUPITER_REFERRAL_PROGRAM_ID.toBase58(),
      JUPITER_REFERRAL_PROGRAM_ID.toBase58(),
      JUPITER_REFERRAL_PROGRAM_ID.toBase58(),
    ]);
    const partnerAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID);
    // The partner token account is created for the vault, paid by the payer.
    expect(ixs[0]!.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(ixs[0]!.keys[1]!.pubkey.equals(partnerAta)).toBe(true);
    expect(ixs[0]!.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(Buffer.from(ixs[1]!.data).equals(JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR)).toBe(true);
    // Every claim pays out to the vault's token account; the payer is the only signer.
    for (const ix of ixs.slice(2)) {
      expect(ix.keys[6]!.pubkey.equals(vault)).toBe(true);
      expect(ix.keys[7]!.pubkey.equals(partnerAta)).toBe(true);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
        payer.toBase58(),
      ]);
    }
    expect(r.transaction!.feePayer?.equals(payer)).toBe(true);
  });

  it('skips the account creations when they exist and claims one account only', async () => {
    const r = await buildJupiterReferralClaimTx({
      connection: fakeConnection({ v2Amount: 7n, partnerAtaExists: true, adminAtaExists: true }),
      referralAccount,
      mint,
      payer,
    });
    expect(r.transaction!.instructions).toHaveLength(1);
    expect(Buffer.from(r.transaction!.instructions[0]!.data).equals(JUPITER_CLAIM_V2_DISCRIMINATOR)).toBe(
      true,
    );
  });

  it('refuses a referral account owned by another partner', async () => {
    await expect(
      buildJupiterReferralClaimTx({
        connection: fakeConnection({ v1Amount: 5n, partner: key() }),
        referralAccount,
        mint,
        payer,
        expectedPartner: vault,
      }),
    ).rejects.toMatchObject({ code: 'partner_mismatch' });
  });

  it('refuses a missing or foreign referral account', async () => {
    await expect(
      buildJupiterReferralClaimTx({
        connection: fakeConnection({}),
        referralAccount: key(),
        mint,
        payer,
      }),
    ).rejects.toMatchObject({ code: 'referral_account_not_found' });
  });
});
