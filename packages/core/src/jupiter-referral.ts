/**
 * Jupiter referral fee claim (docs/METEORA.md "The platform fee", after graduation; D7, D8).
 *
 * After a coin graduates, trades go through Jupiter and FORGE's 50 bps integrator fee is collected
 * by the Jupiter referral program into token accounts of FORGE's referral account
 * (`FORGE_JUPITER_REFERRAL_ACCOUNT`), one per currency Jupiter collects in. Claiming is
 * permissionless: it moves a token account's balance to the referral account's `partner` (the
 * owner of the referral account: the FORGE revenue wallet since D34), minus the project's share.
 * The revenue job of the signer then converts the balances to SOL and forwards them to the vault,
 * which feeds the buyback (D8). The fee payer only pays the network fee and, the first time, the
 * rent of the partner's token account.
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
 * The partner can be asserted (`expectedPartner` = the revenue wallet): a referral account owned by
 * anyone else is refused (`partner_mismatch`), fees would not reach the revenue wallet.
 *
 * The last section builds the one-off SETUP of that referral account (the signer's
 * `--setup-revenue-referrals` command): `initialize_referral_account_with_name` under the Ultra
 * project with the revenue wallet as partner, and the v2 collection accounts of the currencies
 * Jupiter collects in. Only the payer signs; the program facts are listed there.
 */
import { sha256 } from '@noble/hashes/sha2';
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
import {
  estimatePriorityFee,
  priorityFeeInstructions,
  resolvePriorityFeePolicy,
  writableAccountsOf,
  type PriorityFeeQuote,
  type PriorityFeeSetting,
} from './priority-fee.js';
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
  return Buffer.from(sha256(new TextEncoder().encode(name))).subarray(0, 8);
}

export const JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR: Buffer =
  anchorDiscriminator('account:ReferralAccount');
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
  /** Receives the claimed fees (FORGE: the revenue wallet, D34). */
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
  /** When given, the referral account's partner must be this key (the revenue wallet, D34). */
  expectedPartner?: PublicKey;
  /**
   * The referral account's project must be this key. Default: `JUPITER_ULTRA_REFERRAL_PROJECT`,
   * the only project the Jupiter Plugin pays.
   */
  expectedProject?: PublicKey;
  commitment?: Commitment;
  retry?: RetryOptions;
  programId?: PublicKey;
  /**
   * Priority fee read from the cluster for the claim's writable accounts, bounded by this setting
   * (priority-fee.ts): `setComputeUnitLimit` (`JUPITER_REFERRAL_CLAIM_COMPUTE_UNITS`) then
   * `setComputeUnitPrice`, first. Default: none.
   */
  priority?: PriorityFeeSetting;
}

/**
 * Compute unit limit of a Jupiter referral claim with a priority fee: up to two token account
 * creations and two claims (each a token transfer pair), with a wide margin.
 */
export const JUPITER_REFERRAL_CLAIM_COMPUTE_UNITS = 300_000;

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
  /** The priority fee (price, fee, cap), or null without a `priority` setting or transaction. */
  priorityFee: PriorityFeeQuote | null;
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
  if (p.priority !== undefined) resolvePriorityFeePolicy(p.priority);
  const expectedProject = p.expectedProject ?? JUPITER_ULTRA_REFERRAL_PROJECT;
  const retry = p.retry ?? {};
  if (p.payer.equals(p.referralAccount) || p.mint.equals(p.referralAccount)) {
    throw new JupiterReferralError(
      'invalid_params',
      'payer, mint and referral account must differ',
    );
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
  if (v1Amount > 0n)
    claims.push({ version: 'v1', referralTokenAccount: v1Account, amount: v1Amount });
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
  if (claims.length === 0) {
    return { transaction: null, lastValidBlockHeight: null, summary, priorityFee: null };
  }

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
  let priorityFee: PriorityFeeQuote | null = null;
  if (p.priority !== undefined) {
    priorityFee = await estimatePriorityFee({
      connection,
      writableAccounts: writableAccountsOf(transaction.instructions),
      computeUnitLimit: JUPITER_REFERRAL_CLAIM_COMPUTE_UNITS,
      setting: p.priority,
    });
    transaction.instructions.unshift(...priorityFeeInstructions(priorityFee));
  }
  const latest = await retryRpc(() => connection.getLatestBlockhash(commitment), retry);
  transaction.feePayer = p.payer;
  transaction.recentBlockhash = latest.blockhash;
  return { transaction, lastValidBlockHeight: latest.lastValidBlockHeight, summary, priorityFee };
}

