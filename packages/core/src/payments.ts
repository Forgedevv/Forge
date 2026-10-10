/**
 * Client payments to the FORGE cashbox (docs/INTERFACES.md §6 `/api/payments/*`, SECURITY.md §10).
 *
 * `buildPaymentTx` returns an UNSIGNED transaction made of exactly two instructions:
 *   1. a System Program transfer of `lamports` from the payer to `FORGE_CASHBOX_WALLET`;
 *   2. an SPL Memo (v2) instruction, signed by the payer, whose UTF-8 data is
 *      `forge:job:<jobId>` (`jobId` = the job UUID, lowercase). See `paymentMemo`.
 *
 * `verifyPayment` checks a transaction on-chain and returns a typed result; it never throws on a
 * transaction that is "not there yet" (it returns `pending`). It throws only on configuration
 * errors (wrong cluster, missing cashbox address) and on non-transient RPC failures.
 *
 * Replay: a valid signature stays valid forever. `verifyPayment` reports the signature and its
 * slot; callers MUST record the signature as used (unique `payments.tx_signature`) before marking
 * anything as paid. The amount must be exact (decision). Pass the quote window
 * (`notBefore` / `expiresAt`) so a payment that landed outside it is `invalid`; when the block
 * time is not known yet the result stays `pending`.
 */
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
import { requireAddresses, type AddressEnv } from './addresses.js';
import { LAMPORTS_PER_SOL_BIGINT } from './constants.js';
import { retryRpc, type RetryOptions } from './reads.js';

/** SPL Memo program v2 (the one wallets and explorers decode). */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** SPL Memo program v1 (legacy); accepted when reading a memo, never used to build one. */
export const MEMO_V1_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');

/** Prefix of the payment memo: `forge:job:<jobId>`. */
export const PAYMENT_MEMO_PREFIX = 'forge:job:';

/**
 * Largest payment `buildPaymentTx` accepts (100 SOL): far above any FORGE price, it only guards
 * against a unit mistake upstream.
 */
export const MAX_PAYMENT_LAMPORTS = 100n * LAMPORTS_PER_SOL_BIGINT;

/** Genesis hashes of the Solana clusters FORGE uses (public network constants). */
export const CLUSTER_GENESIS_HASH = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export type PaymentCluster = keyof typeof CLUSTER_GENESIS_HASH;

/** System Program `Transfer` instruction index (u32 LE), followed by lamports (u64 LE). */
const SYSTEM_TRANSFER_INDEX = 2;

export type PaymentErrorCode =
  | 'invalid_job_id'
  | 'invalid_amount'
  | 'payer_is_cashbox'
  | 'cashbox_not_rent_exempt'
  | 'invalid_window'
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
    throw new PaymentError(
      'invalid_amount',
      `Payment amount must be a bigint between 1 and ${MAX_PAYMENT_LAMPORTS} lamports`,
    );
  }
}

function resolveCashbox(env: AddressEnv | undefined): PublicKey {
  return requireAddresses(['FORGE_CASHBOX_WALLET'], env).FORGE_CASHBOX_WALLET;
}

export interface PaymentParams {
  payer: PublicKey;
  lamports: bigint;
  jobId: string;
}

/**
 * Pure: the two instructions of a payment (transfer to `cashbox`, then the memo signed by the
 * payer). @throws PaymentError on invalid input.
 */
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
  /** Where `FORGE_CASHBOX_WALLET` is read from (defaults to `process.env`). */
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

/**
 * Builds the payment transaction of `jobId`. Checks that the cashbox will be rent-exempt after
 * receiving the payment (rent read from the cluster), otherwise the transfer would fail.
 * @throws PaymentError on invalid input or a cashbox that cannot receive this amount.
 */
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
  | 'memo_mismatch'
  | 'payment_too_early'
  | 'payment_expired';

/** Why a payment is not decided yet. */
export type PaymentPendingReason =
  'not_found' | 'below_commitment' | 'transaction_not_served' | 'block_time_unknown';

export type PaymentVerification =
  | {
      /** Not visible at the required commitment yet (or unknown): poll again later. */
      status: 'pending';
      signature: string;
      reason: PaymentPendingReason;
    }
  | {
      status: 'invalid';
      signature: string;
      reason: PaymentRejectReason;
      /** Human-readable detail (addresses and amounts only). */
      detail: string;
      slot: number | null;
    }
  | {
      status: 'confirmed';
      signature: string;
      /** Slot of the transaction: record it with the signature (idempotency, audit). */
      slot: number;
      /** Unix seconds, when the RPC knows it: compare with the quote expiry. */
      blockTime: number | null;
      confirmationStatus: Finality;
      payer: PublicKey;
      recipient: PublicKey;
      lamports: bigint;
      memo: string;
      /** Network fee paid by the transaction, lamports. */
      fee: bigint;
    };

