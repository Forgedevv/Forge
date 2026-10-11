// @vitest-environment node
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type SignatureStatus,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPaymentInstructions,
  buildPaymentTx,
  checkPaymentTransaction,
  CLUSTER_GENESIS_HASH,
  ForgeAddressError,
  MAX_PAYMENT_LAMPORTS,
  MEMO_V1_PROGRAM_ID,
  PaymentError,
  paymentMemo,
  verifyPayment,
  type PaymentCheck,
} from './core-adapter';
import { ClusterMismatchError, PaymentConfigError, RpcUnavailableError } from './errors';
import { createCorePaymentGateway, PAYMENT_COMMITMENT, translateCoreError } from './gateway';
import { landedPayment, landedTx, randomSignature, TEST_BLOCKHASH } from './test-helpers';

const PAYER = PublicKey.unique();
const OTHER = PublicKey.unique();
const CASHBOX = PublicKey.unique();
const JOB = '3f2b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b';
const LAMPORTS = 220_000_000n;
const ENV = { FORGE_CASHBOX_WALLET: CASHBOX.toBase58(), SOLANA_CLUSTER: 'devnet' };
const NO_RETRY = { attempts: 1, baseDelayMs: 0 };

const CHECK: PaymentCheck = {
  cashbox: CASHBOX,
  payer: PAYER,
  lamports: LAMPORTS,
  memo: paymentMemo(JOB),
  confirmationStatus: 'confirmed',
};

function check(tx: VersionedTransactionResponse, overrides: Partial<PaymentCheck> = {}) {
  return checkPaymentTransaction(tx, 'sig', { ...CHECK, ...overrides });
}

function paymentTx(overrides: Partial<Parameters<typeof landedTx>[0]> = {}) {
  return landedTx({
    feePayer: PAYER,
    transfers: [{ from: PAYER, to: CASHBOX, lamports: LAMPORTS }],
    memos: [paymentMemo(JOB)],
    memoSigners: [PAYER],
    blockTime: 1_800_000_000,
    ...overrides,
  });
}

interface FakeRpcOptions {
  genesis?: string;
  status?: Partial<SignatureStatus> | null;
  tx?: VersionedTransactionResponse | null;
  balance?: number;
  rent?: number;
  fail?: Error;
}

function fakeConnection(options: FakeRpcOptions = {}) {
  const fail = <T>(value: T) =>
    options.fail ? Promise.reject(options.fail) : Promise.resolve(value);
  const rpc = {
    getGenesisHash: vi.fn(() => fail(options.genesis ?? CLUSTER_GENESIS_HASH.devnet)),
    getSignatureStatuses: vi.fn(() =>
      fail({
        context: { slot: 1 },
        value: [
          options.status === null
            ? null
            : {
                slot: 1_000,
                confirmations: 1,
                err: null,
                confirmationStatus: 'confirmed',
                ...options.status,
              },
        ],
      }),
    ),
    getTransaction: vi.fn(() => fail(options.tx === undefined ? paymentTx() : options.tx)),
    getBalance: vi.fn(() => fail(options.balance ?? 5_000_000)),
    getMinimumBalanceForRentExemption: vi.fn(() => fail(options.rent ?? 890_880)),
    getLatestBlockhash: vi.fn(() =>
      fail({ blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 4242 }),
    ),
  };
  return { rpc, connection: rpc as unknown as Connection };
}

