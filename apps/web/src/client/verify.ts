import { LaunchTransactionCheckError, verifyLaunchCoinTransaction } from '@forge/core/launch-check';
import { OwnerTransactionLaunch, type OwnerTransactionSummary } from '@forge/shared';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

/*
 * Checks run in the browser on every server-built transaction BEFORE the wallet is asked to sign
 * it (and again on what the wallet returns). The server is trusted to build them (@forge/core is
 * the only builder); these checks make sure a compromised or buggy server cannot get the owner to
 * sign something else: another fee payer, another amount, another receiver, another program.
 *
 * The ids below are public protocol constants (identical on devnet and mainnet), not FORGE
 * addresses. FORGE's cashbox comes from NEXT_PUBLIC_FORGE_CASHBOX_WALLET (required in production).
 */

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Meteora Dynamic Bonding Curve (SDK 1.5.13). */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Anchor discriminators (first 8 data bytes) of the DBC partner claims (IDL of SDK 1.5.13). */
export const DBC_PARTNER_CLAIMS = {
  claimTradingFee: [8, 236, 89, 49, 152, 125, 177, 81],
  claimPartnerPoolCreationFee: [250, 238, 26, 4, 139, 10, 101, 248],
} as const;

export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000_000n;
/** Upper bound of the priority fee a checked transaction may carry (0.01 SOL). */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;

const NOTHING_SIGNED = 'Nothing was signed.';

const NOTHING_SENT = 'Nothing was sent.';

/** A server transaction that does not match what the owner is about to approve. */
export class TransactionCheckError extends Error {
  constructor(message: string, outcome: string = NOTHING_SIGNED) {
    super(`${message} ${outcome}`);
    this.name = 'TransactionCheckError';
  }
}

function fail(message: string, outcome: string = NOTHING_SIGNED): never {
  throw new TransactionCheckError(message, outcome);
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

export interface DecodedAccount {
  key: string;
  signer: boolean;
  writable: boolean;
}

export interface DecodedInstruction {
  index: number;
  programId: string;
  accounts: DecodedAccount[];
  data: Uint8Array;
}

export interface DecodedTransaction {
  feePayer: string;
  /** Required signers in message order (fee payer first). */
  requiredSigners: string[];
  /** Required signers whose signature slot is already filled. */
  signed: ReadonlySet<string>;
  instructions: DecodedInstruction[];
}

/** Flattens a transaction; refuses address lookup tables (their content cannot be checked). */
export function decodeTransaction(tx: VersionedTransaction): DecodedTransaction {
  const message = tx.message;
  if (message.addressTableLookups.length > 0) {
    fail('The transaction uses address lookup tables, which cannot be checked.');
  }
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const required = message.header.numRequiredSignatures;
  if (required < 1 || keys.length < required) fail('The transaction has no fee payer.');
  const requiredSigners = keys.slice(0, required);
  const signed = new Set<string>();
  requiredSigners.forEach((key, i) => {
    const signature = tx.signatures[i];
    if (signature && signature.some((b) => b !== 0)) signed.add(key);
  });
  const instructions = message.compiledInstructions.map((ix, index) => {
    const programId = keys[ix.programIdIndex];
    if (programId === undefined) fail('The transaction references an unknown program.');
    const accounts = ix.accountKeyIndexes.map((i) => {
      const key = keys[i];
      if (key === undefined) fail('The transaction references an unknown account.');
      return { key, signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) };
    });
    return { index, programId, accounts, data: Uint8Array.from(ix.data) };
  });
  return { feePayer: requiredSigners[0]!, requiredSigners, signed, instructions };
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function where(ix: DecodedInstruction): string {
  return `instruction #${ix.index + 1}`;
}

function account(ix: DecodedInstruction, i: number): DecodedAccount {
  const a = ix.accounts[i];
  if (!a) fail(`Malformed ${where(ix)}.`);
  return a;
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
}

function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(tokenProgram).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0].toBase58();
}

/** Base58 address check without throwing. */
export function parseAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------------------------

/** The fee payer is the wallet and nobody else signs. */
function assertSoleSigner(decoded: DecodedTransaction, wallet: string): void {
  if (decoded.feePayer !== wallet) fail('The transaction fee payer is not your wallet.');
  if (decoded.requiredSigners.length !== 1) {
    fail('The transaction asks for signatures other than your wallet.');
  }
}

