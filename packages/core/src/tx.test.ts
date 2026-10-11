import {
  ComputeBudgetProgram,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type Connection,
  type SignatureStatus,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ConfirmationTimeoutError,
  DurableNonceError,
  MAX_TRANSACTION_BYTES,
  MAX_NONCE_SEED_BYTES,
  RentExemptionError,
  TransactionEncodingError,
  TransactionExpiredError,
  TransactionFailedError,
  assertNonceSeed,
  assertRentExempt,
  assertSignedCopyOf,
  buildCreateNonceAccountTx,
  buildCreateNonceAccountWithSeedTx,
  computeBudgetInstructions,
  confirmSignature,
  deriveSeededNonceAccount,
  deserializeTransactionBase64,
  encodeBase58,
  missingSigners,
  priorityFeeLamports,
  readNonce,
  requiredSigners,
  serializeTransactionBase64,
  transactionSignature,
  transactionSize,
} from './tx.js';

const BLOCKHASH = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const SIGNATURE = '5'.repeat(88);
const rent = (size: number) => (128 + size) * 6960;

// ---------------------------------------------------------------------------------------------
// confirmSignature
// ---------------------------------------------------------------------------------------------

type StatusStep = SignatureStatus | null | Error;

/** Fake clock + scripted `getSignatureStatuses` answers (the last one repeats). */
function statusConnection(steps: StatusStep[], blockHeights: number[] = []) {
  let time = 0;
  const calls: { history: boolean }[] = [];
  const sleeps: number[] = [];
  const connection = {
    getSignatureStatuses: async (
      _signatures: string[],
      config?: { searchTransactionHistory?: boolean },
    ) => {
      calls.push({ history: config?.searchTransactionHistory ?? false });
      const step = steps.length > 1 ? steps.shift()! : steps[0]!;
      if (step instanceof Error) throw step;
      return { context: { slot: 1 }, value: [step] };
    },
    getBlockHeight: async () =>
      blockHeights.length > 1 ? blockHeights.shift()! : blockHeights[0]!,
  };
  return {
    connection,
    calls,
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

const status = (
  confirmationStatus: SignatureStatus['confirmationStatus'],
  err = null,
): SignatureStatus => ({
  slot: 42,
  confirmations: null,
  err,
  confirmationStatus,
});

describe('confirmSignature', () => {
  it('returns once the signature is confirmed', async () => {
    const s = statusConnection([null, status('processed'), status('confirmed')]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      now: s.now,
      sleep: s.sleep,
    });
    expect(result).toEqual({ signature: SIGNATURE, slot: 42, confirmationStatus: 'confirmed' });
    expect(s.sleeps).toEqual([1500, 1500]);
  });

  it('waits for finalized when asked', async () => {
    const s = statusConnection([status('confirmed'), status('finalized')]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      commitment: 'finalized',
      now: s.now,
      sleep: s.sleep,
    });
    expect(result.confirmationStatus).toBe('finalized');
  });

  it('throws TransactionFailedError on an on-chain error, without retrying', async () => {
    const err = { InstructionError: [3, { Custom: 6057 }] };
    const s = statusConnection([status('confirmed', err as never)]);
    const error = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      now: s.now,
      sleep: s.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).transactionError).toEqual(err);
    expect(s.calls).toHaveLength(1);
  });

  it('keeps polling a failure seen only at processed (the block can be dropped)', async () => {
    const err = { InstructionError: [2, { Custom: 1 }] };
    const s = statusConnection([status('processed', err as never), null, status('confirmed')]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      now: s.now,
      sleep: s.sleep,
    });
    expect(result.confirmationStatus).toBe('confirmed');
    expect(s.calls).toHaveLength(3);
  });

  it('throws on a failure only once it reaches the requested commitment', async () => {
    const err = { InstructionError: [0, 'InvalidAccountData'] };
    const s = statusConnection([
      status('confirmed', err as never),
      status('confirmed', err as never),
      status('finalized', err as never),
    ]);
    const error = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      commitment: 'finalized',
      now: s.now,
      sleep: s.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(s.calls).toHaveLength(3);
  });

  it('times out on a failure that never reaches the commitment, and reports it', async () => {
    const err = { InstructionError: [1, { Custom: 6000 }] };
    const s = statusConnection([status('processed', err as never)]);
    const error = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 4000,
      now: s.now,
      sleep: s.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfirmationTimeoutError);
    expect((error as ConfirmationTimeoutError).lastSeenStatus).toEqual({
      confirmationStatus: 'processed',
      err,
      slot: 42,
    });
    expect((error as Error).message).toContain('failed at that level');
  });

  it('does not report as expired a transaction the cluster has seen', async () => {
    // Not visible yet when the height passes, but the history lookup finds it processed: it is
    // confirmed on the next poll instead of being reported as expired.
    const s = statusConnection([null, null, status('processed'), status('confirmed')], [100, 151]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      lastValidBlockHeight: 150,
      now: s.now,
      sleep: s.sleep,
    });
    expect(result.confirmationStatus).toBe('confirmed');
  });

  it('retries network errors with backoff and confirms', async () => {
    const s = statusConnection([new Error('fetch failed'), new Error('429'), status('confirmed')]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      now: s.now,
      sleep: s.sleep,
    });
    expect(result.confirmationStatus).toBe('confirmed');
    expect(s.sleeps).toEqual([3000, 6000]);
  });

  it('times out at the deadline after a last history lookup, with the last RPC error', async () => {
    const s = statusConnection([null, new Error('ECONNRESET'), null]);
    const error = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 5000,
      now: s.now,
      sleep: s.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfirmationTimeoutError);
    expect((error as ConfirmationTimeoutError).lastNetworkError).toBe('ECONNRESET');
    expect(s.calls.at(-1)).toEqual({ history: true });
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('finds a transaction that landed just before the deadline in the history', async () => {
    const s = statusConnection([null, null, null, status('confirmed')]);
    const result = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 3000,
      now: s.now,
      sleep: s.sleep,
    });
    expect(result.confirmationStatus).toBe('confirmed');
  });

  it('reports an expired blockhash once the block height passes', async () => {
    const s = statusConnection([null], [100, 151]);
    const error = await confirmSignature(s.connection, SIGNATURE, {
      deadlineMs: 60_000,
      lastValidBlockHeight: 150,
      now: s.now,
      sleep: s.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionExpiredError);
    expect(s.calls.at(-1)).toEqual({ history: true });
  });

  it('rejects a non-positive deadline', async () => {
    const s = statusConnection([null]);
    await expect(confirmSignature(s.connection, SIGNATURE, { deadlineMs: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

function sampleTx(payer: PublicKey, other: PublicKey): Transaction {
  return new Transaction({ feePayer: payer, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 1000 }),
    SystemProgram.transfer({ fromPubkey: other, toPubkey: payer, lamports: 1 }),
  );
}

describe('base64 serialization', () => {
  it('round-trips a partially signed transaction and keeps the signature valid', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = sampleTx(payer.publicKey, other.publicKey);
    tx.partialSign(other);
    const base64 = serializeTransactionBase64(tx);
    expect(missingSigners(tx).map(String)).toEqual([payer.publicKey.toBase58()]);

    const decoded = deserializeTransactionBase64(base64);
    expect(decoded.serializeMessage().equals(tx.serializeMessage())).toBe(true);
    decoded.partialSign(payer);
    expect(decoded.verifySignatures(true)).toBe(true);
    expect(missingSigners(decoded)).toEqual([]);
    expect(() => serializeTransactionBase64(decoded, { requireAllSignatures: true })).not.toThrow();
  });

  it('refuses to serialize with a missing signature when all are required', () => {
    const tx = sampleTx(Keypair.generate().publicKey, Keypair.generate().publicKey);
    expect(() => serializeTransactionBase64(tx, { requireAllSignatures: true })).toThrow(
      TransactionEncodingError,
    );
  });

  it('lists required signers with the fee payer first', () => {
    const payer = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    expect(requiredSigners(sampleTx(payer, other)).map(String)).toEqual([
      payer.toBase58(),
      other.toBase58(),
    ]);
  });

  it.each(['', 'not base64!', 'QUJD=', 'QQ'])('refuses bad base64 %j', (value) => {
    const error = (() => {
      try {
        deserializeTransactionBase64(value);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TransactionEncodingError);
    expect((error as TransactionEncodingError).code).toBe('INVALID_BASE64');
  });

  it('refuses an oversized payload', () => {
    const base64 = Buffer.alloc(MAX_TRANSACTION_BYTES + 1, 1).toString('base64');
    expect(() => deserializeTransactionBase64(base64)).toThrow(/limit 1232/);
  });

  it('refuses bytes that are not a transaction', () => {
    const base64 = Buffer.from([1, 2, 3]).toString('base64');
    let error: unknown;
    try {
      deserializeTransactionBase64(base64);
    } catch (e) {
      error = e;
    }
    expect((error as TransactionEncodingError).code).toBe('INVALID_TRANSACTION');
  });

  it('refuses a tampered message (signature no longer verifies)', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = sampleTx(payer.publicKey, other.publicKey);
    tx.partialSign(other);
    const bytes = Buffer.from(serializeTransactionBase64(tx), 'base64');
    const last = bytes.length - 1; // last byte of the second transfer amount
    bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
    let error: unknown;
    try {
      deserializeTransactionBase64(bytes.toString('base64'));
    } catch (e) {
      error = e;
    }
    expect((error as TransactionEncodingError).code).toBe('INVALID_SIGNATURE');
  });

  it('encodes base58 like web3.js, leading zeros included', () => {
    for (const bytes of [
      Buffer.alloc(32, 0),
      Buffer.alloc(32, 255),
      Keypair.generate().publicKey.toBuffer(),
    ]) {
      expect(encodeBase58(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
    expect(encodeBase58(Buffer.from([0, 0, 1]))).toBe('112');
    expect(encodeBase58(Buffer.alloc(0))).toBe('');
  });

  it('returns the fee payer signature once signed', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = sampleTx(payer.publicKey, other.publicKey);
    tx.partialSign(other);
    expect(transactionSignature(tx)).toBeNull();
    tx.partialSign(payer);
    const signature = transactionSignature(tx)!;
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(signature).toBe(encodeBase58(tx.signature!));
  });

  it('accepts the fully signed copy of a transaction', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = sampleTx(payer.publicKey, other.publicKey);
    tx.partialSign(other);
    const stored = serializeTransactionBase64(tx);
    const returned = deserializeTransactionBase64(stored);
    returned.partialSign(payer);
    const signed = serializeTransactionBase64(returned, { requireAllSignatures: true });
    expect(assertSignedCopyOf(stored, signed).verifySignatures(true)).toBe(true);
    expect(() => assertSignedCopyOf(tx, returned)).not.toThrow();
  });

  it('refuses a substitute transaction or a missing signature', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = sampleTx(payer.publicKey, other.publicKey);
    tx.partialSign(other);
    const stored = serializeTransactionBase64(tx);

    const substitute = new Transaction({
      feePayer: payer.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: other.publicKey,
        lamports: 1,
      }),
    );
    substitute.sign(payer);
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as TransactionEncodingError).code;
      }
    };
    expect(codeOf(() => assertSignedCopyOf(stored, substitute))).toBe('MESSAGE_MISMATCH');
    expect(codeOf(() => assertSignedCopyOf(stored, stored))).toBe('MISSING_SIGNATURE');
  });

  it('computes the wire size without signing', () => {
    const tx = sampleTx(Keypair.generate().publicKey, Keypair.generate().publicKey);
    expect(transactionSize(tx)).toBe(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------------------------

describe('compute budget', () => {
  it('returns a limit and, when set, a price', () => {
    const [limit, price] = computeBudgetInstructions({ units: 300_000, microLamports: 1234 });
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit!.data.readUInt32LE(1)).toBe(300_000);
    expect(price!.data.readBigUInt64LE(1)).toBe(1234n);
    expect(computeBudgetInstructions({ units: 300_000, microLamports: 0 })).toHaveLength(1);
  });

  it.each([
    { units: 0, microLamports: 0 },
    { units: 1_400_001, microLamports: 0 },
    { units: 1.5, microLamports: 0 },
    { units: 1000, microLamports: -1 },
    { units: 1000, microLamports: 0.5 },
  ])('refuses %j', (budget) => {
    expect(() => computeBudgetInstructions(budget)).toThrow(RangeError);
  });

  it('computes the priority fee rounded up', () => {
    expect(priorityFeeLamports({ units: 300_000, microLamports: 0 })).toBe(0n);
    expect(priorityFeeLamports({ units: 300_000, microLamports: 10_000 })).toBe(3000n);
    expect(priorityFeeLamports({ units: 1, microLamports: 1 })).toBe(1n);
  });
});

// ---------------------------------------------------------------------------------------------
// Durable nonce
// ---------------------------------------------------------------------------------------------

function nonceData(authority: PublicKey, nonce: string, state = 1): Buffer {
  const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(state, 4);
  authority.toBuffer().copy(data, 8);
  new PublicKey(nonce).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(5000n, 72);
  return data;
}

function accountsConnection(accounts: Map<string, AccountInfo<Buffer>>) {
  return {
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getMinimumBalanceForRentExemption: async (size: number) => rent(size),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 77 }),
  };
}

const info = (
  owner: PublicKey,
  data: Buffer,
  lamports = rent(data.length),
): AccountInfo<Buffer> => ({
  owner,
  data,
  lamports,
  executable: false,
  rentEpoch: 0,
});

describe('readNonce', () => {
  const nonceAccount = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const nonce = new PublicKey(Buffer.alloc(32, 5)).toBase58();

  it('reads the nonce value and the authority', async () => {
    const connection = accountsConnection(
      new Map([
        [nonceAccount.toBase58(), info(SystemProgram.programId, nonceData(authority, nonce))],
      ]),
    );
    const result = await readNonce(connection, nonceAccount, { expectedAuthority: authority });
    expect(result.nonce).toBe(nonce);
    expect(result.authority.equals(authority)).toBe(true);
    expect(result.lamportsPerSignature).toBe(5000n);
  });

  it.each<[string, AccountInfo<Buffer> | undefined, string]>([
    ['missing', undefined, 'NOT_FOUND'],
    [
      'owned by another program',
      info(Keypair.generate().publicKey, nonceData(authority, nonce)),
      'NOT_A_NONCE_ACCOUNT',
    ],
    ['wrong size', info(SystemProgram.programId, Buffer.alloc(10)), 'NOT_A_NONCE_ACCOUNT'],
    [
      'uninitialized',
      info(SystemProgram.programId, nonceData(authority, nonce, 0)),
      'NOT_A_NONCE_ACCOUNT',
    ],
    [
      'held by someone else',
      info(SystemProgram.programId, nonceData(Keypair.generate().publicKey, nonce)),
      'AUTHORITY_MISMATCH',
    ],
  ])('refuses a nonce account that is %s', async (_label, account, code) => {
    const accounts = new Map<string, AccountInfo<Buffer>>();
    if (account) accounts.set(nonceAccount.toBase58(), account);
    const error = await readNonce(accountsConnection(accounts), nonceAccount, {
      expectedAuthority: authority,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DurableNonceError);
    expect((error as DurableNonceError).code).toBe(code);
  });
});

describe('buildCreateNonceAccountTx', () => {
  it('creates and initializes a nonce account with the rent read from the cluster', async () => {
    const payer = Keypair.generate().publicKey;
    const nonce = Keypair.generate();
    const authority = Keypair.generate().publicKey;
    const result = await buildCreateNonceAccountTx({
      connection: accountsConnection(new Map()) as unknown as Connection,
      payer,
      nonceAccount: nonce,
      authority,
    });
    expect(result.rentLamports).toBe(BigInt(rent(NONCE_ACCOUNT_LENGTH)));
    expect(result.nonceAccount.equals(nonce.publicKey)).toBe(true);
    expect(result.lastValidBlockHeight).toBe(77);
    expect(result.signers.map(String)).toEqual([payer, nonce.publicKey].map(String));
    const [create, init] = result.transaction.instructions;
    const created = SystemInstruction.decodeCreateAccount(create!);
    expect(created.lamports).toBe(rent(NONCE_ACCOUNT_LENGTH));
    expect(created.space).toBe(NONCE_ACCOUNT_LENGTH);
    expect(created.newAccountPubkey.equals(nonce.publicKey)).toBe(true);
    const initialized = SystemInstruction.decodeNonceInitialize(init!);
    expect(initialized.authorizedPubkey.equals(authority)).toBe(true);
    expect(missingSigners(result.transaction).map(String).sort()).toEqual(
      [payer, nonce.publicKey].map(String).sort(),
    );
  });

  it('adds a priority fee only on request and refuses the payer as nonce account', async () => {
    const payer = Keypair.generate().publicKey;
    const connection = accountsConnection(new Map()) as unknown as Connection;
    const result = await buildCreateNonceAccountTx({
      connection,
      payer,
      nonceAccount: Keypair.generate().publicKey,
      authority: payer,
      computeUnitPriceMicroLamports: 5,
    });
    expect(
      result.transaction.instructions[0]!.programId.equals(ComputeBudgetProgram.programId),
    ).toBe(true);
    await expect(
      buildCreateNonceAccountTx({ connection, payer, nonceAccount: payer, authority: payer }),
    ).rejects.toThrow(RangeError);
  });
});

describe('buildCreateNonceAccountWithSeedTx', () => {
  const UUID_SEED = '6f1c2b3a4d5e4f60a7b8c9d0e1f20314'; // a launchpad UUID without its dashes

  it('creates the nonce account at createWithSeed(base, seed), base = payer by default', async () => {
    const base = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const result = await buildCreateNonceAccountWithSeedTx({
      connection: accountsConnection(new Map()) as unknown as Connection,
      base,
      seed: UUID_SEED,
      authority,
    });
    const expected = await PublicKey.createWithSeed(base, UUID_SEED, SystemProgram.programId);
    expect(result.nonceAccount.equals(expected)).toBe(true);
    expect(result.base.equals(base)).toBe(true);
    expect(result.seed).toBe(UUID_SEED);
    expect(result.rentLamports).toBe(BigInt(rent(NONCE_ACCOUNT_LENGTH)));
    expect(result.lastValidBlockHeight).toBe(77);
    expect(result.transaction.feePayer!.equals(base)).toBe(true);
    // Only the base signs: no keypair for the nonce account.
    expect(result.signers.map(String)).toEqual([base.toBase58()]);
    expect(missingSigners(result.transaction).map(String)).toEqual([base.toBase58()]);

    const [create, init] = result.transaction.instructions;
    expect(result.transaction.instructions).toHaveLength(2);
    expect(SystemInstruction.decodeInstructionType(create!)).toBe('CreateWithSeed');
    const created = SystemInstruction.decodeCreateWithSeed(create!);
    expect(created.fromPubkey.equals(base)).toBe(true);
    expect(created.newAccountPubkey.equals(expected)).toBe(true);
    expect(created.basePubkey.equals(base)).toBe(true);
    expect(created.seed).toBe(UUID_SEED);
    expect(created.lamports).toBe(rent(NONCE_ACCOUNT_LENGTH));
    expect(created.space).toBe(NONCE_ACCOUNT_LENGTH);
    expect(created.programId.equals(SystemProgram.programId)).toBe(true);
    const initialized = SystemInstruction.decodeNonceInitialize(init!);
    expect(initialized.noncePubkey.equals(expected)).toBe(true);
    expect(initialized.authorizedPubkey.equals(authority)).toBe(true);
  });

  it('is deterministic: the address is re-derived from base and seed alone', async () => {
    const base = Keypair.generate().publicKey;
    const connection = accountsConnection(new Map()) as unknown as Connection;
    const first = await buildCreateNonceAccountWithSeedTx({
      connection,
      base,
      seed: UUID_SEED,
      authority: base,
    });
    const again = await deriveSeededNonceAccount(base, UUID_SEED);
    expect(again.equals(first.nonceAccount)).toBe(true);
    const other = await deriveSeededNonceAccount(base, `${UUID_SEED.slice(0, 31)}5`);
    expect(other.equals(first.nonceAccount)).toBe(false);
    const otherBase = await deriveSeededNonceAccount(Keypair.generate().publicKey, UUID_SEED);
    expect(otherBase.equals(first.nonceAccount)).toBe(false);
  });

  it('lets a separate payer fund it: payer first, then the base', async () => {
    const base = Keypair.generate();
    const payer = Keypair.generate();
    const result = await buildCreateNonceAccountWithSeedTx({
      connection: accountsConnection(new Map()) as unknown as Connection,
      base: base.publicKey,
      seed: 'forge-launch-nonce',
      authority: base.publicKey,
      payer: payer.publicKey,
      computeUnitPriceMicroLamports: 5,
    });
    expect(result.transaction.feePayer!.equals(payer.publicKey)).toBe(true);
    expect(result.signers.map(String)).toEqual([payer.publicKey, base.publicKey].map(String));
    const [budgetLimit, , create] = result.transaction.instructions;
    expect(budgetLimit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    const created = SystemInstruction.decodeCreateWithSeed(create!);
    expect(created.fromPubkey.equals(payer.publicKey)).toBe(true);
    expect(created.basePubkey.equals(base.publicKey)).toBe(true);
    // Both sign; the signed transaction verifies.
    result.transaction.sign(payer, base);
    expect(result.transaction.verifySignatures(true)).toBe(true);
  });

  it('refuses an empty seed or one over 32 UTF-8 bytes, and accepts exactly 32', async () => {
    const base = Keypair.generate().publicKey;
    const connection = accountsConnection(new Map()) as unknown as Connection;
    for (const seed of ['', 'x'.repeat(33), 'é'.repeat(17)]) {
      await expect(
        buildCreateNonceAccountWithSeedTx({ connection, base, seed, authority: base }),
      ).rejects.toThrow(RangeError);
      await expect(deriveSeededNonceAccount(base, seed)).rejects.toThrow(RangeError);
    }
    expect(() => assertNonceSeed('é'.repeat(16))).not.toThrow();
    expect(MAX_NONCE_SEED_BYTES).toBe(32);
    await expect(
      buildCreateNonceAccountWithSeedTx({
        connection,
        base,
        seed: 'x'.repeat(32),
        authority: base,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses keys that are not public keys', async () => {
    const base = Keypair.generate().publicKey;
    const connection = accountsConnection(new Map()) as unknown as Connection;
    await expect(
      buildCreateNonceAccountWithSeedTx({
        connection,
        base,
        seed: UUID_SEED,
        authority: base.toBase58() as unknown as PublicKey,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('creates an account readNonce accepts once initialized', async () => {
    const base = Keypair.generate().publicKey;
    const address = await deriveSeededNonceAccount(base, UUID_SEED);
    const data = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
    data.writeUInt32LE(1, 0);
    data.writeUInt32LE(1, 4);
    base.toBuffer().copy(data, 8);
    new PublicKey(Buffer.alloc(32, 8)).toBuffer().copy(data, 40);
    data.writeBigUInt64LE(5000n, 72);
    const connection = accountsConnection(
      new Map([[address.toBase58(), info(SystemProgram.programId, data)]]),
    );
    const read = await readNonce(connection, address, { expectedAuthority: base });
    expect(read.nonceAccount.equals(address)).toBe(true);
    expect(read.authority.equals(base)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Rent exemption
// ---------------------------------------------------------------------------------------------

describe('assertRentExempt', () => {
  it('accepts rent-exempt accounts and lists every failing one', async () => {
    const ok = Keypair.generate().publicKey;
    const poor = Keypair.generate().publicKey;
    const missing = Keypair.generate().publicKey;
    const connection = accountsConnection(
      new Map([
        [ok.toBase58(), info(SystemProgram.programId, Buffer.alloc(0))],
        [poor.toBase58(), info(SystemProgram.programId, Buffer.alloc(0), rent(0) - 1)],
      ]),
    );
    await expect(assertRentExempt(connection, [{ address: ok, label: 'ok' }])).resolves.toBe(
      undefined,
    );
    await expect(assertRentExempt(connection, [])).resolves.toBe(undefined);
    const error = await assertRentExempt(connection, [
      { address: ok, label: 'ok' },
      { address: poor, label: 'platformFeeWallet' },
      { address: missing, label: 'referral' },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RentExemptionError);
    expect((error as RentExemptionError).accounts.map((a) => a.label)).toEqual([
      'platformFeeWallet',
      'referral',
    ]);
  });
});
