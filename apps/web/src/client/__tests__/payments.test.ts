// @vitest-environment node
import type { Quote } from '@forge/shared';
import { Keypair, SendTransactionError } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentPendingError, getQuote, payQuote, resumePayment } from '../actions';
import { PAYMENT_CONFIRM_TIMING, getSentPayment, resetSentPayments } from '../payments';
import { setSession } from '../session-store';
import {
  SIG,
  bodyOf,
  encode,
  fakeConnection,
  fakeSign,
  id,
  json,
  mockFetch,
  owner,
  paymentTx,
  phases,
  rejection,
  setWallet,
  signIn,
} from './helpers';

const LAMPORTS = '250000000';

function quoteResponse(jobId: string, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: id(),
    kind: 'creation',
    lamports: LAMPORTS,
    usdAmount: 45,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    transaction: encode(paymentTx({ lamports: LAMPORTS, jobId })),
    ...overrides,
  };
}

type ConfirmReply = Response | Error | (() => Response | Promise<Response>);

/** Quote route + a scripted sequence of confirm replies (the last one repeats). */
function scriptedServer(jobId: string, replies: ConfirmReply[], quote = quoteResponse(jobId)) {
  const confirms: Record<string, unknown>[] = [];
  let i = 0;
  const fetchFn = mockFetch((url, init) => {
    if (url === '/api/payments/quote') return json(quote);
    confirms.push(bodyOf(init));
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i++;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply.clone();
  });
  return { quote, confirms, fetchFn };
}

async function settle<T>(promise: Promise<T>, ms = 200_000): Promise<T> {
  let done = false;
  const out = promise.finally(() => {
    done = true;
  });
  for (let waited = 0; !done && waited < ms; waited += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSentPayments();
  signIn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setSession(null);
});

describe('getQuote', () => {
  it('returns the quote without the transaction', async () => {
    const jobId = id();
    const { quote } = scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const out = await getQuote(jobId, 'creation');
    expect(out).toMatchObject({ paymentId: quote.paymentId, lamports: LAMPORTS, usdAmount: 45 });
    expect('transaction' in out).toBe(false);
  });
});

