/**
 * Transaction helpers shared by the transaction builders of @forge/core.
 *
 * - Confirmation by polling `getSignatureStatuses` with a deadline (docs/DECISIONS.md: websocket
 *   subscriptions get rate-limited and made web3.js report landed transactions as expired).
 * - Base64 (de)serialization of partially signed legacy transactions (docs/INTERFACES.md §6-7:
 *   transactions travel as base64, signatures as base58).
 * - Size, signature and compute budget helpers.
 * - Durable nonce helpers: reading a nonce account and building the transaction that creates one.
 * - Rent-exemption checks that read the rent from the cluster (never hard-coded).
 *
 * Nothing here signs or sends a transaction.
 */
import {
  ComputeBudgetProgram,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment,
  type Connection,
  type TransactionError,
  type TransactionInstruction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** The transaction landed but failed on-chain. Holds the raw `TransactionError` from the RPC. */
export class TransactionFailedError extends Error {
  readonly signature: string;
  readonly transactionError: TransactionError;

  constructor(signature: string, transactionError: TransactionError) {
    super(`Transaction ${signature} failed on-chain: ${JSON.stringify(transactionError)}`);
    this.name = 'TransactionFailedError';
    this.signature = signature;
    this.transactionError = transactionError;
  }
}

/** The blockhash of the transaction expired before it was seen by the cluster. */
export class TransactionExpiredError extends Error {
  readonly signature: string;

  constructor(signature: string, lastValidBlockHeight: number) {
    super(
      `Transaction ${signature} was not confirmed before block height ${lastValidBlockHeight}: it expired and can be rebuilt`,
    );
    this.name = 'TransactionExpiredError';
    this.signature = signature;
  }
}

/**
 * The deadline passed without a confirmation. The transaction may still land (a durable nonce
 * transaction stays valid until its nonce advances): never rebuild it blindly, check its status.
 */
export class ConfirmationTimeoutError extends Error {
  readonly signature: string;
  /** Last network error seen while polling, if any (message only). */
  readonly lastNetworkError: string | null;

  constructor(signature: string, deadlineMs: number, lastNetworkError: string | null) {
    super(
      `Transaction ${signature} not confirmed within ${deadlineMs} ms` +
        (lastNetworkError ? ` (last RPC error: ${lastNetworkError})` : ''),
    );
    this.name = 'ConfirmationTimeoutError';
    this.signature = signature;
    this.lastNetworkError = lastNetworkError;
  }
}

export type TransactionEncodingErrorCode =
  'INVALID_BASE64' | 'TOO_LARGE' | 'INVALID_TRANSACTION' | 'INVALID_SIGNATURE';

/** A transaction could not be encoded or decoded. */
export class TransactionEncodingError extends Error {
  readonly code: TransactionEncodingErrorCode;

  constructor(code: TransactionEncodingErrorCode, message: string) {
    super(message);
    this.name = 'TransactionEncodingError';
    this.code = code;
  }
}

export type DurableNonceErrorCode = 'NOT_FOUND' | 'NOT_A_NONCE_ACCOUNT' | 'AUTHORITY_MISMATCH';

/** A durable nonce account is missing, malformed or held by another authority. */
export class DurableNonceError extends Error {
  readonly code: DurableNonceErrorCode;
  readonly nonceAccount: string;

  constructor(code: DurableNonceErrorCode, nonceAccount: PublicKey, message: string) {
    super(`Nonce account ${nonceAccount.toBase58()}: ${message}`);
    this.name = 'DurableNonceError';
    this.code = code;
    this.nonceAccount = nonceAccount.toBase58();
  }
}

/** One or more accounts that must already be rent-exempt are not. */
export class RentExemptionError extends Error {
  readonly accounts: readonly { label: string; address: string; reason: string }[];

  constructor(accounts: readonly { label: string; address: string; reason: string }[]) {
    super(
      `Account(s) not rent-exempt: ${accounts
        .map((a) => `${a.label} ${a.address} (${a.reason})`)
        .join('; ')}`,
    );
    this.name = 'RentExemptionError';
    this.accounts = accounts;
  }
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------

/** The connection methods `confirmSignature` uses (a `Connection` satisfies it). */
export type SignatureStatusReader = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>;

export interface ConfirmSignatureOptions {
  /** How long to wait, in milliseconds from the call, before giving up. */
  deadlineMs: number;
  /** Delay between two polls (default 1500 ms). Doubled after each network error, up to 8x. */
  pollIntervalMs?: number;
  /** `confirmed` (default) or `finalized`. */
  commitment?: 'confirmed' | 'finalized';
  /**
   * For a transaction built on a recent blockhash: once the cluster passes this block height
   * without seeing the transaction, it can no longer land (`TransactionExpiredError`). Leave it
   * out for durable nonce transactions.
   */
  lastValidBlockHeight?: number;
  /** Injectable clock and sleep, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConfirmedSignature {
  signature: string;
  slot: number;
  confirmationStatus: 'confirmed' | 'finalized';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Waits until `signature` reaches `commitment`, by polling `getSignatureStatuses`.
 *
 * - On-chain failure: throws `TransactionFailedError` (never swallowed).
 * - Network errors while polling: retried with backoff until the deadline; the last one is
 *   reported in the `ConfirmationTimeoutError`.
 * - `lastValidBlockHeight` passed and exceeded: throws `TransactionExpiredError` after a final
 *   status check with the transaction history.
 */
export async function confirmSignature(
  connection: SignatureStatusReader,
  signature: string,
  options: ConfirmSignatureOptions,
): Promise<ConfirmedSignature> {
  const { deadlineMs } = options;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError('deadlineMs must be a positive number of milliseconds');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const commitment = options.commitment ?? 'confirmed';
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + deadlineMs;
  let lastNetworkError: string | null = null;
  let backoff = 1;

  const check = async (searchTransactionHistory: boolean): Promise<ConfirmedSignature | null> => {
    const status = (
      await connection.getSignatureStatuses([signature], { searchTransactionHistory })
    ).value[0];
    if (!status) return null;
    if (status.err) throw new TransactionFailedError(signature, status.err);
    const reached =
      status.confirmationStatus === 'finalized' ||
      (commitment === 'confirmed' && status.confirmationStatus === 'confirmed');
    if (!reached || !status.confirmationStatus) return null;
    return {
      signature,
      slot: status.slot,
      confirmationStatus: status.confirmationStatus as 'confirmed' | 'finalized',
    };
  };

  for (;;) {
    try {
      const confirmed = await check(false);
      if (confirmed) return confirmed;
      if (options.lastValidBlockHeight !== undefined) {
        const height = await connection.getBlockHeight(commitment as Commitment);
        if (height > options.lastValidBlockHeight) {
          const last = await check(true);
          if (last) return last;
          throw new TransactionExpiredError(signature, options.lastValidBlockHeight);
        }
      }
      backoff = 1;
    } catch (error) {
      if (error instanceof TransactionFailedError || error instanceof TransactionExpiredError) {
        throw error;
      }
      lastNetworkError = errorMessage(error);
      backoff = Math.min(backoff * 2, 8);
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs * backoff, remaining));
  }

  // Deadline reached: one last look, including the transaction history.
  try {
    const last = await check(true);
    if (last) return last;
  } catch (error) {
    if (error instanceof TransactionFailedError) throw error;
    lastNetworkError = errorMessage(error);
  }
  throw new ConfirmationTimeoutError(signature, deadlineMs, lastNetworkError);
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

/** Largest serialized transaction the cluster accepts (bytes). */
export const MAX_TRANSACTION_BYTES = PACKET_DATA_SIZE;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Serializes a (possibly partially) signed legacy transaction to base64.
 * Missing signatures are allowed by default; every signature present is verified.
 *
 * @throws TransactionEncodingError when a present signature is invalid or the transaction is
 *   larger than `MAX_TRANSACTION_BYTES`.
 */
export function serializeTransactionBase64(
  transaction: Transaction,
  options: { requireAllSignatures?: boolean } = {},
): string {
  let bytes: Buffer;
  try {
    bytes = transaction.serialize({
      requireAllSignatures: options.requireAllSignatures ?? false,
      verifySignatures: true,
    });
  } catch (error) {
    throw new TransactionEncodingError(
      'INVALID_SIGNATURE',
      `cannot serialize transaction: ${errorMessage(error)}`,
    );
  }
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new TransactionEncodingError(
      'TOO_LARGE',
      `transaction is ${bytes.length} bytes (limit ${MAX_TRANSACTION_BYTES})`,
    );
  }
  return bytes.toString('base64');
}

/**
 * Decodes a base64 legacy transaction. The message is kept byte for byte, so the signatures
 * already present stay valid when it is signed again and re-serialized.
 *
 * @throws TransactionEncodingError on bad base64, an oversized payload, a payload that is not a
 *   transaction, or a present signature that does not verify.
 */
export function deserializeTransactionBase64(base64: string): Transaction {
  if (typeof base64 !== 'string' || base64.length === 0 || !BASE64_RE.test(base64)) {
    throw new TransactionEncodingError('INVALID_BASE64', 'transaction must be a base64 string');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) {
    throw new TransactionEncodingError('INVALID_BASE64', 'transaction is not canonical base64');
  }
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new TransactionEncodingError(
      'TOO_LARGE',
      `transaction is ${bytes.length} bytes (limit ${MAX_TRANSACTION_BYTES})`,
    );
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.from(bytes);
  } catch (error) {
    throw new TransactionEncodingError(
      'INVALID_TRANSACTION',
      `not a legacy transaction: ${errorMessage(error)}`,
    );
  }
  if (!transaction.verifySignatures(false)) {
    throw new TransactionEncodingError(
      'INVALID_SIGNATURE',
      'a signature present in the transaction does not verify',
    );
  }
  return transaction;
}

function shortVecLength(value: number): number {
  let bytes = 1;
  for (let rest = value >> 7; rest > 0; rest >>= 7) bytes++;
  return bytes;
}

/**
 * Serialized size in bytes (signature slots included, signed or not). Unlike `serialize()`, it
 * does not throw above the limit, so the caller can report by how much it is exceeded.
 */
export function transactionSize(transaction: Transaction): number {
  const message = transaction.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  return shortVecLength(signatures) + 64 * signatures + message.serialize().length;
}

/** Required signers of the compiled message that have not signed yet, in message order. */
export function missingSigners(transaction: Transaction): PublicKey[] {
  const message = transaction.compileMessage();
  const required = message.accountKeys.slice(0, message.header.numRequiredSignatures);
  return required.filter((key) => {
    const entry = transaction.signatures.find((s) => s.publicKey.equals(key));
    return !entry || entry.signature === null;
  });
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 encoding (Bitcoin alphabet), as used for Solana signatures and keys. */
export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * The transaction signature (base58 of the fee payer's signature), or null while the fee payer
 * has not signed. Known before sending, so it can be recorded first (idempotent retries).
 */
export function transactionSignature(transaction: Transaction): string | null {
  const signature = transaction.signature;
  return signature ? encodeBase58(signature) : null;
}

/** Required signers of the compiled message, in message order (the fee payer first). */
export function requiredSigners(transaction: Transaction): PublicKey[] {
  const message = transaction.compileMessage();
  return message.accountKeys.slice(0, message.header.numRequiredSignatures);
}

// ---------------------------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------------------------

export interface ComputeBudget {
  /** Compute unit limit of the transaction. */
  units: number;
  /** Priority fee in micro-lamports per compute unit (0 = no priority fee). */
  microLamports: number;
}

const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * `setComputeUnitLimit`, plus `setComputeUnitPrice` when a priority fee is set (a zero price
 * instruction would only cost 12 bytes of a tight transaction).
 */
export function computeBudgetInstructions(budget: ComputeBudget): TransactionInstruction[] {
  if (!Number.isInteger(budget.units) || budget.units <= 0 || budget.units > MAX_COMPUTE_UNITS) {
    throw new RangeError(
      `compute unit limit must be an integer between 1 and ${MAX_COMPUTE_UNITS}`,
    );
  }
  if (!Number.isSafeInteger(budget.microLamports) || budget.microLamports < 0) {
    throw new RangeError('compute unit price must be a non-negative integer (micro-lamports)');
  }
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: budget.units })];
  if (budget.microLamports > 0) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget.microLamports }),
    );
  }
  return instructions;
}