export interface ExpectedPayment {
  payer: PublicKey;
  /** Exact amount (a different amount is `amount_mismatch`). */
  lamports: bigint;
  jobId: string;
  /**
   * Optional window the transaction's block time must fall in (inclusive bounds). Outside it:
   * `invalid` (`payment_too_early` / `payment_expired`); block time unknown: `pending`.
   * Block times are approximate (seconds, validator clock): add any tolerance to the bounds.
   */
  notBefore?: Date;
  expiresAt?: Date;
}

export interface VerifyPaymentOptions {
  /** Where `FORGE_CASHBOX_WALLET` and `SOLANA_CLUSTER` are read from (defaults to `process.env`). */
  env?: AddressEnv;
  /** Cluster the payment must be on; defaults to `env.SOLANA_CLUSTER`, then `devnet`. */
  cluster?: PaymentCluster;
  /** Required commitment (default `confirmed`). */
  commitment?: Finality;
  retry?: RetryOptions;
}

const genesisCache = new WeakMap<Connection, Promise<string>>();

/** Throws unless `connection` points to `cluster` (genesis hash check, cached per connection). */
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
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
  const fromEnv = env.SOLANA_CLUSTER;
  if (fromEnv === undefined || fromEnv === '') return 'devnet';
  if (fromEnv === 'devnet' || fromEnv === 'mainnet-beta') return fromEnv;
  throw new PaymentError('wrong_cluster', 'SOLANA_CLUSTER must be devnet or mainnet-beta');
}

const COMMITMENT_RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Throws `invalid_window` unless the window bounds are valid dates, in order. */
function assertWindow(expected: Pick<ExpectedPayment, 'notBefore' | 'expiresAt'>): void {
  const { notBefore, expiresAt } = expected;
  for (const [name, value] of [
    ['notBefore', notBefore],
    ['expiresAt', expiresAt],
  ] as const) {
    if (value !== undefined && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
      throw new PaymentError('invalid_window', `${name} must be a valid Date`);
    }
  }
  if (notBefore && expiresAt && notBefore.getTime() > expiresAt.getTime()) {
    throw new PaymentError('invalid_window', 'notBefore must not be after expiresAt');
  }
}

/**
 * Verifies the payment `signature` against `expected`:
 * - the RPC is on the expected cluster (otherwise throws `PaymentError('wrong_cluster')`);
 * - the transaction is visible at the required commitment (otherwise `pending`) and did not fail;
 * - `expected.payer` signed it;
 * - it holds exactly one top-level System transfer to the cashbox, from the payer, of exactly
 *   `expected.lamports`, and the cashbox balance grew by at least that much;
 * - it holds exactly one top-level memo, equal to `paymentMemo(expected.jobId)`;
 * - with `notBefore` / `expiresAt`: its block time is inside the window (`pending` while the
 *   block time is unknown, after a `getBlockTime` fallback).
 * Other instructions (compute budget, wallet guards) are tolerated.
 */
export async function verifyPayment(
  connection: Connection,
  signature: string,
  expected: ExpectedPayment,
  options: VerifyPaymentOptions = {},
): Promise<PaymentVerification> {
  const cashbox = resolveCashbox(options.env);
  assertLamports(expected.lamports);
  assertWindow(expected);
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
  if (!status) return { status: 'pending', signature, reason: 'not_found' };
  const reached = COMMITMENT_RANK[status.confirmationStatus ?? 'processed'] ?? 0;
  if (reached < (COMMITMENT_RANK[commitment] ?? 1)) {
    return { status: 'pending', signature, reason: 'below_commitment' };
  }
  if (status.err) {
    return invalid(signature, 'transaction_failed', JSON.stringify(status.err), status.slot);
  }

  let tx = await retryRpc(
    () => connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 }),
    options.retry,
  );
  if (!tx) return { status: 'pending', signature, reason: 'transaction_not_served' };
  const hasWindow = expected.notBefore !== undefined || expected.expiresAt !== undefined;
  if (hasWindow && (tx.blockTime === null || tx.blockTime === undefined)) {
    const slot = tx.slot;
    const blockTime = await retryRpc(() => connection.getBlockTime(slot), options.retry);
    if (blockTime !== null) tx = { ...tx, blockTime };
  }
  return checkPaymentTransaction(tx, signature, {
    cashbox,
    payer: expected.payer,
    lamports: expected.lamports,
    memo,
    confirmationStatus: status.confirmationStatus === 'finalized' ? 'finalized' : commitment,
    ...(expected.notBefore ? { notBefore: expected.notBefore } : {}),
    ...(expected.expiresAt ? { expiresAt: expected.expiresAt } : {}),
  });
}