describe('paymentMemo and buildPaymentInstructions', () => {
  it('uses forge:job:<lowercase uuid> and refuses anything else', () => {
    expect(paymentMemo(JOB.toUpperCase())).toBe(`forge:job:${JOB}`);
    expect(() => paymentMemo('not-a-uuid')).toThrow(PaymentError);
  });

  it('builds a transfer to the cashbox and a memo signed by the payer', () => {
    const [transfer, memo] = buildPaymentInstructions({
      payer: PAYER,
      cashbox: CASHBOX,
      lamports: LAMPORTS,
      jobId: JOB,
    });
    expect(transfer!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(transfer!.keys[1]!.pubkey.equals(CASHBOX)).toBe(true);
    expect(memo!.keys).toEqual([{ pubkey: PAYER, isSigner: true, isWritable: false }]);
    expect(memo!.data.toString('utf8')).toBe(`forge:job:${JOB}`);
  });

  it.each([
    ['zero', { lamports: 0n }],
    ['above the max', { lamports: MAX_PAYMENT_LAMPORTS + 1n }],
    ['payer = cashbox', { payer: CASHBOX }],
    ['bad job id', { jobId: 'x' }],
  ])('refuses %s', (_label, overrides) => {
    expect(() =>
      buildPaymentInstructions({
        payer: PAYER,
        cashbox: CASHBOX,
        lamports: LAMPORTS,
        jobId: JOB,
        ...overrides,
      }),
    ).toThrow(PaymentError);
  });
});

describe('checkPaymentTransaction', () => {
  it('confirms the exact payment (v0 and legacy messages, memo v1 accepted)', () => {
    expect(check(paymentTx())).toMatchObject({
      status: 'confirmed',
      lamports: LAMPORTS,
      blockTime: 1_800_000_000,
      slot: 1_000,
      fee: 5_000n,
    });
    expect(check(paymentTx({ legacy: true }))).toMatchObject({ status: 'confirmed' });
    expect(check(paymentTx({ memoProgram: MEMO_V1_PROGRAM_ID }))).toMatchObject({
      status: 'confirmed',
    });
  });

  it('tolerates unrelated instructions (compute budget)', () => {
    const base = paymentTx();
    const message = new TransactionMessage({
      payerKey: PAYER,
      recentBlockhash: TEST_BLOCKHASH,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ...buildPaymentInstructions({
          payer: PAYER,
          cashbox: CASHBOX,
          lamports: LAMPORTS,
          jobId: JOB,
        }),
      ],
    }).compileToV0Message();
    const keys = message.staticAccountKeys;
    const pre = keys.map(() => 10_000_000_000);
    const post = keys.map((k, i) => (k.equals(CASHBOX) ? pre[i]! + Number(LAMPORTS) : pre[i]!));
    const tx = { ...base, transaction: { message, signatures: ['sig'] } };
    tx.meta = { ...base.meta!, preBalances: pre, postBalances: post };
    expect(check(tx)).toMatchObject({ status: 'confirmed' });
  });

  it.each([
    ['transaction_failed', paymentTx({ err: { InstructionError: [0, { Custom: 1 }] } })],
    [
      'payer_not_signer',
      landedPayment({
        payer: OTHER,
        cashbox: CASHBOX,
        lamports: LAMPORTS,
        jobId: JOB,
        blockTime: 1,
      }),
    ],
    [
      'payer_mismatch',
      paymentTx({ transfers: [{ from: OTHER, to: CASHBOX, lamports: LAMPORTS }] }),
    ],
    [
      'recipient_mismatch',
      paymentTx({ transfers: [{ from: PAYER, to: OTHER, lamports: LAMPORTS }] }),
    ],
    [
      'multiple_transfers',
      paymentTx({
        transfers: [
          { from: PAYER, to: CASHBOX, lamports: LAMPORTS / 2n },
          { from: PAYER, to: CASHBOX, lamports: LAMPORTS / 2n },
        ],
      }),
    ],
    [
      'amount_mismatch',
      paymentTx({ transfers: [{ from: PAYER, to: CASHBOX, lamports: LAMPORTS - 1n }] }),
    ],
    [
      'amount_mismatch',
      paymentTx({ transfers: [{ from: PAYER, to: CASHBOX, lamports: LAMPORTS + 1n }] }),
    ],
    ['memo_missing', paymentTx({ memos: [] })],
    ['memo_mismatch', paymentTx({ memos: [paymentMemo('11111111-2222-4333-8444-555555555555')] })],
    ['memo_mismatch', paymentTx({ memos: [JOB] })],
    ['memo_mismatch', paymentTx({ memos: [paymentMemo(JOB), paymentMemo(JOB)] })],
  ])('rejects with %s', (reason, tx) => {
    expect(check(tx)).toMatchObject({ status: 'invalid', reason });
  });

  it('rejects when the cashbox balance did not grow by the amount', () => {
    const tx = paymentTx();
    tx.meta = { ...tx.meta!, postBalances: tx.meta!.preBalances };
    expect(check(tx)).toMatchObject({ status: 'invalid', reason: 'amount_mismatch' });
  });

  it('rejects a transaction without meta', () => {
    expect(check({ ...paymentTx(), meta: null })).toMatchObject({
      status: 'invalid',
      reason: 'missing_meta',
    });
  });
});