// ---------------------------------------------------------------------------------------------
// Setup of FORGE's referral account (pure builders; docs/MAINNET.md section 5)
// ---------------------------------------------------------------------------------------------
//
// Verified against the program source (github.com/TeamRaccoons/referral, program/programs/
// referral/src/instructions/initialize_referral_account_with_name.rs, lib.rs, claim_v2.rs; the
// IDL of @jup-ag/referral-sdk 0.3.0 agrees):
// - `initialize_referral_account_with_name(params: { name: String })`: accounts `payer` (mut,
//   signer), `partner` (SystemAccount, read-only, NOT a signer), `project` (read-only, PDA
//   `["project", base]`), `referral_account` (mut, init, PDA `["referral", project, name]`,
//   `ReferralAccount::LEN` = 274 bytes, rent paid by `payer`), `system_program`. The share is the
//   project's `default_share_bps`. Name: `params.name.chars().count() < 20`, so 1 to 19
//   characters; the name is also a PDA seed, so at most 32 UTF-8 bytes.
// - The v2 collection accounts `claim_v2` empties are the associated token accounts of the
//   referral account (`associated_token::authority = referral_account`): the SDK's
//   `initializeReferralTokenAccountV2` is a plain `CreateIdempotent` of the Associated Token
//   program, paid by the payer, which is what `buildJupiterReferralTokenAccountV2Ix` builds.
// Only the payer signs anywhere: the partner (the revenue wallet) never does.

export const JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR: Buffer =
  anchorDiscriminator('global:initialize_referral_account_with_name');

/** `ReferralAccount::LEN` = 8 + 32 + 32 + 200 + 2: what the initialization allocates. */
export const JUPITER_REFERRAL_ACCOUNT_SIZE = 274;

/** `params.name.chars().count() < 20` in the program. */
export const JUPITER_REFERRAL_NAME_MAX_CHARS = 19;
/** The name is a PDA seed: at most 32 bytes. */
export const JUPITER_REFERRAL_NAME_MAX_BYTES = 32;

/**
 * Compute unit limit of the setup transaction with a priority fee: one Anchor account
 * initialization and up to a few associated token account creations, with a wide margin.
 */
export const JUPITER_REFERRAL_SETUP_COMPUTE_UNITS = 150_000;

/**
 * Checks a referral account name: 1 to 19 characters (code points, the program's rule), at most
 * 32 UTF-8 bytes (a PDA seed), and FORGE's own restriction to printable characters without
 * whitespace (a name goes into environment files and documentation). Returns the name.
 * @throws JupiterReferralError `invalid_params`
 */
export function assertJupiterReferralName(name: string): string {
  const fail = (reason: string) => new JupiterReferralError('invalid_params', reason);
  if (typeof name !== 'string' || name.length === 0) {
    throw fail('the name must be a non-empty string');
  }
  const chars = [...name].length;
  if (chars > JUPITER_REFERRAL_NAME_MAX_CHARS) {
    throw fail(
      `the name has ${chars} characters, at most ${JUPITER_REFERRAL_NAME_MAX_CHARS} are allowed`,
    );
  }
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > JUPITER_REFERRAL_NAME_MAX_BYTES) {
    throw fail(
      `the name is ${bytes} bytes, at most ${JUPITER_REFERRAL_NAME_MAX_BYTES} are allowed`,
    );
  }
  if (/[\s\p{Cc}\p{Cf}]/u.test(name)) {
    throw fail('the name must not contain whitespace or control characters');
  }
  return name;
}

