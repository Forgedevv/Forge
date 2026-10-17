/**
 * Jupiter referral fee claim (docs/METEORA.md "The platform fee", after graduation; D7, D8).
 *
 * After a coin graduates, trades go through Jupiter and FORGE's 50 bps integrator fee is collected
 * by the Jupiter referral program into token accounts of FORGE's referral account
 * (`FORGE_JUPITER_REFERRAL_ACCOUNT`), one per currency Jupiter collects in. Claiming is
 * permissionless: it moves a token account's balance to the referral account's `partner` (the
 * owner of the referral account: the FORGE multisig vault), minus the project's share, so the
 * fees reach the treasury and feed the buyback (D8). The fee payer only pays the network fee and,
 * the first time, the rent of the partner's token account.
 *
 * Built from the referral program's IDL (program `REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3`,
 * `@jup-ag/referral-sdk` 0.3.0) with raw instructions: the SDK pulls Anchor, too heavy for the
 * transaction core. Two collection accounts exist per mint and both are claimed when funded:
 * - `claim`: the classic referral token account, PDA `["referral_ata", referral account, mint]`;
 * - `claimV2`: the associated token account of the referral account (classic or Token-2022).
 * Account order, PDA seeds and Anchor discriminators are the IDL's; the unit tests pin them.
 *
 * The Jupiter Plugin (Ultra) only pays referral accounts of Jupiter's Ultra project
 * (`JUPITER_ULTRA_REFERRAL_PROJECT`), into their v2 collection accounts. `claim_v2` only accepts a
 * NAMED referral account at the PDA `["referral", project, name]` (created with
 * `initialize_referral_account_with_name`): an unnamed one (plain `initialize_referral_account`)
 * can never claim them. So the builder refuses a referral account of another project
 * (`project_mismatch`; `expectedProject` overrides the Ultra project), and builds a v2 claim only
 * for a named PDA (`referral_account_unnamed` or `referral_account_not_pda` otherwise).
 *
 * Mainnet only: the referral program and Jupiter's fee collection live on mainnet-beta. The
 * builder checks the connection's genesis hash and refuses any other cluster (`wrong_cluster`)
 * before it reads any account, so the project and name checks never run on devnet (where neither
 * the Ultra project nor Jupiter's fee collection exist): the devnet behaviour is unchanged.
 * The partner can be asserted (`expectedPartner` = the vault): a referral account owned by
 * anyone else is refused (`partner_mismatch`), fees would not reach the treasury.
 */
import { createHash } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type Commitment,
  type Connection,
} from '@solana/web3.js';
import { PaymentError, assertCluster } from './payments.js';
import { retryRpc, type RetryOptions } from './reads.js';

// ---------------------------------------------------------------------------------------------
// Constants (IDL)
// ---------------------------------------------------------------------------------------------

/** Jupiter referral program (mainnet-beta). */
export const JUPITER_REFERRAL_PROGRAM_ID = new PublicKey(
  'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3',
);

/**
 * Jupiter's Ultra project in the referral program (mainnet-beta). The Jupiter Plugin and Ultra
 * `/order` only collect the referral fee into referral accounts of this project.
 * @see https://developers.jup.ag/docs/ultra/add-fees-to-ultra.md
 */
export const JUPITER_ULTRA_REFERRAL_PROJECT = new PublicKey(
  'DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc',
);

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

export const JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR: Buffer = anchorDiscriminator(
  'account:ReferralAccount',
);
export const JUPITER_PROJECT_DISCRIMINATOR: Buffer = anchorDiscriminator('account:Project');
export const JUPITER_CLAIM_DISCRIMINATOR: Buffer = anchorDiscriminator('global:claim');
export const JUPITER_CLAIM_V2_DISCRIMINATOR: Buffer = anchorDiscriminator('global:claim_v2');
export const JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR: Buffer = anchorDiscriminator(
  'global:create_admin_token_account',
);

export type JupiterReferralClaimVersion = 'v1' | 'v2';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type JupiterReferralErrorCode =
  | 'wrong_cluster'
  | 'invalid_params'
  | 'referral_account_not_found'
  | 'not_a_referral_account'
  | 'project_not_found'
  | 'not_a_project'
  | 'mint_not_found'
  | 'not_a_mint'
  | 'partner_mismatch'
  /** The referral account belongs to another project than the expected one (Jupiter Ultra's). */
  | 'project_mismatch'
  /** Funds wait in the v2 collection account, but `claim_v2` needs a named referral account. */
  | 'referral_account_unnamed'
  /** Named, but not the PDA `["referral", project, name]` that `claim_v2` signs with. */
  | 'referral_account_not_pda';