describe('buildPaymentTx', () => {
  it('returns an unsigned transaction with the payer as fee payer and a fresh blockhash', async () => {
    const { connection } = fakeConnection();
    const built = await buildPaymentTx(
      connection,
      { payer: PAYER, lamports: LAMPORTS, jobId: JOB },
      { env: ENV, retry: NO_RETRY },
    );
    expect(built).toMatchObject({ lastValidBlockHeight: 4242, lamports: LAMPORTS });
    expect(built.recipient.equals(CASHBOX)).toBe(true);
    expect(built.transaction.feePayer!.equals(PAYER)).toBe(true);
    expect(built.transaction.recentBlockhash).toBe(TEST_BLOCKHASH);
    const wire = built.transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    expect(VersionedTransaction.deserialize(wire).message.compiledInstructions).toHaveLength(2);
  });

  it('refuses when the cashbox would not be rent-exempt (rent read from the cluster)', async () => {
    const { connection } = fakeConnection({ balance: 0, rent: 890_880 });
    await expect(
      buildPaymentTx(connection, { payer: PAYER, lamports: 1_000n, jobId: JOB }, { env: ENV }),
    ).rejects.toMatchObject({ code: 'cashbox_not_rent_exempt' });
  });

  it('refuses without a valid cashbox address', async () => {
    const { connection } = fakeConnection();
    await expect(
      buildPaymentTx(
        connection,
        { payer: PAYER, lamports: LAMPORTS, jobId: JOB },
        { env: { FORGE_CASHBOX_WALLET: 'nope' } },
      ),
    ).rejects.toMatchObject({ name: 'ForgeAddressError' });
  });
});

