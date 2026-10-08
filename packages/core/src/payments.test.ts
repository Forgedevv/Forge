import {
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedMessage,
  type Connection,
  type SignatureStatus,
  type TransactionError,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAddressError } from './addresses.js';
import {
  CLUSTER_GENESIS_HASH,
  MAX_PAYMENT_LAMPORTS,
  MEMO_PROGRAM_ID,
  MEMO_V1_PROGRAM_ID,
  PaymentError,
  buildPaymentInstructions,
  buildPaymentTx,
  checkPaymentTransaction,
  paymentMemo,
  verifyPayment,
  type PaymentVerification,
} from './payments.js';

const JOB_ID = '7f1c2a9e-4b3d-4c8a-9e21-5d6f7a8b9c0d';
const OTHER_JOB_ID = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const LAMPORTS = 300_000_000n;
const SIGNATURE = '5'.repeat(88);
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const payer = Keypair.generate();
const cashbox = Keypair.generate().publicKey;
const env = { FORGE_CASHBOX_WALLET: cashbox.toBase58(), SOLANA_CLUSTER: 'devnet' };
const noRetry = { attempts: 1, baseDelayMs: 0 };

function memoIx(text: string, signer: PublicKey, programId = MEMO_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

function transferIx(from: PublicKey, to: PublicKey, lamports: bigint) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

/** The instructions `buildPaymentTx` produces for the default payment. */
function goodInstructions(): TransactionInstruction[] {
  return buildPaymentInstructions({
    payer: payer.publicKey,
    lamports: LAMPORTS,
    jobId: JOB_ID,
    cashbox,
  });
}

interface TxOptions {
  signers?: Keypair[];
  err?: TransactionError | null;
  /** Override the cashbox balance change (defaults to the sum of transfers to the cashbox). */
  cashboxDelta?: bigint;
  v0?: boolean;
}

/** Builds a getTransaction-like response for a transaction holding `instructions`. */
function txResponse(
  instructions: TransactionInstruction[],
  options: TxOptions = {},
): VersionedTransactionResponse {
  const signers = options.signers ?? [payer];
  let message: VersionedMessage;
  if (options.v0) {
    message = MessageV0.compile({
      payerKey: signers[0]!.publicKey,
      instructions,
      recentBlockhash: BLOCKHASH,
    });
  } else {
    const tx = new Transaction({
      feePayer: signers[0]!.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 100,
    }).add(...instructions);
    tx.sign(...signers);
    message = VersionedMessage.deserialize(tx.serializeMessage());
  }
  const keys = message.staticAccountKeys;
  const preBalances = keys.map(() => 1_000_000_000);
  const postBalances = [...preBalances];
  let toCashbox = 0n;
  for (const ix of instructions) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    if (ix.keys[1]?.pubkey.equals(cashbox)) toCashbox += Buffer.from(ix.data).readBigUInt64LE(4);
  }
  const cashboxIndex = keys.findIndex((k) => k.equals(cashbox));
  if (cashboxIndex >= 0) {
    postBalances[cashboxIndex] =
      preBalances[cashboxIndex]! + Number(options.cashboxDelta ?? toCashbox);
  }
  return {
    slot: 4242,
    blockTime: 1_760_000_000,
    version: options.v0 ? 0 : 'legacy',
    transaction: { message, signatures: [SIGNATURE] },
    meta: {
      err: options.err ?? null,
      fee: 5000,
      preBalances,
      postBalances,
      innerInstructions: [],
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as VersionedTransactionResponse;
}

const check = (overrides: Partial<Parameters<typeof checkPaymentTransaction>[2]> = {}) => ({
  cashbox,
  payer: payer.publicKey,
  lamports: LAMPORTS,
  memo: paymentMemo(JOB_ID),
  confirmationStatus: 'confirmed' as const,
  ...overrides,
});

function expectInvalid(result: PaymentVerification, reason: string): void {
  expect(result.status).toBe('invalid');
  if (result.status === 'invalid') expect(result.reason).toBe(reason);
}

describe('paymentMemo', () => {
  it('is forge:job:<uuid>, lowercase', () => {
    expect(paymentMemo(JOB_ID)).toBe(`forge:job:${JOB_ID}`);
    expect(paymentMemo(JOB_ID.toUpperCase())).toBe(`forge:job:${JOB_ID}`);
  });

  it('rejects a non-UUID job id', () => {
    expect(() => paymentMemo('job-1')).toThrow(PaymentError);
    expect(() => paymentMemo('')).toThrow(PaymentError);
  });
});

describe('buildPaymentInstructions', () => {
  it('is a transfer to the cashbox then a memo signed by the payer', () => {
    const [transfer, memo] = goodInstructions();
    expect(transfer!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(transfer!.keys[0]!.pubkey.equals(payer.publicKey)).toBe(true);
    expect(transfer!.keys[1]!.pubkey.equals(cashbox)).toBe(true);
    expect(Buffer.from(transfer!.data).readBigUInt64LE(4)).toBe(LAMPORTS);
    expect(memo!.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memo!.keys).toEqual([{ pubkey: payer.publicKey, isSigner: true, isWritable: false }]);
    expect(Buffer.from(memo!.data).toString('utf8')).toBe(`forge:job:${JOB_ID}`);
  });

  it.each([0n, -1n, MAX_PAYMENT_LAMPORTS + 1n])('rejects amount %s', (lamports) => {
    expect(() =>
      buildPaymentInstructions({ payer: payer.publicKey, lamports, jobId: JOB_ID, cashbox }),
    ).toThrow(expect.objectContaining({ code: 'invalid_amount' }));
  });

  it('rejects the cashbox paying itself', () => {
    expect(() =>
      buildPaymentInstructions({ payer: cashbox, lamports: LAMPORTS, jobId: JOB_ID, cashbox }),
    ).toThrow(expect.objectContaining({ code: 'payer_is_cashbox' }));
  });
});

function buildConnection(cashboxBalance: number) {
  const connection = {
    getMinimumBalanceForRentExemption: vi.fn(async () => 890_880),
    getBalance: vi.fn(async () => cashboxBalance),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 900 })),
  };
  return connection as unknown as Connection;
}

