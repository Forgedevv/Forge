/**
 * Meteora referral account setup (docs/METEORA.md "The Meteora referral", docs/DECISIONS.md D34).
 *
 * The Meteora referral of every curve swap core builds is a wrapped-SOL token account held by
 * the FORGE revenue wallet (`FORGE_METEORA_REFERRAL_ACCOUNT`). It must be a STANDALONE token
 * account, never the wallet's associated token account: the Jupiter referral claims land in the
 * associated account, and the revenue job books the two separately (`meteora_referral` /
 * `jupiter_referral`).
 *
 * The account lives at an address derived from the fee payer and a fixed seed
 * (`createAccountWithSeed`: no extra keypair to generate or keep, and the address can be
 * re-derived at any time), 165 bytes owned by the SPL Token program, then `InitializeAccount3`
 * sets its mint (wrapped SOL) and its owner (the revenue wallet) from the instruction data. The
 * only signer is the payer: neither the owner nor the new account signs, so the revenue key never
 * has to sign its own setup.
 *
 * Pure builders (byte-for-byte tested) and pure inspection of what the chain holds; the only
 * network call is the optional `readMeteoraReferralAccount`. Any cluster: a WSOL token account
 * exists on devnet too (the devnet proof of the revenue job uses one).
 */
import { sha256 } from '@noble/hashes/sha2';
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type Commitment,
  type Connection,
} from '@solana/web3.js';
import { priorityFeeInstructions, type PriorityFeeQuote } from './priority-fee.js';
import { retryRpc, type RetryOptions } from './reads.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Default seed of the referral account address (`createWithSeed(payer, seed, SPL Token)`). */
export const METEORA_REFERRAL_ACCOUNT_SEED = 'forge-meteora-referral';

/** Longest seed `createWithSeed` accepts, in bytes (System program limit). */
export const MAX_METEORA_REFERRAL_SEED_BYTES = 32;

/**
 * Compute unit limit of the setup transaction with a priority fee: one `createAccountWithSeed`
 * and one `InitializeAccount3` (a few thousand units each), with a wide margin.
 */
export const METEORA_REFERRAL_SETUP_COMPUTE_UNITS = 30_000;

/** SPL Token `InitializeAccount3` instruction tag (u8), followed by the 32-byte owner. */
export const TOKEN_INITIALIZE_ACCOUNT3_TAG = 18;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type MeteoraReferralErrorCode = 'invalid_params';

export class MeteoraReferralError extends Error {
  readonly code: MeteoraReferralErrorCode;