describe('payQuote', () => {
  it('signs, sends, saves the signature right after sending, then confirms', async () => {
    const jobId = id();
    const connection = signIn();
    let savedAtConfirm: unknown = null;
    const { quote, confirms } = scriptedServer(jobId, [
      () => {
        savedAtConfirm = getSentPayment(jobId);
        return json({ status: 'confirmed' });
      },
    ]);
    const q = await getQuote(jobId, 'creation');
    const p = phases();
    const result = await settle(payQuote(q, p.on));
    expect(result).toEqual({ phase: 'confirmed', signature: SIG, outcome: 'confirmed' });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    expect(connection!.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(savedAtConfirm).toMatchObject({ jobId, paymentId: quote.paymentId, signature: SIG });
    expect(confirms).toEqual([{ paymentId: quote.paymentId, signature: SIG }]);
    expect(getSentPayment(jobId)).toBeNull();
  });

  it('re-confirms the same signature on 202, 429 (Retry-After), 503 and network errors', async () => {
    const jobId = id();
    const { confirms } = scriptedServer(jobId, [
      json({ status: 'quoted' }, 202, { 'Retry-After': '2' }),
      json({ code: 'RATE_LIMITED', message: 'Slow down' }, 429, { 'Retry-After': '6' }),
      json({ code: 'RPC_UNAVAILABLE', message: 'Later' }, 503),
      new TypeError('Failed to fetch'),
      json({ status: 'confirmed' }),
    ]);
    const q = await getQuote(jobId, 'creation');
    const started = Date.now();
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'confirmed', signature: SIG });
    expect(confirms).toHaveLength(5);
    expect(new Set(confirms.map((c) => c.signature))).toEqual(new Set([SIG]));
    // 2 s + Retry-After 6 s + 2 s + 2 s at least.
    expect(Date.now() - started).toBeGreaterThanOrEqual(12_000);
  });

  it('retries a request that times out', async () => {
    const jobId = id();
    let calls = 0;
    mockFetch((url, init) => {
      if (url === '/api/payments/quote') return json(quoteResponse(jobId));
      calls++;
      if (calls === 1) {
        // Never answers: aborted by the request timeout.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return json({ status: 'confirmed' });
    });
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result.phase).toBe('confirmed');
    expect(calls).toBe(2);
  });

  it('keeps confirming for about 90 s, then reports "still confirming" with the signature', async () => {
    const jobId = id();
    const sign = vi.fn(fakeSign());
    setWallet(sign);
    const { confirms } = scriptedServer(jobId, [json({ status: 'quoted' }, 202)]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'error', signature: SIG, outcome: 'confirming' });
    expect(result.error).toMatch(/still being confirmed/);
    const elapsedCalls = confirms.length;
    expect(elapsedCalls).toBeGreaterThan(20);
    expect(elapsedCalls * PAYMENT_CONFIRM_TIMING.intervalMs).toBeLessThanOrEqual(
      PAYMENT_CONFIRM_TIMING.maxWaitMs + PAYMENT_CONFIRM_TIMING.intervalMs,
    );
    expect(getSentPayment(jobId)).toMatchObject({ signature: SIG, outcome: 'confirming' });

    // No new quote while it is unresolved, and paying again only re-confirms.
    await expect(getQuote(jobId, 'creation')).rejects.toBeInstanceOf(PaymentPendingError);
    const again = await settle(payQuote(q, () => undefined));
    expect(again.outcome).toBe('confirming');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('resumePayment confirms the saved signature without signing again', async () => {
    const jobId = id();
    const sign = vi.fn();
    const first = scriptedServer(jobId, [json({ status: 'quoted' }, 202)]);
    const q = await getQuote(jobId, 'creation');
    await settle(payQuote(q, () => undefined));
    setWallet(sign);
    const later = scriptedServer(jobId, [json({ status: 'confirmed' })], first.quote);
    const p = phases();
    const result = await settle(resumePayment(jobId, p.on));
    expect(result).toEqual({ phase: 'confirmed', signature: SIG, outcome: 'confirmed' });
    expect(later.confirms).toEqual([{ paymentId: first.quote.paymentId, signature: SIG }]);
    expect(p.list).toEqual(['sending', 'confirmed']);
    expect(sign).not.toHaveBeenCalled();
    expect(getSentPayment(jobId)).toBeNull();
    await expect(resumePayment(jobId, () => undefined)).resolves.toEqual({ phase: 'idle' });
  });

  it('on 410 after sending: manual refund message, signature kept, never a second payment', async () => {
    const jobId = id();
    scriptedServer(jobId, [
      json({ code: 'QUOTE_EXPIRED', message: 'This quote has expired.', status: 'expired' }, 410),
    ]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'error', signature: SIG, outcome: 'late' });
    expect(result.error).toMatch(/refunded manually/);
    expect(result.error).toMatch(/support/);
    expect(getSentPayment(jobId)).toMatchObject({ outcome: 'late', signature: SIG });
    await expect(getQuote(jobId, 'creation')).rejects.toBeInstanceOf(PaymentPendingError);
    const fetchFn = mockFetch(() => json({ status: 'confirmed' }));
    await expect(resumePayment(jobId, () => undefined)).resolves.toMatchObject({
      outcome: 'late',
      signature: SIG,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats a 200 "expired" status after sending as a late payment', async () => {
    const jobId = id();
    scriptedServer(jobId, [json({ status: 'expired' })]);
    const q = await getQuote(jobId, 'creation');
    await expect(settle(payQuote(q, () => undefined))).resolves.toMatchObject({
      outcome: 'late',
    });
  });

  it('a payment that failed on-chain is cleared so a new quote can be requested', async () => {
    const jobId = id();
    scriptedServer(jobId, [
      json({ code: 'PAYMENT_FAILED', message: 'The transaction failed on-chain.' }, 422),
    ]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'error', signature: SIG, outcome: 'failed' });
    expect(getSentPayment(jobId)).toBeNull();
    await expect(getQuote(jobId, 'creation')).resolves.toBeDefined();
  });

  it('other refusals after sending keep the signature for support', async () => {
    const jobId = id();
    scriptedServer(jobId, [
      json({ code: 'PAYMENT_INVALID', message: 'This transaction is not a valid payment.' }, 422),
    ]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'error', signature: SIG, outcome: 'rejected' });
    expect(result.error).toMatch(/not a valid payment/);
    expect(getSentPayment(jobId)?.outcome).toBe('rejected');
  });

  it('keeps the payment unresolved when the session expires while confirming', async () => {
    const jobId = id();
    scriptedServer(jobId, [json({ code: 'UNAUTHORIZED', message: 'Not signed in.' }, 401)]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ outcome: 'confirming', signature: SIG });
    expect(getSentPayment(jobId)?.outcome).toBe('confirming');
  });

  it('a preflight refusal was never broadcast: no saved signature, the quote stays usable', async () => {
    const jobId = id();
    const refused = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: 'Attempt to debit an account but found no record of a prior credit.',
      logs: [],
    });
    const connection = fakeConnection({
      sendRawTransaction: vi.fn().mockRejectedValueOnce(refused).mockResolvedValue(SIG),
    });
    signIn(connection);
    const { confirms } = scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const q = await getQuote(jobId, 'creation');
    const p = phases();
    const first = await settle(payQuote(q, p.on));
    expect(first.phase).toBe('error');
    expect(first.signature).toBeUndefined();
    expect(first.error).toMatch(/no record of a prior credit/);
    expect(getSentPayment(jobId)).toBeNull();
    expect(confirms).toHaveLength(0);
    const second = await settle(payQuote(q, () => undefined));
    expect(second.phase).toBe('confirmed');
  });

  it('a send that fails on the network is treated as sent and re-broadcast', async () => {
    const jobId = id();
    const connection = fakeConnection({
      sendRawTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValue(SIG),
    });
    signIn(connection);
    const { confirms } = scriptedServer(jobId, [
      json({ status: 'quoted' }, 202),
      json({ status: 'confirmed' }),
    ]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'confirmed', signature: SIG });
    expect(connection!.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(confirms).toHaveLength(2);
  });

  it('reports rejected (not error) when the user declines', async () => {
    const jobId = id();
    setWallet(async () => {
      throw rejection();
    });
    scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const q = await getQuote(jobId, 'creation');
    const p = phases();
    await expect(payQuote(q, p.on)).resolves.toEqual({ phase: 'rejected' });
    expect(p.list).toEqual(['awaiting_signature', 'rejected']);
    expect(getSentPayment(jobId)).toBeNull();
  });

  it('throws QUOTE_EXPIRED for an already expired quote, before any prompt', async () => {
    const sign = vi.fn();
    setWallet(sign);
    const quote: Quote = {
      paymentId: id(),
      kind: 'creation',
      lamports: '1',
      usdAmount: 1,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('throws QUOTE_EXPIRED for an unknown quote (page reload)', async () => {
    const quote: Quote = {
      paymentId: id(),
      kind: 'creation',
      lamports: '1',
      usdAmount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('confirms a free quote without touching the wallet', async () => {
    const sign = vi.fn();
    setWallet(sign);
    const jobId = id();
    scriptedServer(jobId, [json({})], quoteResponse(jobId, { lamports: '0', transaction: null }));
    const quote = await getQuote(jobId, 'modification');
    const p = phases();
    await expect(payQuote(quote, p.on)).resolves.toEqual({ phase: 'confirmed' });
    expect(p.list).toEqual(['confirmed']);
    expect(sign).not.toHaveBeenCalled();
  });

  it('requires a connected wallet and the signed-in wallet', async () => {
    const jobId = id();
    scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const quote = await getQuote(jobId, 'creation');
    setWallet(undefined, null, null);
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    setWallet(vi.fn());
    setSession(null);
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    setSession({ wallet: 'SomeOtherWallet1111111111111111111111111111' });
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
    expect(owner).toBeDefined();
  });
});

describe('payment transaction checks', () => {
  it('refuses a transaction that is not exactly the quoted payment, before signing', async () => {
    const jobId = id();
    const sign = vi.fn();
    setWallet(sign);
    const tampered = quoteResponse(jobId, {
      transaction: encode(paymentTx({ lamports: '250000001', jobId })),
    });
    const { confirms } = scriptedServer(jobId, [json({ status: 'confirmed' })], tampered);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/amount does not match the quote/);
    expect(sign).not.toHaveBeenCalled();
    expect(confirms).toHaveLength(0);
    expect(getSentPayment(jobId)).toBeNull();
  });

  it('pins the recipient to NEXT_PUBLIC_FORGE_CASHBOX_WALLET when it is set', async () => {
    const cashbox = Keypair.generate().publicKey;
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', cashbox.toBase58());
    try {
      const jobId = id();
      const sign = vi.fn(fakeSign());
      setWallet(sign);
      scriptedServer(jobId, [json({ status: 'confirmed' })]);
      const elsewhere = await getQuote(jobId, 'creation');
      const refused = await settle(payQuote(elsewhere, () => undefined));
      expect(refused.error).toMatch(/not the FORGE cashbox/);
      expect(sign).not.toHaveBeenCalled();

      const okJob = id();
      scriptedServer(
        okJob,
        [json({ status: 'confirmed' })],
        quoteResponse(okJob, {
          transaction: encode(paymentTx({ lamports: LAMPORTS, jobId: okJob, cashbox })),
        }),
      );
      const good = await getQuote(okJob, 'creation');
      await expect(settle(payQuote(good, () => undefined))).resolves.toMatchObject({
        phase: 'confirmed',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses what the wallet returns when it moved funds elsewhere', async () => {
    const jobId = id();
    setWallet(async () => {
      const changed = paymentTx({ lamports: '999', jobId });
      changed.signatures[0] = new Uint8Array(64).fill(7);
      return changed;
    });
    const { confirms } = scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result.error).toMatch(/Your wallet changed the transaction/);
    expect(confirms).toHaveLength(0);
  });
});

describe('payment sends the node already processed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSentPayments();
  });

  it('counts "already processed" as sent and confirms it, never as a refusal', async () => {
    const jobId = id();
    const processed = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage:
        'Transaction simulation failed: This transaction has already been processed',
      logs: [],
    });
    signIn(fakeConnection({ sendRawTransaction: vi.fn().mockRejectedValue(processed) }));
    const { confirms } = scriptedServer(jobId, [json({ status: 'confirmed' })]);
    const q = await getQuote(jobId, 'creation');
    const result = await settle(payQuote(q, () => undefined));
    expect(result).toMatchObject({ phase: 'confirmed', signature: SIG });
    expect(confirms).toHaveLength(1);
  });
});