/** Borsh `String`: u32 little-endian byte length, then the UTF-8 bytes. */
export function encodeJupiterReferralName(name: string): Buffer {
  const bytes = Buffer.from(assertJupiterReferralName(name), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export interface JupiterInitializeReferralAccountWithNameAccounts {
  /** Signer: pays the network fee and the referral account rent. */
  payer: PublicKey;
  /** Receives the claimed fees (FORGE: the revenue wallet, D34). Does not sign. */
  partner: PublicKey;
  project: PublicKey;
  /** Must be `deriveJupiterReferralAccount(project, name)`. */
  referralAccount: PublicKey;
}

/**
 * `initialize_referral_account_with_name`: the IDL's accounts in the IDL's order, the Anchor
 * discriminator then the Borsh-encoded `{ name }`. Refuses a referral account that is not the
 * PDA of the project and the name, and a payer, partner, project or referral account that
 * coincide.
 */
export function buildJupiterInitializeReferralAccountWithNameIx(
  accounts: JupiterInitializeReferralAccountWithNameAccounts,
  name: string,
  programId: PublicKey = JUPITER_REFERRAL_PROGRAM_ID,
): TransactionInstruction {
  const data = encodeJupiterReferralName(name);
  const expected = deriveJupiterReferralAccount(accounts.project, name, programId);
  if (!expected.equals(accounts.referralAccount)) {
    throw new JupiterReferralError(
      'invalid_params',
      'referralAccount is not the PDA ["referral", project, name] of that name',
    );
  }
  const keys = [accounts.payer, accounts.partner, accounts.project, accounts.referralAccount];
  if (new Set(keys.map((k) => k.toBase58())).size !== keys.length) {
    throw new JupiterReferralError(
      'invalid_params',
      'payer, partner, project and referral account must differ',
    );
  }
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      ro(accounts.partner),
      ro(accounts.project),
      rw(accounts.referralAccount),
      ro(SystemProgram.programId),
    ],
    data: Buffer.concat([JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR, data]),
  });
}

export interface JupiterReferralTokenAccountV2Params {
  /** Signer: pays the rent of the token account. */
  payer: PublicKey;
  referralAccount: PublicKey;
  mint: PublicKey;
  /** The mint's program (classic SPL Token or Token-2022). */
  tokenProgram: PublicKey;
}

export interface JupiterReferralTokenAccountV2Ix {
  /** `deriveJupiterReferralTokenAccountV2(referralAccount, mint, tokenProgram)`. */
  tokenAccount: PublicKey;
  instruction: TransactionInstruction;
}

/**
 * The v2 collection account of `mint` (what the Jupiter Plugin pays and `claim_v2` empties): an
 * idempotent creation of the referral account's associated token account, paid by `payer`
 * (the SDK's `initializeReferralTokenAccountV2`). Idempotent on-chain: an existing account is
 * left as it is.
 */
export function buildJupiterReferralTokenAccountV2Ix(
  p: JupiterReferralTokenAccountV2Params,
): JupiterReferralTokenAccountV2Ix {
  assertTokenProgram(p.tokenProgram);
  if (p.payer.equals(p.referralAccount) || p.mint.equals(p.referralAccount)) {
    throw new JupiterReferralError(
      'invalid_params',
      'payer, mint and referral account must differ',
    );
  }
  const tokenAccount = deriveJupiterReferralTokenAccountV2(
    p.referralAccount,
    p.mint,
    p.tokenProgram,
  );
  return {
    tokenAccount,
    instruction: createAssociatedTokenAccountIdempotentInstruction(
      p.payer,
      tokenAccount,
      p.referralAccount,
      p.mint,
      p.tokenProgram,
    ),
  };
}

export interface JupiterReferralSetupMint {
  mint: PublicKey;
  tokenProgram: PublicKey;
}