describe('verifyPayment', () => {
  const expected = { payer: PAYER, lamports: LAMPORTS, jobId: JOB };
  const options = { env: ENV, retry: NO_RETRY };

  it('confirms a confirmed transaction', async () => {
    const { connection, rpc } = fakeConnection();
    await expect(
      verifyPayment(connection, randomSignature(), expected, options),
    ).resolves.toMatchObject({
      status: 'confirmed',
      confirmationStatus: 'confirmed',
    });
    expect(rpc.getTransaction).toHaveBeenCalledWith(expect.any(String), {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  });

  it('throws wrong_cluster when the RPC serves another cluster', async () => {
    const { connection } = fakeConnection({ genesis: CLUSTER_GENESIS_HASH['mainnet-beta'] });
    await expect(
      verifyPayment(connection, randomSignature(), expected, options),
    ).rejects.toMatchObject({ code: 'wrong_cluster' });
  });

  it.each([
    ['unknown signature', { status: null }],
    ['processed only', { status: { confirmationStatus: 'processed' as const } }],
    ['not yet returned by getTransaction', { tx: null }],
  ])('is pending for an %s', async (_label, rpcOptions) => {
    const { connection } = fakeConnection(rpcOptions);
    await expect(
      verifyPayment(connection, randomSignature(), expected, options),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('reports a failed transaction from its status', async () => {
    const { connection } = fakeConnection({
      status: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    await expect(
      verifyPayment(connection, randomSignature(), expected, options),
    ).resolves.toMatchObject({ status: 'invalid', reason: 'transaction_failed' });
  });

  it('rejects a malformed signature without querying it', async () => {
    const { connection, rpc } = fakeConnection();
    await expect(
      verifyPayment(connection, 'not-base58!', expected, options),
    ).resolves.toMatchObject({
      status: 'invalid',
      reason: 'malformed_signature',
    });
    expect(rpc.getSignatureStatuses).not.toHaveBeenCalled();
  });
});

describe('gateway', () => {
  it('serializes an unsigned base64 transaction after checking the cluster', async () => {
    const { connection, rpc } = fakeConnection();
    const gateway = createCorePaymentGateway({
      connection,
      cluster: 'devnet',
      cashbox: CASHBOX,
      retry: NO_RETRY,
    });
    const built = await gateway.buildPayment({ payer: PAYER, lamports: LAMPORTS, jobId: JOB });
    expect(rpc.getGenesisHash).toHaveBeenCalled();
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
    expect(tx.message.staticAccountKeys[0]!.equals(PAYER)).toBe(true);
  });

  it('builds and verifies with the configured cashbox, never another value of process.env', async () => {
    const previous = process.env.FORGE_CASHBOX_WALLET;
    process.env.FORGE_CASHBOX_WALLET = OTHER.toBase58();
    try {
      const { connection, rpc } = fakeConnection({ status: { confirmationStatus: 'finalized' } });
      const gateway = createCorePaymentGateway({
        connection,
        cluster: 'devnet',
        cashbox: CASHBOX,
        retry: NO_RETRY,
      });
      const built = await gateway.buildPayment({ payer: PAYER, lamports: LAMPORTS, jobId: JOB });
      const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
      const [transfer] = tx.message.compiledInstructions;
      const to = tx.message.staticAccountKeys[transfer!.accountKeyIndexes[1]!]!;
      expect(to.equals(CASHBOX)).toBe(true);
      expect(rpc.getBalance).toHaveBeenCalledWith(CASHBOX, 'confirmed');
      // The landed transaction pays CASHBOX: verification must check that same address.
      await expect(
        gateway.verify(randomSignature(), { payer: PAYER, lamports: LAMPORTS, jobId: JOB }),
      ).resolves.toMatchObject({ status: 'confirmed' });
    } finally {
      if (previous === undefined) delete process.env.FORGE_CASHBOX_WALLET;
      else process.env.FORGE_CASHBOX_WALLET = previous;
    }
  });

  it('verifies payments at the finalized commitment only', async () => {
    expect(PAYMENT_COMMITMENT).toBe('finalized');
    const notFinal = fakeConnection({ status: { confirmationStatus: 'confirmed' } });
    const gateway = createCorePaymentGateway({
      connection: notFinal.connection,
      cluster: 'devnet',
      cashbox: CASHBOX,
      retry: NO_RETRY,
    });
    const expected = { payer: PAYER, lamports: LAMPORTS, jobId: JOB };
    await expect(gateway.verify(randomSignature(), expected)).resolves.toMatchObject({
      status: 'pending',
      reason: 'below_commitment',
    });
    expect(notFinal.rpc.getTransaction).not.toHaveBeenCalled();

    const final = fakeConnection({ status: { confirmationStatus: 'finalized' } });
    const finalGateway = createCorePaymentGateway({
      connection: final.connection,
      cluster: 'devnet',
      cashbox: CASHBOX,
      retry: NO_RETRY,
    });
    await expect(finalGateway.verify(randomSignature(), expected)).resolves.toMatchObject({
      status: 'confirmed',
      confirmationStatus: 'finalized',
    });
    expect(final.rpc.getTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ commitment: 'finalized' }),
    );
  });

  it('never builds a transaction for another cluster', async () => {
    const { connection, rpc } = fakeConnection({ genesis: CLUSTER_GENESIS_HASH['mainnet-beta'] });
    const gateway = createCorePaymentGateway({
      connection,
      cluster: 'devnet',
      cashbox: CASHBOX,
      retry: NO_RETRY,
    });
    await expect(
      gateway.buildPayment({ payer: PAYER, lamports: LAMPORTS, jobId: JOB }),
    ).rejects.toBeInstanceOf(ClusterMismatchError);
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('drops RPC error messages (they may carry the endpoint and its API key)', async () => {
    const { connection } = fakeConnection({
      fail: new Error('request to https://devnet.example/?api-key=SECRET failed'),
    });
    const gateway = createCorePaymentGateway({
      connection,
      cluster: 'devnet',
      cashbox: CASHBOX,
      retry: NO_RETRY,
    });
    const error = await gateway
      .verify(randomSignature(), {
        payer: PAYER,
        lamports: LAMPORTS,
        jobId: JOB,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect(String((error as Error).message)).not.toContain('SECRET');
  });

  it('maps core configuration errors', () => {
    expect(translateCoreError(new PaymentError('wrong_cluster', 'x'))).toBeInstanceOf(
      ClusterMismatchError,
    );
    expect(translateCoreError(new PaymentError('cashbox_not_rent_exempt', 'x'))).toBeInstanceOf(
      PaymentConfigError,
    );
    const addressError = new ForgeAddressError(['FORGE_CASHBOX_WALLET'], []);
    expect(translateCoreError(addressError)).toBeInstanceOf(PaymentConfigError);
    expect(translateCoreError(new PaymentError('invalid_amount', 'x'))).toBeInstanceOf(
      PaymentError,
    );
  });
});