/** Priority fee paid for a compute budget, in lamports (rounded up, like the runtime). */
export function priorityFeeLamports(budget: ComputeBudget): bigint {
  const microLamports = BigInt(budget.units) * BigInt(budget.microLamports);
  return (microLamports + 999_999n) / 1_000_000n;
}

// ---------------------------------------------------------------------------------------------
// Durable nonce
// ---------------------------------------------------------------------------------------------

export interface NonceInfo {
  nonceAccount: PublicKey;
  /** Current nonce value: used as the transaction's `recentBlockhash`. */
  nonce: string;
  authority: PublicKey;
  /** Fee per signature recorded in the nonce account. */
  lamportsPerSignature: bigint;
}

/**
 * Reads a durable nonce account from the cluster.
 *
 * @throws DurableNonceError `NOT_FOUND` when the account does not exist, `NOT_A_NONCE_ACCOUNT`
 *   when it is not an initialized system nonce account, `AUTHORITY_MISMATCH` when
 *   `expectedAuthority` is given and differs.
 */
export async function readNonce(
  connection: Pick<Connection, 'getAccountInfo'>,
  nonceAccount: PublicKey,
  options: { expectedAuthority?: PublicKey; commitment?: Commitment } = {},
): Promise<NonceInfo> {
  const account = await connection.getAccountInfo(nonceAccount, options.commitment ?? 'confirmed');
  if (!account) {
    throw new DurableNonceError('NOT_FOUND', nonceAccount, 'account does not exist');
  }
  if (
    !account.owner.equals(SystemProgram.programId) ||
    account.data.length !== NONCE_ACCOUNT_LENGTH
  ) {
    throw new DurableNonceError('NOT_A_NONCE_ACCOUNT', nonceAccount, 'not a system nonce account');
  }
  // Layout: version (u32), state (u32: 0 = uninitialized, 1 = initialized), authority, nonce, fee.
  const state = Buffer.from(account.data).readUInt32LE(4);
  let decoded: NonceAccount;
  try {
    decoded = NonceAccount.fromAccountData(account.data);
  } catch (error) {
    throw new DurableNonceError('NOT_A_NONCE_ACCOUNT', nonceAccount, errorMessage(error));
  }
  if (state !== 1 || decoded.authorizedPubkey.equals(PublicKey.default)) {
    throw new DurableNonceError('NOT_A_NONCE_ACCOUNT', nonceAccount, 'nonce is not initialized');
  }
  if (options.expectedAuthority && !decoded.authorizedPubkey.equals(options.expectedAuthority)) {
    throw new DurableNonceError(
      'AUTHORITY_MISMATCH',
      nonceAccount,
      `authority is ${decoded.authorizedPubkey.toBase58()}, expected ${options.expectedAuthority.toBase58()}`,
    );
  }
  return {
    nonceAccount,
    nonce: decoded.nonce,
    authority: decoded.authorizedPubkey,
    lamportsPerSignature: BigInt(decoded.feeCalculator.lamportsPerSignature),
  };
}