export interface BuildJupiterReferralSetupTxParams {
  /** Fee payer and only signer. */
  payer: PublicKey;
  /** The referral account's partner: the revenue wallet. */
  partner: PublicKey;
  /** Default: `JUPITER_ULTRA_REFERRAL_PROJECT`, the only project the Jupiter Plugin pays. */
  project?: PublicKey;
  name: string;
  /** False when the referral account already exists (only token accounts are then created). */
  createReferralAccount: boolean;
  /** The v2 collection accounts to create (those found absent), in this order. */
  tokenAccounts: readonly JupiterReferralSetupMint[];
  blockhash: string;
  lastValidBlockHeight: number;
  /**
   * Priority fee quote of the caller (`JUPITER_REFERRAL_SETUP_COMPUTE_UNITS`): a unit limit then
   * a unit price are put first when its price is not 0; nothing otherwise.
   */
  priorityFee?: Pick<PriorityFeeQuote, 'computeUnitLimit' | 'microLamports'>;
  programId?: PublicKey;
}

export interface JupiterReferralSetupTokenAccount extends JupiterReferralSetupMint {
  tokenAccount: PublicKey;
}

export interface JupiterReferralSetupTx {
  /** Unsigned legacy transaction (fee payer = payer, blockhash set). */
  transaction: Transaction;
  lastValidBlockHeight: number;
  referralAccount: PublicKey;
  project: PublicKey;
  name: string;
  /** The token accounts the transaction creates (same order as the input). */
  tokenAccounts: JupiterReferralSetupTokenAccount[];
}

/**
 * Unsigned transaction setting up FORGE's Jupiter referral account: the optional compute budget,
 * `initialize_referral_account_with_name` when `createReferralAccount`, then one v2 collection
 * account creation per `tokenAccounts` entry. Refuses an empty plan and a duplicate mint. Does
 * not read the chain: inspect first (`readJupiterReferralSetup`). Mainnet-beta is the only
 * cluster where the program and the Ultra project exist; the read helper enforces it.
 */
export function buildJupiterReferralSetupTx(
  p: BuildJupiterReferralSetupTxParams,
): JupiterReferralSetupTx {
  const programId = p.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const project = p.project ?? JUPITER_ULTRA_REFERRAL_PROJECT;
  const name = assertJupiterReferralName(p.name);
  if (typeof p.blockhash !== 'string' || p.blockhash.length === 0) {
    throw new JupiterReferralError('invalid_params', 'blockhash required');
  }
  if (!Number.isInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0) {
    throw new JupiterReferralError(
      'invalid_params',
      'lastValidBlockHeight must be a non-negative integer',
    );
  }
  if (!p.createReferralAccount && p.tokenAccounts.length === 0) {
    throw new JupiterReferralError('invalid_params', 'nothing to set up');
  }
  const seen = new Set<string>();
  for (const { mint } of p.tokenAccounts) {
    if (seen.has(mint.toBase58())) {
      throw new JupiterReferralError('invalid_params', 'duplicate mint in tokenAccounts');
    }
    seen.add(mint.toBase58());
  }
  const referralAccount = deriveJupiterReferralAccount(project, name, programId);
  const transaction = new Transaction({
    feePayer: p.payer,
    blockhash: p.blockhash,
    lastValidBlockHeight: p.lastValidBlockHeight,
  });
  if (p.priorityFee && p.priorityFee.microLamports > 0) {
    transaction.add(...priorityFeeInstructions(p.priorityFee));
  }
  if (p.createReferralAccount) {
    transaction.add(
      buildJupiterInitializeReferralAccountWithNameIx(
        { payer: p.payer, partner: p.partner, project, referralAccount },
        name,
        programId,
      ),
    );
  }
  const tokenAccounts: JupiterReferralSetupTokenAccount[] = [];
  for (const entry of p.tokenAccounts) {
    const built = buildJupiterReferralTokenAccountV2Ix({
      payer: p.payer,
      referralAccount,
      mint: entry.mint,
      tokenProgram: entry.tokenProgram,
    });
    transaction.add(built.instruction);
    tokenAccounts.push({ ...entry, tokenAccount: built.tokenAccount });
  }
  return {
    transaction,
    lastValidBlockHeight: p.lastValidBlockHeight,
    referralAccount,
    project,
    name,
    tokenAccounts,
  };
}