export class JupiterReferralError extends Error {
  readonly code: JupiterReferralErrorCode;

  constructor(code: JupiterReferralErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JupiterReferralError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Accounts (pure decoding)
// ---------------------------------------------------------------------------------------------

export interface JupiterReferralAccount {
  /** Receives the claimed fees (FORGE: the multisig vault). */
  partner: PublicKey;
  project: PublicKey;
  shareBps: number;
  name: string | null;
}

export interface JupiterProject {
  base: PublicKey;
  admin: PublicKey;
  name: string;
  defaultShareBps: number;
}

function readString(data: Buffer, offset: number): { value: string; next: number } {
  if (data.length < offset + 4) throw new RangeError('string length out of bounds');
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  if (data.length < start + length) throw new RangeError('string out of bounds');
  return { value: data.subarray(start, start + length).toString('utf8'), next: start + length };
}

/** `ReferralAccount { partner, project, share_bps: u16, name: Option<String> }`. */
export function decodeJupiterReferralAccount(data: Buffer): JupiterReferralAccount {
  const fail = (reason: string) => new JupiterReferralError('not_a_referral_account', reason);
  if (data.length < 8 + 32 + 32 + 2 + 1) throw fail('referral account data too short');
  if (!data.subarray(0, 8).equals(JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR)) {
    throw fail('not a Jupiter referral account');
  }
  const partner = new PublicKey(data.subarray(8, 40));
  const project = new PublicKey(data.subarray(40, 72));
  const shareBps = data.readUInt16LE(72);
  const tag = data[74];
  let name: string | null = null;
  if (tag === 1) {
    try {
      name = readString(data, 75).value;
    } catch (error) {
      throw new JupiterReferralError('not_a_referral_account', 'referral account name invalid', {
        cause: error,
      });
    }
  } else if (tag !== 0) {
    throw fail('referral account name tag invalid');
  }
  return { partner, project, shareBps, name };
}

/** `Project { base, admin, name: String, default_share_bps: u16 }`. */
export function decodeJupiterProject(data: Buffer): JupiterProject {
  const fail = (reason: string, cause?: unknown) =>
    new JupiterReferralError('not_a_project', reason, { cause });
  if (data.length < 8 + 32 + 32 + 4 + 2) throw fail('project data too short');
  if (!data.subarray(0, 8).equals(JUPITER_PROJECT_DISCRIMINATOR)) {
    throw fail('not a Jupiter referral project');
  }
  const base = new PublicKey(data.subarray(8, 40));
  const admin = new PublicKey(data.subarray(40, 72));
  let name: { value: string; next: number };
  try {
    name = readString(data, 72);
  } catch (error) {
    throw fail('project name invalid', error);
  }
  if (data.length < name.next + 2) throw fail('project data too short');
  return { base, admin, name: name.value, defaultShareBps: data.readUInt16LE(name.next) };
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

/** Classic referral token account: PDA `["referral_ata", referral account, mint]`. */
export function deriveJupiterReferralTokenAccount(
  referralAccount: PublicKey,
  mint: PublicKey,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('referral_ata', 'utf8'), referralAccount.toBuffer(), mint.toBuffer()],
    programId,
  )[0];
}

/**
 * Named referral account: PDA `["referral", project, name]` (`initialize_referral_account_with_name`,
 * and the signer seeds of `claim_v2`). Throws when the name is longer than a seed (32 bytes).
 */
export function deriveJupiterReferralAccount(
  project: PublicKey,
  name: string,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('referral', 'utf8'), project.toBuffer(), Buffer.from(name, 'utf8')],
    programId,
  )[0];
}

/** V2 referral token account: the associated token account of the referral account. */
export function deriveJupiterReferralTokenAccountV2(
  referralAccount: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, referralAccount, true, tokenProgram);
}

/** Project authority: PDA `["project_authority", project.base]`. */
export function deriveJupiterProjectAuthority(
  base: PublicKey,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('project_authority', 'utf8'), base.toBuffer()],
    programId,
  )[0];
}

// ---------------------------------------------------------------------------------------------
// Instructions (pure)
// ---------------------------------------------------------------------------------------------