/** Compute budget instructions, bounded; returns the priority fee they allow (lamports). */
function checkComputeBudget(decoded: DecodedTransaction): void {
  let units: number | null = null;
  let price: bigint | null = null;
  let others = 0;
  for (const ix of decoded.instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) {
      others += 1;
      continue;
    }
    if (ix.accounts.length !== 0) fail(`Unexpected compute budget ${where(ix)}.`);
    if (ix.data[0] === 2 && ix.data.length === 5 && units === null) {
      units = readU32(ix.data, 1);
      if (units < 1 || units > MAX_COMPUTE_UNIT_LIMIT) fail('The compute limit is out of range.');
    } else if (ix.data[0] === 3 && ix.data.length === 9 && price === null) {
      price = readU64(ix.data, 1);
      if (price > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) fail('The priority fee is too high.');
    } else {
      fail(`Unexpected compute budget ${where(ix)}.`);
    }
  }
  if (price === null) return;
  const budget = BigInt(
    units ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, others * DEFAULT_UNITS_PER_INSTRUCTION),
  );
  const fee = (price * budget + 999_999n) / 1_000_000n;
  if (fee > MAX_PRIORITY_FEE_LAMPORTS) fail('The priority fee is too high.');
}

// ---------------------------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------------------------

export interface ExpectedPayment {
  /** The signed-in wallet: fee payer, payer and memo signer. */
  wallet: string;
  /** Exact quoted amount. */
  lamports: bigint;
  jobId: string;
  /** FORGE's cashbox (NEXT_PUBLIC_FORGE_CASHBOX_WALLET); null = not pinned (never in production). */
  cashbox: string | null;
}

/**
 * Exactly one System transfer of exactly the quoted lamports from the wallet, exactly one memo
 * `forge:job:<jobId>` signed by the wallet, optional compute budget, nothing else; fee payer and
 * sole signer = the wallet; recipient = the cashbox when it is configured.
 */
export function verifyPaymentTransaction(tx: VersionedTransaction, expected: ExpectedPayment) {
  const decoded = decodeTransaction(tx);
  assertSoleSigner(decoded, expected.wallet);
  checkComputeBudget(decoded);
  const memo = `forge:job:${expected.jobId.toLowerCase()}`;
  let transfers = 0;
  let memos = 0;
  for (const ix of decoded.instructions) {
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        break;
      case SYSTEM_PROGRAM_ID: {
        if (ix.data.length !== 12 || readU32(ix.data, 0) !== 2 || ix.accounts.length !== 2) {
          fail('The payment contains an unexpected System instruction.');
        }
        const from = account(ix, 0);
        const to = account(ix, 1);
        if (from.key !== expected.wallet || !from.signer || !from.writable || !to.writable) {
          fail('The payment is not sent from your wallet.');
        }
        if (to.key === expected.wallet) fail('The payment recipient is your own wallet.');
        if (expected.cashbox && to.key !== expected.cashbox) {
          fail('The payment recipient is not the FORGE cashbox.');
        }
        if (readU64(ix.data, 4) !== expected.lamports) {
          fail('The payment amount does not match the quote.');
        }
        transfers += 1;
        break;
      }
      case MEMO_PROGRAM_ID: {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(ix.data);
        } catch {
          fail('The payment memo is not readable.');
        }
        if (text !== memo) fail('The payment memo does not match this job.');
        if (ix.accounts.length !== 1 || account(ix, 0).key !== expected.wallet) {
          fail('The payment memo is not signed by your wallet.');
        }
        memos += 1;
        break;
      }
      default:
        fail(`The payment calls an unexpected program (${ix.programId}).`);
    }
  }
  if (transfers !== 1) fail('The payment must contain exactly one transfer.');
  if (memos !== 1) fail('The payment must contain exactly one memo.');
}

/**
 * NEXT_PUBLIC_FORGE_CASHBOX_WALLET: refuses payments when it is invalid, and when it is unset in a
 * production build (fail closed: without it the recipient of a payment is not pinned). Null
 * (recipient not pinned) only outside production, for development and tests.
 */