describe('buildPaymentTx', () => {
  it('returns an unsigned transaction to the cashbox carrying the job memo', async () => {
    const result = await buildPaymentTx(
      buildConnection(5_000_000),
      { payer: payer.publicKey, lamports: LAMPORTS, jobId: JOB_ID },
      { env, retry: noRetry },
    );
    expect(result.recipient.equals(cashbox)).toBe(true);
    expect(result.memo).toBe(`forge:job:${JOB_ID}`);
    expect(result.lamports).toBe(LAMPORTS);
    expect(result.lastValidBlockHeight).toBe(900);
    const tx = result.transaction;
    expect(tx.feePayer?.equals(payer.publicKey)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    // Round trip: once signed by the payer and landed, it verifies.
    tx.sign(payer);
    const response = txResponse(tx.instructions);
    expect(checkPaymentTransaction(response, SIGNATURE, check()).status).toBe('confirmed');
  });

  it('refuses when the cashbox would not be rent-exempt after the payment', async () => {
    const err = await buildPaymentTx(
      buildConnection(0),
      { payer: payer.publicKey, lamports: 1_000n, jobId: JOB_ID },
      { env, retry: noRetry },
    ).catch((e) => e);
    expect((err as PaymentError).code).toBe('cashbox_not_rent_exempt');
  });

  it('accepts a payment that itself makes a fresh cashbox rent-exempt', async () => {
    const result = await buildPaymentTx(
      buildConnection(0),
      { payer: payer.publicKey, lamports: LAMPORTS, jobId: JOB_ID },
      { env, retry: noRetry },
    );
    expect(result.transaction.instructions).toHaveLength(2);
  });

  it('requires FORGE_CASHBOX_WALLET', async () => {
    await expect(
      buildPaymentTx(
        buildConnection(5_000_000),
        { payer: payer.publicKey, lamports: LAMPORTS, jobId: JOB_ID },
        { env: {}, retry: noRetry },
      ),
    ).rejects.toThrow(ForgeAddressError);
  });
});

describe('checkPaymentTransaction', () => {
  it('accepts the exact payment and reports slot, time and fee', () => {
    const result = checkPaymentTransaction(txResponse(goodInstructions()), SIGNATURE, check());
    expect(result).toEqual({
      status: 'confirmed',
      signature: SIGNATURE,
      slot: 4242,
      blockTime: 1_760_000_000,
      confirmationStatus: 'confirmed',
      payer: payer.publicKey,
      recipient: cashbox,
      lamports: LAMPORTS,
      memo: `forge:job:${JOB_ID}`,
      fee: 5000n,
    });
  });

  it('tolerates compute budget instructions added by the wallet', () => {
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      ...goodInstructions(),
    ];
    expect(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()).status).toBe('confirmed');
  });

  it('accepts a v0 transaction', () => {
    const result = checkPaymentTransaction(
      txResponse(goodInstructions(), { v0: true }),
      SIGNATURE,
      check(),
    );
    expect(result.status).toBe('confirmed');
  });

  it('accepts a legacy memo v1 instruction', () => {
    const ixs = [
      transferIx(payer.publicKey, cashbox, LAMPORTS),
      memoIx(paymentMemo(JOB_ID), payer.publicKey, MEMO_V1_PROGRAM_ID),
    ];
    expect(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()).status).toBe('confirmed');
  });

  it('rejects a failed transaction', () => {
    const response = txResponse(goodInstructions(), {
      err: { InstructionError: [0, 'Custom'] } as never,
    });
    expectInvalid(checkPaymentTransaction(response, SIGNATURE, check()), 'transaction_failed');
  });

  it('rejects a transaction without meta', () => {
    const response = { ...txResponse(goodInstructions()), meta: null };
    expectInvalid(checkPaymentTransaction(response, SIGNATURE, check()), 'missing_meta');
  });

  it('rejects a payment to another recipient', () => {
    const elsewhere = Keypair.generate().publicKey;
    const ixs = [
      transferIx(payer.publicKey, elsewhere, LAMPORTS),
      memoIx(paymentMemo(JOB_ID), payer.publicKey),
    ];
    expectInvalid(
      checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()),
      'recipient_mismatch',
    );
  });

  it.each([LAMPORTS - 1n, LAMPORTS + 1n, 1n])('rejects a transfer of %s lamports', (lamports) => {
    const ixs = [
      transferIx(payer.publicKey, cashbox, lamports),
      memoIx(paymentMemo(JOB_ID), payer.publicKey),
    ];
    expectInvalid(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()), 'amount_mismatch');
  });

  it('rejects when the cashbox balance did not grow by the amount', () => {
    const response = txResponse(goodInstructions(), { cashboxDelta: LAMPORTS - 1n });
    expectInvalid(checkPaymentTransaction(response, SIGNATURE, check()), 'amount_mismatch');
  });

  it('rejects two transfers to the cashbox', () => {
    const ixs = [
      transferIx(payer.publicKey, cashbox, LAMPORTS / 2n),
      transferIx(payer.publicKey, cashbox, LAMPORTS / 2n),
      memoIx(paymentMemo(JOB_ID), payer.publicKey),
    ];
    expectInvalid(
      checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()),
      'multiple_transfers',
    );
  });

  it('rejects a payment from another payer (expected payer did not sign)', () => {
    const other = Keypair.generate();
    const ixs = buildPaymentInstructions({
      payer: other.publicKey,
      lamports: LAMPORTS,
      jobId: JOB_ID,
      cashbox,
    });
    const response = txResponse(ixs, { signers: [other] });
    expectInvalid(checkPaymentTransaction(response, SIGNATURE, check()), 'payer_not_signer');
  });

  it('rejects a transfer funded by another signer, even if the payer co-signed', () => {
    const other = Keypair.generate();
    const ixs = [
      transferIx(other.publicKey, cashbox, LAMPORTS),
      memoIx(paymentMemo(JOB_ID), payer.publicKey),
    ];
    const response = txResponse(ixs, { signers: [other, payer] });
    expectInvalid(checkPaymentTransaction(response, SIGNATURE, check()), 'payer_mismatch');
  });

  it('rejects a missing memo', () => {
    const ixs = [transferIx(payer.publicKey, cashbox, LAMPORTS)];
    expectInvalid(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()), 'memo_missing');
  });

  it('rejects the memo of another job', () => {
    const ixs = [
      transferIx(payer.publicKey, cashbox, LAMPORTS),
      memoIx(paymentMemo(OTHER_JOB_ID), payer.publicKey),
    ];
    expectInvalid(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()), 'memo_mismatch');
  });

  it('rejects a memo with extra text', () => {
    const ixs = [
      transferIx(payer.publicKey, cashbox, LAMPORTS),
      memoIx(`${paymentMemo(JOB_ID)} `, payer.publicKey),
    ];
    expectInvalid(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()), 'memo_mismatch');
  });

  it('rejects two memos, even if one matches', () => {
    const ixs = [...goodInstructions(), memoIx(paymentMemo(OTHER_JOB_ID), payer.publicKey)];
    expectInvalid(checkPaymentTransaction(txResponse(ixs), SIGNATURE, check()), 'memo_mismatch');
  });
});

