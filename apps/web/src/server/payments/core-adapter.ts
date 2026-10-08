import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type Connection,
  type Finality,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { Base58Signature, Uuid } from '@forge/shared';
import { withRetry } from './retry';

/*
 * Stand-in for the payment API of @forge/core (packages/core/src/payments.ts, branch
 * w3/core-reads). Same exported names, signatures, result types and rules, so that the merge is a
 * drop-in:
 *
 *   buildPaymentTx(connection, { payer, lamports, jobId }, { env?, commitment?, retry? })
 *   verifyPayment(connection, signature, { payer, lamports, jobId }, { env?, cluster?, ... })
 *   assertCluster(connection, cluster, retry?)
 *
 * Minimal implementation: a plain SystemProgram transfer to FORGE_CASHBOX_WALLET plus an SPL Memo
 * v2 `forge:job:<jobId>` signed by the payer; verification parses the confirmed transaction.
 *
 * TODO(merge): replace with @forge/core at merge. This whole file becomes
 *   export { buildPaymentTx, verifyPayment, assertCluster, checkPaymentTransaction, paymentMemo,
 *            PaymentError, ... } from '@forge/core';
 * (and the cashbox is read by `requireAddresses` of packages/core/src/addresses.ts).
 */

export type AddressEnv = Readonly<Record<string, string | undefined>>;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

/** SPL Memo program v2 (the one wallets and explorers decode). */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** SPL Memo program v1 (legacy); accepted when reading a memo, never used to build one. */
export const MEMO_V1_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');

/** Prefix of the payment memo: `forge:job:<jobId>`. */
export const PAYMENT_MEMO_PREFIX = 'forge:job:';

/** Largest accepted payment (100 SOL): guards against a unit mistake upstream. */
export const MAX_PAYMENT_LAMPORTS = 100n * 1_000_000_000n;

/** Genesis hashes of the Solana clusters FORGE uses (public network constants). */
export const CLUSTER_GENESIS_HASH = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export type PaymentCluster = keyof typeof CLUSTER_GENESIS_HASH;

export type PaymentErrorCode =
  | 'invalid_job_id'
  | 'invalid_amount'
  | 'payer_is_cashbox'
  | 'cashbox_not_rent_exempt'
  | 'wrong_cluster';

/** Thrown on invalid input or configuration (never for a payment that is merely pending). */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

/** The memo carried by the payment of `jobId`. @throws PaymentError when `jobId` is not a UUID. */
export function paymentMemo(jobId: string): string {
  const parsed = Uuid.safeParse(jobId);
  if (!parsed.success) throw new PaymentError('invalid_job_id', 'jobId must be a UUID');
  return `${PAYMENT_MEMO_PREFIX}${parsed.data.toLowerCase()}`;
}

function assertLamports(lamports: bigint): void {
  if (typeof lamports !== 'bigint' || lamports <= 0n || lamports > MAX_PAYMENT_LAMPORTS) {
    throw new PaymentError('invalid_amount', 'Payment amount out of range');
  }
}

/** Same validation as `requireAddresses(['FORGE_CASHBOX_WALLET'])` of @forge/core. */
function resolveCashbox(env: AddressEnv | undefined): PublicKey {
  const value = (env ?? process.env).FORGE_CASHBOX_WALLET;
  let key: PublicKey | null = null;
  if (value) {
    try {
      key = new PublicKey(value);
    } catch {
      key = null;
    }
  }
  if (!key || key.toBase58() !== value || key.equals(PublicKey.default)) {
    const error = new Error('FORGE address configuration error (FORGE_CASHBOX_WALLET)');
    error.name = 'ForgeAddressError';
    throw error;
  }
  return key;
}

async function retryRpc<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return withRetry(fn, {
    attempts: options.attempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
  });
}

export interface PaymentParams {
  payer: PublicKey;
  lamports: bigint;
  jobId: string;
}

/** Pure: transfer to `cashbox`, then the memo signed by the payer. */
export function buildPaymentInstructions(
  params: PaymentParams & { cashbox: PublicKey },
): TransactionInstruction[] {
  assertLamports(params.lamports);
  const memo = paymentMemo(params.jobId);
  if (params.payer.equals(params.cashbox)) {
    throw new PaymentError('payer_is_cashbox', 'The payer cannot be the cashbox');
  }
  return [
    SystemProgram.transfer({
      fromPubkey: params.payer,
      toPubkey: params.cashbox,
      lamports: params.lamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: params.payer, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, 'utf8'),
    }),
  ];
}

export interface PaymentTxOptions {
  env?: AddressEnv;
  commitment?: Commitment;
  retry?: RetryOptions;
}

export interface PaymentTxResult {
  /** Unsigned transaction: fee payer = payer, recent blockhash set. The payer signs it. */
  transaction: Transaction;
  lastValidBlockHeight: number;
  recipient: PublicKey;
  lamports: bigint;
  memo: string;
}