export interface JupiterClaimAccounts {
  /** Signer, pays the network fee (and the partner token account rent, the first time). */
  payer: PublicKey;
  project: PublicKey;
  admin: PublicKey;
  projectAdminTokenAccount: PublicKey;
  referralAccount: PublicKey;
  referralTokenAccount: PublicKey;
  partner: PublicKey;
  partnerTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

function assertTokenProgram(id: PublicKey): void {
  if (!id.equals(TOKEN_PROGRAM_ID) && !id.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new JupiterReferralError('invalid_params', 'tokenProgram is not a token program');
  }
}

/**
 * `claim` (v1) or `claim_v2`: the IDL's accounts in the IDL's order. The two differ only in the
 * position of the program accounts at the end (v1: associated token, system, token; v2: system,
 * token, associated token). No arguments.
 */
export function buildJupiterReferralClaimIx(
  accounts: JupiterClaimAccounts,
  version: JupiterReferralClaimVersion,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): TransactionInstruction {
  assertTokenProgram(accounts.tokenProgram);
  if (version !== 'v1' && version !== 'v2') {
    throw new JupiterReferralError('invalid_params', 'version must be v1 or v2');
  }
  const shared: AccountMeta[] = [
    { pubkey: accounts.payer, isSigner: true, isWritable: true },
    ro(accounts.project),
    ro(accounts.admin),
    rw(accounts.projectAdminTokenAccount),
    ro(accounts.referralAccount),
    rw(accounts.referralTokenAccount),
    ro(accounts.partner),
    rw(accounts.partnerTokenAccount),
    ro(accounts.mint),
  ];
  const programs =
    version === 'v1'
      ? [ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SystemProgram.programId), ro(accounts.tokenProgram)]
      : [ro(SystemProgram.programId), ro(accounts.tokenProgram), ro(ASSOCIATED_TOKEN_PROGRAM_ID)];
  return new TransactionInstruction({
    programId,
    keys: [...shared, ...programs],
    data: Buffer.from(
      version === 'v1' ? JUPITER_CLAIM_DISCRIMINATOR : JUPITER_CLAIM_V2_DISCRIMINATOR,
    ),
  });
}

export interface JupiterCreateAdminTokenAccountAccounts {
  project: PublicKey;
  /** Pays the rent of the admin token account (PDA of the project). */
  projectAuthority: PublicKey;
  admin: PublicKey;
  projectAdminTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

/** `create_admin_token_account`: needed once per mint before the first claim of that mint. */
export function buildJupiterCreateAdminTokenAccountIx(
  accounts: JupiterCreateAdminTokenAccountAccounts,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): TransactionInstruction {
  assertTokenProgram(accounts.tokenProgram);
  return new TransactionInstruction({
    programId,
    keys: [
      ro(accounts.project),
      rw(accounts.projectAuthority),
      ro(accounts.admin),
      rw(accounts.projectAdminTokenAccount),
      ro(accounts.mint),
      ro(SystemProgram.programId),
      ro(accounts.tokenProgram),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR),
  });
}

// ---------------------------------------------------------------------------------------------
// Transaction builder (network reads, mainnet-beta only)
// ---------------------------------------------------------------------------------------------

export interface BuildJupiterReferralClaimTxParams {
  connection: Connection;
  /** FORGE_JUPITER_REFERRAL_ACCOUNT (read through addresses.ts by the caller). */
  referralAccount: PublicKey;
  /** Currency to claim (e.g. wrapped SOL or USDC). */
  mint: PublicKey;
  /** Fee payer and only signer. */
  payer: PublicKey;
  /** When given, the referral account's partner must be this key (the FORGE multisig vault). */
  expectedPartner?: PublicKey;
  /**
   * The referral account's project must be this key. Default: `JUPITER_ULTRA_REFERRAL_PROJECT`,
   * the only project the Jupiter Plugin pays.
   */
  expectedProject?: PublicKey;
  commitment?: Commitment;
  retry?: RetryOptions;
  programId?: PublicKey;
}

export interface JupiterReferralClaimItem {
  version: JupiterReferralClaimVersion;
  referralTokenAccount: PublicKey;
  /** Raw units held by that referral token account when the transaction was built. */
  amount: bigint;
}

export interface JupiterReferralClaimSummary {
  referralAccount: PublicKey;
  partner: PublicKey;
  partnerTokenAccount: PublicKey;
  project: PublicKey;
  /** The project's admin (receives the project's share) and its authority PDA (pays its rent). */
  admin: PublicKey;
  projectAuthority: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** The funded referral token accounts claimed by the transaction (empty: nothing to claim). */
  claims: JupiterReferralClaimItem[];
  /** True when the transaction also creates the partner's token account (rent paid by `payer`). */
  createsPartnerTokenAccount: boolean;
  /** True when the transaction also creates the project admin's token account (program-paid). */
  createsAdminTokenAccount: boolean;
}

export interface JupiterReferralClaimTx {
  /** Unsigned legacy transaction (fee payer and blockhash set), or null when nothing is claimable. */
  transaction: Transaction | null;
  lastValidBlockHeight: number | null;
  summary: JupiterReferralClaimSummary;
}

function tokenAmount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  tokenProgram: PublicKey,
): bigint {
  if (!info || !info.owner.equals(tokenProgram)) return 0n;
  try {
    const account = unpackAccount(address, info, tokenProgram);
    return account.isFrozen ? 0n : account.amount;
  } catch {
    return 0n;
  }
}