export function configuredCashbox(): string | null {
  const raw = process.env.NEXT_PUBLIC_FORGE_CASHBOX_WALLET;
  if (!raw || raw.trim() === '') {
    if (process.env.NODE_ENV === 'production') {
      fail('Payments are misconfigured on this site (no cashbox address).');
    }
    return null;
  }
  const parsed = parseAddress(raw);
  if (!parsed) fail('Payments are misconfigured on this site (invalid cashbox address).');
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Partner fee claim
// ---------------------------------------------------------------------------------------------

/**
 * The partner claim @forge/core builds for the owner (receiver = payer = owner): compute budget,
 * idempotent creation of the wallet's own token accounts, DBC `claim_trading_fee` and
 * `claim_partner_pool_creation_fee` paying the wallet, closing the wallet's WSOL account back to
 * the wallet, and SOL moves between the wallet and its own WSOL account. Nothing else.
 */
export function verifyPartnerClaimTransaction(
  tx: VersionedTransaction,
  expected: { wallet: string },
) {
  const { wallet } = expected;
  const decoded = decodeTransaction(tx);
  assertSoleSigner(decoded, wallet);
  checkComputeBudget(decoded);
  const wsolAccount = associatedTokenAddress(wallet, WSOL_MINT, TOKEN_PROGRAM_ID);
  const tokenPrograms = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
  let claims = 0;
  for (const ix of decoded.instructions) {
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        break;
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        // CreateIdempotent: payer, account, owner, mint, system program, token program.
        if (ix.data.length !== 1 || ix.data[0] !== 1 || ix.accounts.length < 6) {
          fail(`The claim contains an unexpected token account ${where(ix)}.`);
        }
        const [payer, ata, owner, mint, system, program] = [0, 1, 2, 3, 4, 5].map((i) =>
          account(ix, i),
        ) as [
          DecodedAccount,
          DecodedAccount,
          DecodedAccount,
          DecodedAccount,
          DecodedAccount,
          DecodedAccount,
        ];
        if (
          payer.key !== wallet ||
          owner.key !== wallet ||
          system.key !== SYSTEM_PROGRAM_ID ||
          !tokenPrograms.has(program.key) ||
          ata.key !== associatedTokenAddress(wallet, mint.key, program.key)
        ) {
          fail('The claim creates a token account that is not yours.');
        }
        break;
      }
      case TOKEN_PROGRAM_ID: {
        const kind = ix.data[0];
        if (kind === 9 && ix.data.length === 1) {
          // CloseAccount: account, destination, owner.
          const [closed, destination, owner] = [0, 1, 2].map((i) => account(ix, i));
          if (closed!.key !== wsolAccount || destination!.key !== wallet || owner!.key !== wallet) {
            fail('The claim moves wrapped SOL somewhere else than your wallet.');
          }
        } else if (kind === 17 && ix.data.length === 1) {
          // SyncNative of the wallet's own WSOL account.
          if (account(ix, 0).key !== wsolAccount) fail('The claim touches another token account.');
        } else {
          fail(`The claim contains an unexpected token ${where(ix)}.`);
        }
        break;
      }
      case SYSTEM_PROGRAM_ID: {
        if (ix.data.length !== 12 || readU32(ix.data, 0) !== 2 || ix.accounts.length !== 2) {
          fail('The claim contains an unexpected System instruction.');
        }
        const from = account(ix, 0);
        const to = account(ix, 1);
        if (from.key !== wallet || (to.key !== wallet && to.key !== wsolAccount)) {
          fail('The claim sends SOL somewhere else than your wallet.');
        }
        break;
      }
      case DBC_PROGRAM_ID: {
        if (startsWith(ix.data, DBC_PARTNER_CLAIMS.claimTradingFee)) {
          // pool_authority, config, pool, token_a_account, token_b_account, base_vault,
          // quote_vault, base_mint, quote_mint, fee_claimer, token_base_program,
          // token_quote_program, event_authority, program.
          if (ix.accounts.length < 14) fail(`Malformed claim ${where(ix)}.`);
          const baseAccount = account(ix, 3).key;
          const quoteAccount = account(ix, 4).key;
          const baseMint = account(ix, 7).key;
          const quoteMint = account(ix, 8).key;
          const claimer = account(ix, 9);
          const baseProgram = account(ix, 10).key;
          const quoteProgram = account(ix, 11).key;
          if (claimer.key !== wallet || !claimer.signer) {
            fail('The claim is not made by your wallet.');
          }
          if (
            quoteMint !== WSOL_MINT ||
            quoteProgram !== TOKEN_PROGRAM_ID ||
            !tokenPrograms.has(baseProgram) ||
            baseAccount !== associatedTokenAddress(wallet, baseMint, baseProgram) ||
            quoteAccount !== wsolAccount
          ) {
            fail('The claimed fees are not paid to your own wallet.');
          }
        } else if (startsWith(ix.data, DBC_PARTNER_CLAIMS.claimPartnerPoolCreationFee)) {
          // config, pool, fee_claimer, fee_receiver, event_authority, program.
          if (ix.accounts.length < 4) fail(`Malformed claim ${where(ix)}.`);
          const claimer = account(ix, 2);
          if (claimer.key !== wallet || !claimer.signer) {
            fail('The claim is not made by your wallet.');
          }
          if (account(ix, 3).key !== wallet) fail('The claimed fees are not paid to your wallet.');
        } else {
          fail(`The claim calls an unexpected pool instruction (${where(ix)}).`);
        }
        claims += 1;
        break;
      }
      default:
        fail(`The claim calls an unexpected program (${ix.programId}).`);
    }
  }
  if (claims === 0) fail('The transaction does not claim any fees.');
}

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