export interface BuildCreateNonceAccountTxParams {
  connection: Pick<Connection, 'getMinimumBalanceForRentExemption' | 'getLatestBlockhash'>;
  /** Pays the rent and the fee; signs. */
  payer: PublicKey;
  /** Address of the new nonce account: a fresh keypair held by the caller, which signs too. */
  nonceAccount: PublicKey | { publicKey: PublicKey };
  /** Who may advance the nonce (and therefore must sign every transaction that uses it). */
  authority: PublicKey;
  /** Optional priority fee; no compute budget instruction is added when absent. */
  computeUnitPriceMicroLamports?: number;
}

export interface CreateNonceAccountTx {
  transaction: Transaction;
  nonceAccount: PublicKey;
  /** Rent deposit of the nonce account, read from the cluster. */
  rentLamports: bigint;
  lastValidBlockHeight: number;
  /** Who must sign: payer and the nonce account keypair. */
  signers: PublicKey[];
}

/**
 * Unsigned transaction creating and initializing a durable nonce account
 * (`SystemProgram.createNonceAccount`). The rent is read from the cluster.
 */
export async function buildCreateNonceAccountTx(
  params: BuildCreateNonceAccountTxParams,
): Promise<CreateNonceAccountTx> {
  const nonceAccount =
    params.nonceAccount instanceof PublicKey ? params.nonceAccount : params.nonceAccount.publicKey;
  if (nonceAccount.equals(params.payer)) {
    throw new RangeError('the nonce account must be a fresh keypair, not the payer');
  }
  const rent = await params.connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const { blockhash, lastValidBlockHeight } =
    await params.connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: params.payer, blockhash, lastValidBlockHeight });
  if (params.computeUnitPriceMicroLamports !== undefined) {
    transaction.add(
      ...computeBudgetInstructions({
        units: 10_000,
        microLamports: params.computeUnitPriceMicroLamports,
      }),
    );
  }
  transaction.add(
    SystemProgram.createNonceAccount({
      fromPubkey: params.payer,
      noncePubkey: nonceAccount,
      authorizedPubkey: params.authority,
      lamports: rent,
    }),
  );
  return {
    transaction,
    nonceAccount,
    rentLamports: BigInt(rent),
    lastValidBlockHeight,
    signers: [params.payer, nonceAccount],
  };
}