function invalid(
  signature: string,
  reason: PaymentRejectReason,
  detail: string,
  slot: number | null,
): PaymentVerification {
  return { status: 'invalid', signature, reason, detail, slot };
}

export interface PaymentCheck {
  cashbox: PublicKey;
  payer: PublicKey;
  lamports: bigint;
  memo: string;
  confirmationStatus: Finality;
  /** Optional block time window (inclusive), see `ExpectedPayment`. */
  notBefore?: Date;
  expiresAt?: Date;
}

/** Reads a little-endian u64 from `data` at `offset`. */
function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  return value;
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Pure: checks a fetched transaction against the expected payment (see `verifyPayment`).
 * Exported for tests and for callers that already hold the transaction.
 */
export function checkPaymentTransaction(
  tx: VersionedTransactionResponse,
  signature: string,
  check: PaymentCheck,
): PaymentVerification {
  const slot = tx.slot;
  const meta = tx.meta;
  if (!meta) return invalid(signature, 'missing_meta', 'Transaction has no status meta', slot);
  if (meta.err) return invalid(signature, 'transaction_failed', JSON.stringify(meta.err), slot);

  const message = tx.transaction.message;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? undefined,
  });
  const numSigners = message.header.numRequiredSignatures;
  const payerIndex = message.staticAccountKeys.findIndex((k) => k.equals(check.payer));
  if (payerIndex < 0 || payerIndex >= numSigners) {
    return invalid(
      signature,
      'payer_not_signer',
      `${check.payer.toBase58()} did not sign the transaction`,
      slot,
    );
  }

  const transfers: Array<{ from: PublicKey; lamports: bigint }> = [];
  const memos: string[] = [];
  for (const ix of message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex);
    if (!program) continue;
    if (program.equals(SystemProgram.programId)) {
      const data = ix.data;
      if (data.length !== 12 || readU32(data, 0) !== SYSTEM_TRANSFER_INDEX) continue;
      const from = keys.get(ix.accountKeyIndexes[0] ?? -1);
      const to = keys.get(ix.accountKeyIndexes[1] ?? -1);
      if (!from || !to || !to.equals(check.cashbox)) continue;
      transfers.push({ from, lamports: readU64(data, 4) });
    } else if (program.equals(MEMO_PROGRAM_ID) || program.equals(MEMO_V1_PROGRAM_ID)) {
      memos.push(Buffer.from(ix.data).toString('utf8'));
    }
  }

  if (transfers.length === 0) {
    return invalid(
      signature,
      'recipient_mismatch',
      `No transfer to the cashbox ${check.cashbox.toBase58()}`,
      slot,
    );
  }
  if (transfers.length > 1) {
    return invalid(signature, 'multiple_transfers', 'More than one transfer to the cashbox', slot);
  }
  const transfer = transfers[0]!;
  if (!transfer.from.equals(check.payer)) {
    return invalid(
      signature,
      'payer_mismatch',
      `Transfer comes from ${transfer.from.toBase58()}, not ${check.payer.toBase58()}`,
      slot,
    );
  }
  if (transfer.lamports !== check.lamports) {
    return invalid(
      signature,
      'amount_mismatch',
      `Transfer of ${transfer.lamports} lamports, expected ${check.lamports}`,
      slot,
    );
  }
  let cashboxIndex = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)?.equals(check.cashbox)) {
      cashboxIndex = i;
      break;
    }
  }
  const pre = meta.preBalances[cashboxIndex];
  const post = meta.postBalances[cashboxIndex];
  if (pre === undefined || post === undefined || BigInt(post) - BigInt(pre) < check.lamports) {
    return invalid(
      signature,
      'amount_mismatch',
      'The cashbox balance did not grow by the expected amount',
      slot,
    );
  }

  if (memos.length === 0) {
    return invalid(signature, 'memo_missing', 'No memo instruction', slot);
  }
  if (memos.length > 1 || memos[0] !== check.memo) {
    return invalid(signature, 'memo_mismatch', `Memo does not match ${check.memo}`, slot);
  }

  if (check.notBefore || check.expiresAt) {
    const blockTime = tx.blockTime;
    if (blockTime === null || blockTime === undefined) {
      return { status: 'pending', signature, reason: 'block_time_unknown' };
    }
    const landedAtMs = blockTime * 1000;
    if (check.notBefore && landedAtMs < check.notBefore.getTime()) {
      return invalid(
        signature,
        'payment_too_early',
        `Landed at ${new Date(landedAtMs).toISOString()}, before ${check.notBefore.toISOString()}`,
        slot,
      );
    }
    if (check.expiresAt && landedAtMs > check.expiresAt.getTime()) {
      return invalid(
        signature,
        'payment_expired',
        `Landed at ${new Date(landedAtMs).toISOString()}, after ${check.expiresAt.toISOString()}`,
        slot,
      );
    }
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