/**
 * `claim_v2` signs with the PDA `["referral", project, name]`: refuses (typed error) a referral
 * account without a name, or one that is not that PDA, before a v2 claim is built.
 */
function assertClaimableV2(
  referralAccount: PublicKey,
  referral: JupiterReferralAccount,
  programId: PublicKey,
): void {
  if (referral.name === null) {
    throw new JupiterReferralError(
      'referral_account_unnamed',
      'the referral account has no name: claim_v2 needs a referral account created with a name ' +
        '(PDA ["referral", project, name]), so its v2 collection account cannot be claimed',
    );
  }
  let expected: PublicKey;
  try {
    expected = deriveJupiterReferralAccount(referral.project, referral.name, programId);
  } catch (error) {
    throw new JupiterReferralError(
      'referral_account_not_pda',
      'the referral account name is not a valid PDA seed, so claim_v2 cannot sign for it',
      { cause: error },
    );
  }
  if (!expected.equals(referralAccount)) {
    throw new JupiterReferralError(
      'referral_account_not_pda',
      'the referral account is not the PDA ["referral", project, name] that claim_v2 signs with',
    );
  }
}

/**
 * Reads the referral account, its project, the mint and the collection accounts, and builds the
 * claim(s) of every funded collection account of `mint` to the partner's associated token account.
 * Mainnet-beta only (genesis hash). Returns `transaction: null` when nothing is claimable.
 * The referral account must belong to `expectedProject` (default: Jupiter's Ultra project), and a
 * funded v2 collection account is only claimed for a named referral PDA (typed errors otherwise).
 */
