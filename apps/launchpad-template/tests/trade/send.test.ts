import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { TradeError } from '../../src/forge/trade/errors';
import {
  MAX_BLOCKHASH_AGE,
  EXPIRY_MARGIN_BLOCKS,
  expiryHeightOf,
  firstSignature,
  lookupPending,
  sendSigned,
  type PendingTrade,
} from '../../src/forge/trade/send';

const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));
const payer = Keypair.generate();

function legacyTx(): Transaction {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 900,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  return tx;
}

function versionedTx(): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey('11111111111111111111111111111112'),
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const status = (value: unknown) => ({ context: { slot: 1 }, value: [value] });

function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    sendRawTransaction: vi.fn(async () => 'IGNORED'),
    getSignatureStatuses: vi.fn(async () => status(null)),
    getBlockHeight: vi.fn(async () => 100),
    ...overrides,
  };
}

/** A clock that moves forward on every sleep, so deadlines are reached without waiting. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(ms, 1)) };
}

const pending: PendingTrade = { signature: 'S'.repeat(88), expiryHeight: 200 };
const BYTES = new Uint8Array([1, 2, 3]);

describe('firstSignature', () => {
  it('is the base58 fee-payer signature of a signed legacy transaction', () => {
    const tx = legacyTx();
    tx.sign(payer);
    expect(firstSignature(tx)).toBe(bs58.encode(tx.signature as Buffer));
  });

  it('is the base58 first signature of a signed versioned transaction', () => {
    const tx = versionedTx();
    tx.sign([payer]);
    expect(firstSignature(tx)).toBe(bs58.encode(tx.signatures[0] as Uint8Array));
  });

  it('refuses an unsigned transaction', () => {
    expect(() => firstSignature(legacyTx())).toThrow(TradeError);
    expect(() => firstSignature(versionedTx())).toThrow(/did not sign/);
  });
});

describe('expiryHeightOf', () => {
  it('uses the legacy lastValidBlockHeight when set', async () => {
    const connection = fakeConnection();
    expect(await expiryHeightOf(legacyTx(), connection as never)).toBe(900);
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });

  it('otherwise bounds it from the current block height', async () => {
    const connection = fakeConnection();
    expect(await expiryHeightOf(versionedTx(), connection as never)).toBe(
      100 + MAX_BLOCKHASH_AGE + EXPIRY_MARGIN_BLOCKS,
    );
  });
});

describe('sendSigned', () => {
  it('returns sent when the send call succeeds', async () => {
    const connection = fakeConnection();
    expect(await sendSigned(connection as never, BYTES, pending)).toEqual({ kind: 'sent' });
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('rejects at once when the node refused the transaction in preflight', async () => {
    const connection = fakeConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('failed to send transaction: Transaction simulation failed: slippage');
      }),
    });
    const outcome = await sendSigned(connection as never, BYTES, pending, fakeClock());
    expect(outcome.kind).toBe('rejected');
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('on an ambiguous send error, finds the signature by polling and does not fail', async () => {
    const statuses = vi
      .fn()
      .mockResolvedValueOnce(status(null))
      .mockResolvedValue(status({ err: null, confirmationStatus: 'processed' }));
    const connection = fakeConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      getSignatureStatuses: statuses,
    });
    const outcome = await sendSigned(connection as never, BYTES, pending, fakeClock());
    expect(outcome).toEqual({ kind: 'sent' });
    expect(statuses).toHaveBeenCalledWith([pending.signature], { searchTransactionHistory: true });
  });

  it('re-sends the same bytes while the blockhash is valid, never other bytes', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const connection = fakeConnection({ sendRawTransaction: send });
    const outcome = await sendSigned(connection as never, BYTES, pending, {
      ...fakeClock(),
      timeoutMs: 10,
      intervalMs: 1,
    });
    expect(outcome.kind).toBe('unknown');
    expect(outcome.kind === 'unknown' && outcome.error.code).toBe('confirm_timeout');
    expect(outcome.kind === 'unknown' && outcome.error.signature).toBe(pending.signature);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const call of send.mock.calls as unknown as [Uint8Array][]) expect(call[0]).toBe(BYTES);
  });

  it('settles as expired once the block height passed the expiry with no status', async () => {
    const heights = vi.fn().mockResolvedValueOnce(150).mockResolvedValue(201);
    const connection = fakeConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
      getBlockHeight: heights,
    });
    const outcome = await sendSigned(connection as never, BYTES, pending, fakeClock());
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.error.code).toBe('blockhash_expired');
  });

  it('treats "already processed" as sent', async () => {
    const connection = fakeConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new Error(
          'Transaction simulation failed: This transaction has already been processed',
        );
      }),
    });
    expect(await sendSigned(connection as never, BYTES, pending, fakeClock())).toEqual({
      kind: 'sent',
    });
  });
});

describe('lookupPending', () => {
  it('reads the block height before the status', async () => {
    const connection = fakeConnection();
    await lookupPending(connection as never, pending);
    const heightOrder = connection.getBlockHeight.mock.invocationCallOrder[0] as number;
    const statusOrder = connection.getSignatureStatuses.mock.invocationCallOrder[0] as number;
    expect(heightOrder).toBeLessThan(statusOrder);
  });

  it('distinguishes landed, failed, pending and expired', async () => {
    const landed = fakeConnection({
      getSignatureStatuses: vi.fn(async () =>
        status({ err: null, confirmationStatus: 'confirmed' }),
      ),
    });
    expect((await lookupPending(landed as never, pending)).state).toBe('landed');
    const failed = fakeConnection({
      getSignatureStatuses: vi.fn(async () => status({ err: { InstructionError: [0, 'X'] } })),
    });
    expect((await lookupPending(failed as never, pending)).state).toBe('failed');
    expect((await lookupPending(fakeConnection() as never, pending)).state).toBe('pending');
    const expired = fakeConnection({ getBlockHeight: vi.fn(async () => 201) });
    expect((await lookupPending(expired as never, pending)).state).toBe('expired');
  });
});