// ---------------------------------------------------------------------------------------------
// Setup inspection (pure) and read helper (mainnet-beta only)
// ---------------------------------------------------------------------------------------------

export type JupiterReferralAccountMismatch =
  'not_a_referral_account' | 'partner_mismatch' | 'project_mismatch' | 'name_mismatch';

export type JupiterReferralAccountStatus =
  | { status: 'absent' }
  | { status: 'ready'; account: JupiterReferralAccount }
  | { status: 'mismatch'; reason: JupiterReferralAccountMismatch; detail: string };

export interface JupiterReferralAccountExpectation {
  partner: PublicKey;
  project: PublicKey;
  name: string;
  programId?: PublicKey;
}

/**
 * What the referral account address holds, against the expected one: absent, ready (a referral
 * account of `project` with `partner` and exactly `name`), or a mismatch with its reason. The
 * caller derives the address as the PDA of the project and the name.
 */
export function inspectJupiterReferralAccount(
  info: AccountInfo<Buffer> | null,
  expected: JupiterReferralAccountExpectation,
): JupiterReferralAccountStatus {
  if (!info) return { status: 'absent' };
  const programId = expected.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const mismatch = (reason: JupiterReferralAccountMismatch, detail: string) =>
    ({ status: 'mismatch', reason, detail }) as const;
  if (!info.owner.equals(programId)) {
    return mismatch(
      'not_a_referral_account',
      `the address is in use by an account owned by ${info.owner.toBase58()}`,
    );
  }
  let account: JupiterReferralAccount;
  try {
    account = decodeJupiterReferralAccount(Buffer.from(info.data));
  } catch (error) {
    return mismatch('not_a_referral_account', (error as Error).message);
  }
  if (!account.partner.equals(expected.partner)) {
    return mismatch(
      'partner_mismatch',
      `the referral account partner is ${account.partner.toBase58()}`,
    );
  }
  if (!account.project.equals(expected.project)) {
    return mismatch(
      'project_mismatch',
      `the referral account project is ${account.project.toBase58()}`,
    );
  }
  if (account.name !== expected.name) {
    return mismatch(
      'name_mismatch',
      account.name === null
        ? 'the referral account has no name'
        : `the referral account name is "${account.name}"`,
    );
  }
  return { status: 'ready', account };
}

export type JupiterReferralTokenAccountMismatch =
  'not_a_token_account' | 'wrong_mint' | 'wrong_owner';

export type JupiterReferralTokenAccountStatus =
  | { status: 'absent' }
  | { status: 'ready'; amount: bigint }
  | { status: 'mismatch'; reason: JupiterReferralTokenAccountMismatch; detail: string };

/**
 * What the v2 collection account address holds: absent, a token account of `mint` owned by the
 * referral account, or not.
 */
export function inspectJupiterReferralTokenAccountV2(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  expected: { referralAccount: PublicKey; mint: PublicKey; tokenProgram: PublicKey },
): JupiterReferralTokenAccountStatus {
  if (!info) return { status: 'absent' };
  const mismatch = (reason: JupiterReferralTokenAccountMismatch, detail: string) =>
    ({ status: 'mismatch', reason, detail }) as const;
  if (!info.owner.equals(expected.tokenProgram)) {
    return mismatch(
      'not_a_token_account',
      `the address is in use by an account owned by ${info.owner.toBase58()}`,
    );
  }
  let account: ReturnType<typeof unpackAccount>;
  try {
    account = unpackAccount(address, info, expected.tokenProgram);
  } catch {
    return mismatch('not_a_token_account', 'the account data is not a token account');
  }
  if (!account.mint.equals(expected.mint)) {
    return mismatch('wrong_mint', `the token account mint is ${account.mint.toBase58()}`);
  }
  if (!account.owner.equals(expected.referralAccount)) {
    return mismatch('wrong_owner', `the token account owner is ${account.owner.toBase58()}`);
  }
  return { status: 'ready', amount: account.amount };
}