export async function buildJupiterReferralClaimTx(
  p: BuildJupiterReferralClaimTxParams,
): Promise<JupiterReferralClaimTx> {
  const { connection } = p;
  const commitment = p.commitment ?? 'confirmed';
  const programId = p.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const expectedProject = p.expectedProject ?? JUPITER_ULTRA_REFERRAL_PROJECT;
  const retry = p.retry ?? {};
  if (p.payer.equals(p.referralAccount) || p.mint.equals(p.referralAccount)) {
    throw new JupiterReferralError('invalid_params', 'payer, mint and referral account must differ');
  }
  try {
    await assertCluster(connection, 'mainnet-beta', retry);
  } catch (error) {
    if (error instanceof PaymentError && error.code === 'wrong_cluster') {
      throw new JupiterReferralError(
        'wrong_cluster',
        'Jupiter referral claims only exist on mainnet-beta',
        { cause: error },
      );
    }
    throw error;
  }

  const [referralInfo, mintInfo] = await retryRpc(
    () => connection.getMultipleAccountsInfo([p.referralAccount, p.mint], commitment),
    retry,
  );
  if (!referralInfo) {
    throw new JupiterReferralError('referral_account_not_found', 'referral account not found');
  }
  if (!referralInfo.owner.equals(programId)) {
    throw new JupiterReferralError(
      'not_a_referral_account',
      'referral account is not owned by the Jupiter referral program',
    );
  }
  const referral = decodeJupiterReferralAccount(Buffer.from(referralInfo.data));
  if (p.expectedPartner && !referral.partner.equals(p.expectedPartner)) {
    throw new JupiterReferralError(
      'partner_mismatch',
      'the referral account partner is not the expected receiver',
    );
  }
  if (!referral.project.equals(expectedProject)) {
    throw new JupiterReferralError(
      'project_mismatch',
      `the referral account belongs to project ${referral.project.toBase58()}, not to the ` +
        `expected project ${expectedProject.toBase58()} (Jupiter Ultra by default)`,
    );
  }
  if (!mintInfo) throw new JupiterReferralError('mint_not_found', 'mint not found');
  const tokenProgram = mintInfo.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new JupiterReferralError('not_a_mint', 'mint is not owned by a token program');
  }

  const projectInfo = await retryRpc(
    () => connection.getAccountInfo(referral.project, commitment),
    retry,
  );
  if (!projectInfo) throw new JupiterReferralError('project_not_found', 'project not found');
  if (!projectInfo.owner.equals(programId)) {
    throw new JupiterReferralError('not_a_project', 'project is not owned by the referral program');
  }
  const project = decodeJupiterProject(Buffer.from(projectInfo.data));

  const v1Account = deriveJupiterReferralTokenAccount(p.referralAccount, p.mint, programId);
  const v2Account = deriveJupiterReferralTokenAccountV2(p.referralAccount, p.mint, tokenProgram);
  const partnerTokenAccount = getAssociatedTokenAddressSync(
    p.mint,
    referral.partner,
    true,
    tokenProgram,
  );
  const adminTokenAccount = getAssociatedTokenAddressSync(
    p.mint,
    project.admin,
    true,
    tokenProgram,
  );
  const [v1Info, v2Info, partnerInfo, adminInfo] = await retryRpc(
    () =>
      connection.getMultipleAccountsInfo(
        [v1Account, v2Account, partnerTokenAccount, adminTokenAccount],
        commitment,
      ),
    retry,
  );
  const claims: JupiterReferralClaimItem[] = [];
  const v1Amount = tokenAmount(v1Account, v1Info ?? null, tokenProgram);
  if (v1Amount > 0n) claims.push({ version: 'v1', referralTokenAccount: v1Account, amount: v1Amount });
  const v2Amount = tokenAmount(v2Account, v2Info ?? null, tokenProgram);
  if (v2Amount > 0n) {
    assertClaimableV2(p.referralAccount, referral, programId);
    claims.push({ version: 'v2', referralTokenAccount: v2Account, amount: v2Amount });
  }

  const projectAuthority = deriveJupiterProjectAuthority(project.base, programId);
  const summary: JupiterReferralClaimSummary = {
    referralAccount: p.referralAccount,
    partner: referral.partner,
    partnerTokenAccount,
    project: referral.project,
    admin: project.admin,
    projectAuthority,
    mint: p.mint,
    tokenProgram,
    claims,
    createsPartnerTokenAccount: claims.length > 0 && !partnerInfo,
    createsAdminTokenAccount: claims.length > 0 && !adminInfo,
  };
  if (claims.length === 0) return { transaction: null, lastValidBlockHeight: null, summary };

  const transaction = new Transaction();
  if (summary.createsPartnerTokenAccount) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        p.payer,
        partnerTokenAccount,
        referral.partner,
        p.mint,
        tokenProgram,
      ),
    );
  }
  if (summary.createsAdminTokenAccount) {
    transaction.add(
      buildJupiterCreateAdminTokenAccountIx(
        {
          project: referral.project,
          projectAuthority,
          admin: project.admin,
          projectAdminTokenAccount: adminTokenAccount,
          mint: p.mint,
          tokenProgram,
        },
        programId,
      ),
    );
  }
  for (const claim of claims) {
    transaction.add(
      buildJupiterReferralClaimIx(
        {
          payer: p.payer,
          project: referral.project,
          admin: project.admin,
          projectAdminTokenAccount: adminTokenAccount,
          referralAccount: p.referralAccount,
          referralTokenAccount: claim.referralTokenAccount,
          partner: referral.partner,
          partnerTokenAccount,
          mint: p.mint,
          tokenProgram,
        },
        claim.version,
        programId,
      ),
    );
  }
  const latest = await retryRpc(() => connection.getLatestBlockhash(commitment), retry);
  transaction.feePayer = p.payer;
  transaction.recentBlockhash = latest.blockhash;
  return { transaction, lastValidBlockHeight: latest.lastValidBlockHeight, summary };
}