/** Builds the payment of `jobId`; refuses when the cashbox would not be rent-exempt. */
export async function buildPaymentTx(
  connection: Connection,
  params: PaymentParams,
  options: PaymentTxOptions = {},
): Promise<PaymentTxResult> {
  const cashbox = resolveCashbox(options.env);
  const instructions = buildPaymentInstructions({ ...params, cashbox });
  const commitment = options.commitment ?? 'confirmed';
  const [rentExempt, cashboxBalance] = await Promise.all([
    retryRpc(() => connection.getMinimumBalanceForRentExemption(0, commitment), options.retry),
    retryRpc(() => connection.getBalance(cashbox, commitment), options.retry),
  ]);
  if (BigInt(cashboxBalance) + params.lamports < BigInt(rentExempt)) {
    throw new PaymentError(
      'cashbox_not_rent_exempt',
      'The cashbox would not be rent-exempt after this payment: fund it first',
    );
  }
  const { blockhash, lastValidBlockHeight } = await retryRpc(
    () => connection.getLatestBlockhash(commitment),
    options.retry,
  );
  const transaction = new Transaction({
    feePayer: params.payer,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);
  return {
    transaction,
    lastValidBlockHeight,
    recipient: cashbox,
    lamports: params.lamports,
    memo: paymentMemo(params.jobId),
  };
}

export type PaymentRejectReason =
  | 'malformed_signature'
  | 'transaction_failed'
  | 'missing_meta'
  | 'payer_not_signer'
  | 'recipient_mismatch'
  | 'multiple_transfers'
  | 'payer_mismatch'
  | 'amount_mismatch'
  | 'memo_missing'
  | 'memo_mismatch';

export type PaymentVerification =
  | { status: 'pending'; signature: string }
  | {
      status: 'invalid';
      signature: string;
      reason: PaymentRejectReason;
      /** Human-readable detail (addresses and amounts): never sent to the client. */
      detail: string;
      slot: number | null;
    }
  | {
      status: 'confirmed';
      signature: string;
      slot: number;
      /** Unix seconds, when the RPC knows it: compared with the quote expiry by the caller. */
      blockTime: number | null;
      confirmationStatus: Finality;
      payer: PublicKey;
      recipient: PublicKey;
      lamports: bigint;
      memo: string;
      fee: bigint;
    };

export interface ExpectedPayment {
  payer: PublicKey;
  lamports: bigint;
  jobId: string;
}

export interface VerifyPaymentOptions {
  env?: AddressEnv;
  cluster?: PaymentCluster;
  commitment?: Finality;
  retry?: RetryOptions;
}

const genesisCache = new WeakMap<Connection, Promise<string>>();

/** Throws `PaymentError('wrong_cluster')` unless `connection` serves `cluster`. */
export async function assertCluster(
  connection: Connection,
  cluster: PaymentCluster,
  retry?: RetryOptions,
): Promise<void> {
  let pending = genesisCache.get(connection);
  if (!pending) {
    pending = retryRpc(() => connection.getGenesisHash(), retry);
    genesisCache.set(connection, pending);
    pending.catch(() => genesisCache.delete(connection));
  }
  const genesis = await pending;
  if (genesis !== CLUSTER_GENESIS_HASH[cluster]) {
    throw new PaymentError('wrong_cluster', `The RPC connection is not on ${cluster}`);
  }
}

function resolveCluster(options: VerifyPaymentOptions): PaymentCluster {
  if (options.cluster) return options.cluster;
  const fromEnv = (options.env ?? process.env).SOLANA_CLUSTER;
  if (fromEnv === undefined || fromEnv === '') return 'devnet';
  if (fromEnv === 'devnet' || fromEnv === 'mainnet-beta') return fromEnv;
  throw new PaymentError('wrong_cluster', 'SOLANA_CLUSTER must be devnet or mainnet-beta');
}

const COMMITMENT_RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

function invalid(
  signature: string,
  reason: PaymentRejectReason,
  detail: string,
  slot: number | null,
): PaymentVerification {
  return { status: 'invalid', signature, reason, detail, slot };
}

/** Verifies `signature` against `expected` (exact amount, single transfer, single memo). */
export async function verifyPayment(
  connection: Connection,
  signature: string,
  expected: ExpectedPayment,
  options: VerifyPaymentOptions = {},
): Promise<PaymentVerification> {
  const cashbox = resolveCashbox(options.env);
  assertLamports(expected.lamports);
  const memo = paymentMemo(expected.jobId);
  const commitment: Finality = options.commitment ?? 'confirmed';
  await assertCluster(connection, resolveCluster(options), options.retry);

  if (!Base58Signature.safeParse(signature).success) {
    return invalid(signature, 'malformed_signature', 'Not a base58 transaction signature', null);
  }
  const status = (
    await retryRpc(
      () => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      options.retry,
    )
  ).value[0];
  if (!status) return { status: 'pending', signature };
  const reached = COMMITMENT_RANK[status.confirmationStatus ?? 'processed'] ?? 0;
  if (reached < (COMMITMENT_RANK[commitment] ?? 1)) return { status: 'pending', signature };
  if (status.err)
    return invalid(signature, 'transaction_failed', 'Transaction failed', status.slot);

  const tx = await retryRpc(
    () => connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 }),
    options.retry,
  );
  if (!tx) return { status: 'pending', signature };
  return checkPaymentTransaction(tx, signature, {
    cashbox,
    payer: expected.payer,
    lamports: expected.lamports,
    memo,
    confirmationStatus: status.confirmationStatus === 'finalized' ? 'finalized' : commitment,
  });
}