function verifyConnection(opts: {
  status?: Partial<SignatureStatus> | null;
  tx?: VersionedTransactionResponse | null;
  genesis?: string;
  getTransaction?: () => Promise<VersionedTransactionResponse | null>;
}) {
  const status =
    opts.status === undefined
      ? { slot: 4242, confirmations: null, err: null, confirmationStatus: 'confirmed' as const }
      : opts.status;
  const connection = {
    getGenesisHash: vi.fn(async () => opts.genesis ?? CLUSTER_GENESIS_HASH.devnet),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 5000 }, value: [status] })),
    getTransaction: vi.fn(
      opts.getTransaction ??
        (async () => (opts.tx === undefined ? txResponse(goodInstructions()) : opts.tx)),
    ),
  };
  return { connection: connection as unknown as Connection, mocks: connection };
}

const expected = { payer: payer.publicKey, lamports: LAMPORTS, jobId: JOB_ID };

describe('verifyPayment', () => {
  it('confirms a valid payment with its slot', async () => {
    const { connection, mocks } = verifyConnection({});
    const result = await verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry });
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') expect(result.slot).toBe(4242);
    expect(mocks.getSignatureStatuses).toHaveBeenCalledWith([SIGNATURE], {
      searchTransactionHistory: true,
    });
    expect(mocks.getTransaction).toHaveBeenCalledWith(SIGNATURE, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  });

  it('is pending (no throw) when the signature is not known yet', async () => {
    const { connection } = verifyConnection({ status: null });
    expect(await verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry })).toEqual({
      status: 'pending',
      signature: SIGNATURE,
    });
  });

  it('is pending while only processed', async () => {
    const { connection } = verifyConnection({
      status: { slot: 1, confirmations: 0, err: null, confirmationStatus: 'processed' },
    });
    const result = await verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry });
    expect(result.status).toBe('pending');
  });

  it('is pending until finalized when finalized is required', async () => {
    const { connection } = verifyConnection({});
    const result = await verifyPayment(connection, SIGNATURE, expected, {
      env,
      commitment: 'finalized',
      retry: noRetry,
    });
    expect(result.status).toBe('pending');
  });

  it('is pending when the transaction body is not served yet', async () => {
    const { connection } = verifyConnection({ tx: null });
    const result = await verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry });
    expect(result.status).toBe('pending');
  });

  it('reports a failed transaction', async () => {
    const { connection, mocks } = verifyConnection({
      status: {
        slot: 7,
        confirmations: null,
        err: { InstructionError: [0, 'Custom'] } as never,
        confirmationStatus: 'confirmed',
      },
    });
    const result = await verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry });
    expectInvalid(result, 'transaction_failed');
    if (result.status === 'invalid') expect(result.slot).toBe(7);
    expect(mocks.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects a payment for another job', async () => {
    const { connection } = verifyConnection({});
    const result = await verifyPayment(
      connection,
      SIGNATURE,
      { ...expected, jobId: OTHER_JOB_ID },
      { env, retry: noRetry },
    );
    expectInvalid(result, 'memo_mismatch');
  });

  it('rejects a payment checked against another payer', async () => {
    const { connection } = verifyConnection({});
    const result = await verifyPayment(
      connection,
      SIGNATURE,
      { ...expected, payer: Keypair.generate().publicKey },
      { env, retry: noRetry },
    );
    expectInvalid(result, 'payer_not_signer');
  });

  it('rejects a malformed signature without calling the RPC for it', async () => {
    const { connection, mocks } = verifyConnection({});
    const result = await verifyPayment(connection, 'not-a-signature', expected, {
      env,
      retry: noRetry,
    });
    expectInvalid(result, 'malformed_signature');
    expect(mocks.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('throws on the wrong cluster', async () => {
    const { connection } = verifyConnection({ genesis: CLUSTER_GENESIS_HASH['mainnet-beta'] });
    await expect(
      verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry }),
    ).rejects.toThrow(expect.objectContaining({ code: 'wrong_cluster' }));
  });

  it('checks mainnet when SOLANA_CLUSTER says so', async () => {
    const { connection } = verifyConnection({});
    await expect(
      verifyPayment(connection, SIGNATURE, expected, {
        env: { ...env, SOLANA_CLUSTER: 'mainnet-beta' },
        retry: noRetry,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'wrong_cluster' }));
  });

  it('retries a transient RPC error', async () => {
    const getTransaction = vi
      .fn<() => Promise<VersionedTransactionResponse | null>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(txResponse(goodInstructions()));
    const { connection } = verifyConnection({ getTransaction });
    const result = await verifyPayment(connection, SIGNATURE, expected, {
      env,
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    expect(result.status).toBe('confirmed');
  });

  it('propagates a non-transient RPC error', async () => {
    const { connection } = verifyConnection({
      getTransaction: async () => {
        throw new Error('Invalid param: WrongSize');
      },
    });
    await expect(
      verifyPayment(connection, SIGNATURE, expected, { env, retry: noRetry }),
    ).rejects.toThrow('WrongSize');
  });
});