  constructor(code: MeteoraReferralErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MeteoraReferralError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new MeteoraReferralError('invalid_params', message);
}

// ---------------------------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------------------------

/** Checks a `createWithSeed` seed: 1 to 32 UTF-8 bytes, no control character. */
export function assertMeteoraReferralSeed(seed: string): void {
  if (typeof seed !== 'string' || seed.length === 0) invalid('the seed must be a non-empty string');
  if (/\p{Cc}/u.test(seed)) invalid('the seed must not contain control characters');
  const bytes = Buffer.byteLength(seed, 'utf8');
  if (bytes > MAX_METEORA_REFERRAL_SEED_BYTES) {
    invalid(`the seed is ${bytes} bytes, at most ${MAX_METEORA_REFERRAL_SEED_BYTES} are allowed`);
  }
}

/**
 * Address of the referral account created by `buildCreateMeteoraReferralAccountTx` for `payer`
 * and `seed`: `createWithSeed(payer, seed, SPL Token program)`, i.e.
 * `sha256(payer || seed || program)`, the same derivation as `PublicKey.createWithSeed`
 * (synchronous here, so the builders stay pure).
 */
export function deriveMeteoraReferralAccount(
  payer: PublicKey,
  seed: string = METEORA_REFERRAL_ACCOUNT_SEED,
): PublicKey {
  assertMeteoraReferralSeed(seed);
  const digest = sha256(
    Buffer.concat([payer.toBuffer(), Buffer.from(seed, 'utf8'), TOKEN_PROGRAM_ID.toBuffer()]),
  );
  return new PublicKey(digest);
}

// ---------------------------------------------------------------------------------------------
// Instructions and transaction (pure)
// ---------------------------------------------------------------------------------------------

export interface CreateMeteoraReferralAccountParams {
  /** Fee payer, rent payer and base of the address derivation: the only signer. */
  payer: PublicKey;
  /** Owner of the token account: the FORGE revenue wallet (D34). */
  owner: PublicKey;
  /** Seed of the address (default `METEORA_REFERRAL_ACCOUNT_SEED`), 1 to 32 bytes. */
  seed?: string;
  /** Rent-exempt minimum of a token account (`ACCOUNT_SIZE` = 165 bytes), read by the caller. */
  rentLamports: bigint;
}

export interface MeteoraReferralAccountInstructions {
  /** The new token account: `deriveMeteoraReferralAccount(payer, seed)`. */
  account: PublicKey;
  seed: string;
  /** `createAccountWithSeed` (payer -> account, rent, 165 bytes, SPL Token) then `InitializeAccount3`. */
  instructions: TransactionInstruction[];
}

/**
 * The two instructions creating the standalone wrapped-SOL token account of `owner`:
 * System `createAccountWithSeed` (from = base = payer; exactly the rent of 165 bytes; owner
 * program = SPL Token) and SPL Token `InitializeAccount3` (account, wrapped SOL mint; owner in
 * the data, no owner signature). Refuses an owner equal to the payer, a zero rent, and a seed
 * whose address is the owner's associated wrapped-SOL account (impossible in practice: the
 * associated account is a PDA, this address is a hash; checked all the same).
 */
export function buildCreateMeteoraReferralAccountIxs(
  p: CreateMeteoraReferralAccountParams,
): MeteoraReferralAccountInstructions {
  const seed = p.seed ?? METEORA_REFERRAL_ACCOUNT_SEED;
  if (p.payer.equals(p.owner)) invalid('the payer must not be the owner of the referral account');
  if (p.owner.equals(PublicKey.default)) invalid('the owner must not be the default key');
  if (typeof p.rentLamports !== 'bigint' || p.rentLamports <= 0n) {
    invalid('rentLamports must be a positive bigint');
  }
  if (p.rentLamports > BigInt(Number.MAX_SAFE_INTEGER)) invalid('rentLamports is too large');
  const account = deriveMeteoraReferralAccount(p.payer, seed);
  if (account.equals(getAssociatedTokenAddressSync(NATIVE_MINT, p.owner, true))) {
    invalid('the derived address is the associated wrapped-SOL account of the owner');
  }
  const create = SystemProgram.createAccountWithSeed({
    fromPubkey: p.payer,
    basePubkey: p.payer,
    seed,
    newAccountPubkey: account,
    lamports: Number(p.rentLamports),
    space: ACCOUNT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });
  const initialize = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([TOKEN_INITIALIZE_ACCOUNT3_TAG]), p.owner.toBuffer()]),
  });
  return { account, seed, instructions: [create, initialize] };
}

export interface BuildCreateMeteoraReferralAccountTxParams extends CreateMeteoraReferralAccountParams {
  blockhash: string;
  lastValidBlockHeight: number;
  /**
   * Priority fee quote of the caller (`METEORA_REFERRAL_SETUP_COMPUTE_UNITS`): a unit limit then
   * a unit price are put first when its price is not 0; nothing otherwise.
   */
  priorityFee?: Pick<PriorityFeeQuote, 'computeUnitLimit' | 'microLamports'>;
}

export interface CreateMeteoraReferralAccountTx extends MeteoraReferralAccountInstructions {
  /** Unsigned legacy transaction (fee payer = payer, blockhash set). */
  transaction: Transaction;
  lastValidBlockHeight: number;
}

/**
 * Unsigned transaction creating the Meteora referral account (`buildCreateMeteoraReferralAccountIxs`
 * after the optional compute budget). It does not check that the address is free: inspect it
 * first (`readMeteoraReferralAccount`); creating it twice fails on-chain, nothing is lost but
 * the fee.
 */
export function buildCreateMeteoraReferralAccountTx(
  p: BuildCreateMeteoraReferralAccountTxParams,
): CreateMeteoraReferralAccountTx {
  if (typeof p.blockhash !== 'string' || p.blockhash.length === 0) invalid('blockhash required');
  if (!Number.isInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0) {
    invalid('lastValidBlockHeight must be a non-negative integer');
  }
  const built = buildCreateMeteoraReferralAccountIxs(p);
  const transaction = new Transaction({
    feePayer: p.payer,
    blockhash: p.blockhash,
    lastValidBlockHeight: p.lastValidBlockHeight,
  });
  if (p.priorityFee && p.priorityFee.microLamports > 0) {
    transaction.add(...priorityFeeInstructions(p.priorityFee));
  }
  transaction.add(...built.instructions);
  return { ...built, transaction, lastValidBlockHeight: p.lastValidBlockHeight };
}