// ---------------------------------------------------------------------------------------------
// Rent exemption
// ---------------------------------------------------------------------------------------------

export interface RentCheckTarget {
  address: PublicKey;
  /** Name shown in the error, e.g. `referralTokenAccount`. */
  label: string;
}

/**
 * Checks that every account exists and holds at least the rent-exempt minimum for its size
 * (read from the cluster). A lamport transfer to an account that would stay below that minimum
 * makes the whole transaction fail (devnet finding, docs/DECISIONS.md).
 *
 * @throws RentExemptionError listing every account that fails.
 */
export async function assertRentExempt(
  connection: Pick<Connection, 'getMultipleAccountsInfo' | 'getMinimumBalanceForRentExemption'>,
  targets: readonly RentCheckTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  const infos = await connection.getMultipleAccountsInfo(
    targets.map((t) => t.address),
    'confirmed',
  );
  const failures: { label: string; address: string; reason: string }[] = [];
  const rentBySize = new Map<number, number>();
  for (const [index, target] of targets.entries()) {
    const info = infos[index];
    if (!info) {
      failures.push({ label: target.label, address: target.address.toBase58(), reason: 'missing' });
      continue;
    }
    const size = info.data.length;
    let rent = rentBySize.get(size);
    if (rent === undefined) {
      rent = await connection.getMinimumBalanceForRentExemption(size);
      rentBySize.set(size, rent);
    }
    if (info.lamports < rent) {
      failures.push({
        label: target.label,
        address: target.address.toBase58(),
        reason: `holds ${info.lamports} lamports, rent-exempt minimum is ${rent}`,
      });
    }
  }
  if (failures.length > 0) throw new RentExemptionError(failures);
}
