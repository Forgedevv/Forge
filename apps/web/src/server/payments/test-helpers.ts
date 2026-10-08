import { randomBytes } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  type TransactionError,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { base58Encode } from '../auth/base58';
import {
  buildPaymentInstructions,
  checkPaymentTransaction,
  MEMO_PROGRAM_ID,
  paymentMemo,
  type ExpectedPayment,
  type PaymentParams,
  type PaymentVerification,
} from './core-adapter';
import type { BuiltPayment, PaymentGateway } from './gateway';

/*
 * Test doubles shared by the payment tests (no network). Not imported by production code.
 */

/** Any 32-byte base58 value works as a blockhash for offline compilation. */
export const TEST_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

export function randomSignature(): string {
  return base58Encode(randomBytes(64));
}

export interface Transfer {
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
}

export interface LandedOptions {
  feePayer: PublicKey;
  transfers: Transfer[];
  memos?: string[];
  /** Signers of the memos (adds them as required signers). */
  memoSigners?: PublicKey[];
  /** Unix seconds. */
  blockTime: number | null;
  err?: TransactionError;
  memoProgram?: PublicKey;
  legacy?: boolean;
  signature?: string;
  slot?: number;
}

/** A landed transaction as `getTransaction` returns it, with consistent balances. */
export function landedTx(options: LandedOptions): VersionedTransactionResponse {
  const instructions: TransactionInstruction[] = options.transfers.map((t) =>
    SystemProgram.transfer({ fromPubkey: t.from, toPubkey: t.to, lamports: t.lamports }),
  );
  for (const memo of options.memos ?? []) {
    instructions.push(
      new TransactionInstruction({
        programId: options.memoProgram ?? MEMO_PROGRAM_ID,
        keys: (options.memoSigners ?? []).map((pubkey) => ({
          pubkey,
          isSigner: true,
          isWritable: false,
        })),
        data: Buffer.from(memo, 'utf8'),
      }),
    );
  }
  const draft = new TransactionMessage({
    payerKey: options.feePayer,
    recentBlockhash: TEST_BLOCKHASH,
    instructions,
  });
  const message = options.legacy ? draft.compileToLegacyMessage() : draft.compileToV0Message();
  const keys = message.staticAccountKeys;
  const preBalances = keys.map(() => 10_000_000_000);
  const failed = options.err !== undefined && options.err !== null;
  const postBalances = keys.map((key, i) => {
    let value = BigInt(preBalances[i]!);
    if (!failed) {
      for (const t of options.transfers) {
        if (key.equals(t.to)) value += t.lamports;
        if (key.equals(t.from)) value -= t.lamports;
      }
    }
    if (i === 0) value -= 5_000n;
    return Number(value);
  });
  return {
    slot: options.slot ?? 1_000,
    blockTime: options.blockTime,
    transaction: { message, signatures: [options.signature ?? randomSignature()] },
    meta: {
      err: failed ? (options.err as TransactionError) : null,
      fee: 5_000,
      preBalances,
      postBalances,
      loadedAddresses: { writable: [], readonly: [] },
    },
    version: options.legacy ? 'legacy' : 0,
  };
}

/** The transaction a client lands for a quote (exact transfer to the cashbox + job memo). */
export function landedPayment(options: {
  payer: PublicKey;
  cashbox: PublicKey;
  lamports: bigint;
  jobId: string;
  blockTime: number | null;
  memo?: string;
}): VersionedTransactionResponse {
  return landedTx({
    feePayer: options.payer,
    transfers: [{ from: options.payer, to: options.cashbox, lamports: options.lamports }],
    memos: [options.memo ?? paymentMemo(options.jobId)],
    memoSigners: [options.payer],
    blockTime: options.blockTime,
  });
}

/**
 * PaymentGateway over an in-memory "chain": `land(signature, tx)` makes a transaction visible;
 * verification runs the adapter's real `checkPaymentTransaction` on it. Unknown signatures are
 * pending.
 */
export class FakeChainGateway implements PaymentGateway {
  readonly txs = new Map<string, VersionedTransactionResponse>();
  readonly built: { payer: string; lamports: bigint; jobId: string }[] = [];
  readonly verifyCalls: string[] = [];
  /** Thrown by every call when set (e.g. RpcUnavailableError, ClusterMismatchError). */
  failure: Error | null = null;
  /** Runs before each verification (tests land transactions during the wait loop). */
  onVerify: ((signature: string, call: number) => void) | null = null;

  constructor(readonly cashbox: PublicKey) {}

  land(signature: string, tx: VersionedTransactionResponse): void {
    this.txs.set(signature, tx);
  }

  async buildPayment(params: PaymentParams): Promise<BuiltPayment> {
    await Promise.resolve();
    if (this.failure) throw this.failure;
    this.built.push({
      payer: params.payer.toBase58(),
      lamports: params.lamports,
      jobId: params.jobId,
    });
    const tx = new Transaction({
      feePayer: params.payer,
      blockhash: TEST_BLOCKHASH,
      lastValidBlockHeight: 100,
    }).add(...buildPaymentInstructions({ ...params, cashbox: this.cashbox }));
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { transaction: Buffer.from(wire).toString('base64'), lastValidBlockHeight: 100 };
  }

  async verify(signature: string, expected: ExpectedPayment): Promise<PaymentVerification> {
    this.verifyCalls.push(signature);
    this.onVerify?.(signature, this.verifyCalls.length);
    await Promise.resolve();
    if (this.failure) throw this.failure;
    const tx = this.txs.get(signature);
    if (!tx) return { status: 'pending', signature };
    return checkPaymentTransaction(tx, signature, {
      cashbox: this.cashbox,
      payer: expected.payer,
      lamports: expected.lamports,
      memo: paymentMemo(expected.jobId),
      confirmationStatus: 'confirmed',
    });
  }
}

/** Controllable clock; `sleep` advances it instead of waiting. */
export class TestClock {
  constructor(public ms: number) {}

  now = (): number => this.ms;

  sleep = async (ms: number): Promise<void> => {
    this.ms += ms;
    await Promise.resolve();
  };

  advance(ms: number): void {
    this.ms += ms;
  }

  /** Unix seconds, offset by `deltaMs` from now. */
  seconds(deltaMs = 0): number {
    return Math.floor((this.ms + deltaMs) / 1000);
  }
}