// ---------------------------------------------------------------------------------------------
// Inspection (pure) and read helper
// ---------------------------------------------------------------------------------------------

export type MeteoraReferralMismatch =
  /** The address holds something that is not an SPL Token account (or none that decodes). */
  | 'not_a_token_account'
  | 'wrong_mint'
  | 'wrong_owner'
  /** The account is the owner's associated wrapped-SOL account: Jupiter claims would land in it. */
  | 'associated_account'
  | 'frozen'
  /** A delegate or a close authority could move or close it: not acceptable for a fee account. */
  | 'delegated'
  | 'close_authority';

export type MeteoraReferralAccountStatus =
  /** No account at the address: the setup creates it. */
  | { status: 'absent' }
  /** A wrapped-SOL token account held by the expected owner, standalone: nothing to do. */
  | { status: 'ready'; lamports: bigint; amount: bigint }
  /** Something else lives there: never create, never reuse (the caller refuses). */
  | { status: 'mismatch'; reason: MeteoraReferralMismatch; detail: string };

export interface MeteoraReferralExpectation {
  /** The FORGE revenue wallet. */
  owner: PublicKey;
}

/**
 * What `address` holds, against the expected shape of the Meteora referral account: absent,
 * ready (a standalone wrapped-SOL token account of `owner`, neither frozen, delegated nor
 * closable by someone else), or a mismatch with its reason.
 */
export function inspectMeteoraReferralAccount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  expected: MeteoraReferralExpectation,
): MeteoraReferralAccountStatus {
  if (!info) return { status: 'absent' };
  const mismatch = (reason: MeteoraReferralMismatch, detail: string) =>
    ({ status: 'mismatch', reason, detail }) as const;
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    return mismatch(
      'not_a_token_account',
      `the address is in use by an account owned by ${info.owner.toBase58()}`,
    );
  }
  let account: ReturnType<typeof unpackAccount>;
  try {
    account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  } catch {
    return mismatch('not_a_token_account', 'the account data is not an SPL Token account');
  }
  if (!account.mint.equals(NATIVE_MINT)) {
    return mismatch('wrong_mint', `the token account mint is ${account.mint.toBase58()}`);
  }
  if (!account.owner.equals(expected.owner)) {
    return mismatch('wrong_owner', `the token account owner is ${account.owner.toBase58()}`);
  }
  if (address.equals(getAssociatedTokenAddressSync(NATIVE_MINT, expected.owner, true))) {
    return mismatch(
      'associated_account',
      'the account is the associated wrapped-SOL account of the owner, not a standalone one',
    );
  }
  if (account.isFrozen) return mismatch('frozen', 'the token account is frozen');
  if (account.delegate !== null) {
    return mismatch('delegated', `the token account has a delegate ${account.delegate.toBase58()}`);
  }
  if (account.closeAuthority !== null && !account.closeAuthority.equals(expected.owner)) {
    return mismatch(
      'close_authority',
      `the token account can be closed by ${account.closeAuthority.toBase58()}`,
    );
  }
  return { status: 'ready', lamports: BigInt(info.lamports), amount: account.amount };
}

export interface ReadMeteoraReferralAccountParams extends MeteoraReferralExpectation {
  connection: Pick<Connection, 'getAccountInfo'>;
  address: PublicKey;
  commitment?: Commitment;
  retry?: RetryOptions;
}

/** Reads `address` and inspects it (`inspectMeteoraReferralAccount`). Any cluster. */
export async function readMeteoraReferralAccount(
  p: ReadMeteoraReferralAccountParams,
): Promise<MeteoraReferralAccountStatus> {
  const info = await retryRpc(
    () => p.connection.getAccountInfo(p.address, p.commitment ?? 'confirmed'),
    p.retry ?? {},
  );
  return inspectMeteoraReferralAccount(p.address, info, { owner: p.owner });
}