export interface PaymentCheck {
  cashbox: PublicKey;
  payer: PublicKey;
  lamports: bigint;
  memo: string;
  confirmationStatus: Finality;
}

/** Lamports of a SystemProgram `Transfer` instruction, or null for any other instruction. */
export function decodeSystemTransfer(data: Uint8Array): bigint | null {
  if (data.length !== 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 2) return null;
  return view.getBigUint64(4, true);
}

/** Pure: checks a fetched transaction against the expected payment (see `verifyPayment`). */
export function checkPaymentTransaction(
  tx: VersionedTransactionResponse,
  signature: string,
  check: PaymentCheck,
): PaymentVerification {
  const slot = tx.slot;
  const meta = tx.meta;
  if (!meta) return invalid(signature, 'missing_meta', 'Transaction has no status meta', slot);
  if (meta.err) return invalid(signature, 'transaction_failed', 'Transaction failed', slot);

  const message = tx.transaction.message;
  let keys: PublicKey[];
  try {
    const accountKeys =
      message.version === 'legacy'
        ? message.getAccountKeys()
        : message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? null });
    keys = accountKeys.keySegments().flat();
  } catch {
    return invalid(signature, 'missing_meta', 'Lookup table addresses not loaded', slot);
  }
  const payerIndex = message.staticAccountKeys.findIndex((k) => k.equals(check.payer));
  if (payerIndex < 0 || payerIndex >= message.header.numRequiredSignatures) {
    return invalid(signature, 'payer_not_signer', 'The payer did not sign', slot);
  }

  const transfers: { from: PublicKey; lamports: bigint }[] = [];
  const memos: string[] = [];
  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) continue;
    if (program.equals(SystemProgram.programId)) {
      const lamports = decodeSystemTransfer(ix.data);
      if (lamports === null) continue;
      const from = keys[ix.accountKeyIndexes[0] ?? -1];
      const to = keys[ix.accountKeyIndexes[1] ?? -1];
      if (!from || !to || !to.equals(check.cashbox)) continue;
      transfers.push({ from, lamports });
    } else if (program.equals(MEMO_PROGRAM_ID) || program.equals(MEMO_V1_PROGRAM_ID)) {
      memos.push(Buffer.from(ix.data).toString('utf8'));
    }
  }

  if (transfers.length === 0) {
    return invalid(signature, 'recipient_mismatch', 'No transfer to the cashbox', slot);
  }
  if (transfers.length > 1) {
    return invalid(signature, 'multiple_transfers', 'More than one transfer to the cashbox', slot);
  }
  const transfer = transfers[0]!;
  if (!transfer.from.equals(check.payer)) {
    return invalid(signature, 'payer_mismatch', 'Transfer does not come from the payer', slot);
  }
  if (transfer.lamports !== check.lamports) {
    return invalid(signature, 'amount_mismatch', 'Transfer amount differs from the quote', slot);
  }
  const cashboxIndex = keys.findIndex((k) => k.equals(check.cashbox));
  const pre = meta.preBalances[cashboxIndex];
  const post = meta.postBalances[cashboxIndex];
  if (pre === undefined || post === undefined || BigInt(post) - BigInt(pre) < check.lamports) {
    return invalid(signature, 'amount_mismatch', 'The cashbox balance did not grow enough', slot);
  }
  if (memos.length === 0) return invalid(signature, 'memo_missing', 'No memo instruction', slot);
  if (memos.length > 1 || memos[0] !== check.memo) {
    return invalid(signature, 'memo_mismatch', 'Memo does not match the job', slot);
  }

  return {
    status: 'confirmed',
    signature,
    slot,
    blockTime: tx.blockTime ?? null,
    confirmationStatus: check.confirmationStatus,
    payer: check.payer,
    recipient: check.cashbox,
    lamports: transfer.lamports,
    memo: check.memo,
    fee: BigInt(meta.fee),
  };
}