export interface ReadJupiterReferralSetupParams {
  connection: Connection;
  partner: PublicKey;
  name: string;
  /** The currencies whose v2 collection accounts are wanted (e.g. wrapped SOL and USDC). */
  mints: readonly PublicKey[];
  /** Default: `JUPITER_ULTRA_REFERRAL_PROJECT`. */
  project?: PublicKey;
  programId?: PublicKey;
  commitment?: Commitment;
  retry?: RetryOptions;
}

export interface JupiterReferralSetupTokenAccountState extends JupiterReferralSetupTokenAccount {
  status: JupiterReferralTokenAccountStatus;
}

export interface JupiterReferralSetupState {
  project: PublicKey;
  /** The project as decoded on-chain (its admin and default share). */
  projectAccount: JupiterProject;
  name: string;
  referralAccount: PublicKey;
  referral: JupiterReferralAccountStatus;
  tokenAccounts: JupiterReferralSetupTokenAccountState[];
}

/**
 * Reads what the setup needs: the project (must exist and decode), the mints (their token
 * program), the named referral account and its v2 collection accounts, each inspected. Mainnet
 * only (`wrong_cluster` on any other cluster, before any read). The caller decides what to
 * create (the absent ones) and refuses on any mismatch.
 */
export async function readJupiterReferralSetup(
  p: ReadJupiterReferralSetupParams,
): Promise<JupiterReferralSetupState> {
  const programId = p.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const project = p.project ?? JUPITER_ULTRA_REFERRAL_PROJECT;
  const name = assertJupiterReferralName(p.name);
  const commitment = p.commitment ?? 'confirmed';
  const retry = p.retry ?? {};
  if (p.mints.length === 0) throw new JupiterReferralError('invalid_params', 'at least one mint');
  if (new Set(p.mints.map((m) => m.toBase58())).size !== p.mints.length) {
    throw new JupiterReferralError('invalid_params', 'duplicate mint');
  }
  try {
    await assertCluster(p.connection, 'mainnet-beta', retry);
  } catch (error) {
    if (error instanceof PaymentError && error.code === 'wrong_cluster') {
      throw new JupiterReferralError(
        'wrong_cluster',
        'the Jupiter referral program and the Ultra project only exist on mainnet-beta',
        { cause: error },
      );
    }
    throw error;
  }
  const referralAccount = deriveJupiterReferralAccount(project, name, programId);
  const [projectInfo, referralInfo, ...mintInfos] = await retryRpc(
    () => p.connection.getMultipleAccountsInfo([project, referralAccount, ...p.mints], commitment),
    retry,
  );
  if (!projectInfo) throw new JupiterReferralError('project_not_found', 'project not found');
  if (!projectInfo.owner.equals(programId)) {
    throw new JupiterReferralError('not_a_project', 'project is not owned by the referral program');
  }
  const projectAccount = decodeJupiterProject(Buffer.from(projectInfo.data));
  const entries: JupiterReferralSetupTokenAccount[] = p.mints.map((mint, i) => {
    const info = mintInfos[i];
    if (!info) {
      throw new JupiterReferralError('mint_not_found', `mint ${mint.toBase58()} not found`);
    }
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new JupiterReferralError(
        'not_a_mint',
        `${mint.toBase58()} is not owned by a token program`,
      );
    }
    return {
      mint,
      tokenProgram: info.owner,
      tokenAccount: deriveJupiterReferralTokenAccountV2(referralAccount, mint, info.owner),
    };
  });
  const tokenInfos = await retryRpc(
    () =>
      p.connection.getMultipleAccountsInfo(
        entries.map((e) => e.tokenAccount),
        commitment,
      ),
    retry,
  );
  return {
    project,
    projectAccount,
    name,
    referralAccount,
    referral: inspectJupiterReferralAccount(referralInfo ?? null, {
      partner: p.partner,
      project,
      name,
      programId,
    }),
    tokenAccounts: entries.map((entry, i) => ({
      ...entry,
      status: inspectJupiterReferralTokenAccountV2(entry.tokenAccount, tokenInfos[i] ?? null, {
        referralAccount,
        mint: entry.mint,
        tokenProgram: entry.tokenProgram,
      }),
    })),
  };
}