export interface ExpectedLaunch {
  /** The signed-in wallet: fee payer, rent payer, buyer and receiver of the first buy. */
  wallet: string;
  /** The summary of the same server response, shown to the owner: what the launch must do. */
  summary: Pick<OwnerTransactionSummary, 'firstBuyLamports' | 'coinName' | 'coinSymbol'>;
  /**
   * The launch accounts of the same server response (`launch`): launchpad coin config and mint,
   * FORGE creator wallet, durable nonce account, coin metadata URI. Always required: a response
   * without them is refused (fail closed), in every environment.
   */
  launch: OwnerTransactionLaunch | null | undefined;
}

/**
 * The launch transaction prepared by FORGE: paid by the wallet, already signed by everyone else
 * (FORGE creator wallet, coin mint), only the wallet's signature missing, and exactly the launch
 * @forge/core builds (`verifyLaunchCoinTransaction`: durable nonce advance by the creator, the
 * pool creation of this coin, a first buy of exactly the summary's amount paid by and delivered to
 * the wallet, SOL moved only between the wallet and its own wrapped SOL account, the creator and
 * mint signatures valid, nothing else).
 *
 * Every account of the launch is pinned to the `launch` values of the server response: the
 * config, the mint, the creator wallet, the durable nonce account and the metadata URI must be
 * exactly those, not merely consistent within the transaction.
 */
export function verifyLaunchTransaction(tx: VersionedTransaction, expected: ExpectedLaunch) {
  const decoded = decodeTransaction(tx);
  if (decoded.feePayer !== expected.wallet) {
    fail('The launch transaction fee payer is not your wallet.');
  }
  for (const signer of decoded.requiredSigners) {
    if (signer === expected.wallet) {
      if (decoded.signed.has(signer)) fail('The launch transaction is already signed by you.');
    } else if (!decoded.signed.has(signer)) {
      fail('The launch transaction is missing a FORGE signature.');
    }
  }
  const { summary } = expected;
  if (!/^\d+$/.test(summary.firstBuyLamports)) fail('The launch summary is invalid.');
  if (expected.launch === null || expected.launch === undefined) {
    fail('The launch details are missing from the server response.');
  }
  const parsed = OwnerTransactionLaunch.safeParse(expected.launch);
  if (!parsed.success) fail('The launch details from the server are invalid.');
  const launch = parsed.data;
  try {
    verifyLaunchCoinTransaction(tx, {
      owner: expected.wallet,
      firstBuyLamports: BigInt(summary.firstBuyLamports),
      name: summary.coinName,
      symbol: summary.coinSymbol,
      config: launch.config,
      mint: launch.mint,
      creator: launch.creator,
      nonceAccount: launch.nonceAccount,
      metadataUri: launch.metadataUri,
    });
  } catch (err) {
    if (err instanceof LaunchTransactionCheckError) {
      fail(`The launch transaction does not match the launch you are approving: ${err.message}.`);
    }
    // A malformed expected value (e.g. an address that is not a canonical public key).
    if (err instanceof TypeError) fail('The launch details from the server are invalid.');
    throw err;
  }
}

/** The wallet returned the same message, now signed by the wallet. */
export function assertSignedByWallet(
  unsigned: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
): void {
  const before = unsigned.message.serialize();
  const after = signed.message.serialize();
  if (before.length !== after.length || before.some((b, i) => b !== after[i])) {
    fail('Your wallet changed the transaction before signing it.', NOTHING_SENT);
  }
  if (!decodeTransaction(signed).signed.has(wallet))
    fail('Your wallet did not sign.', NOTHING_SENT);
}

/**
 * Checks what the wallet returned: `check` again (a wallet may add a priority fee, which must stay
 * within bounds) and the wallet's own signature.
 */
export function assertSignedCopy(
  signed: VersionedTransaction,
  wallet: string,
  check: (tx: VersionedTransaction) => void,
): void {
  try {
    check(signed);
  } catch (err) {
    if (err instanceof TransactionCheckError) {
      throw new TransactionCheckError(
        `Your wallet changed the transaction: ${err.message.replace(` ${NOTHING_SIGNED}`, '')}`,
        NOTHING_SENT,
      );
    }
    throw err;
  }
  if (!decodeTransaction(signed).signed.has(wallet))
    fail('Your wallet did not sign.', NOTHING_SENT);
}
