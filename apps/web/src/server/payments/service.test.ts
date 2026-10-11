// @vitest-environment node
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID, paymentMemo } from './core-adapter';
import { ClusterMismatchError, PriceUnavailableError, RpcUnavailableError } from './errors';
import { MemoryLogger } from './log';
import { MemoryPaymentsStore } from './memory-store';
import { FixedPriceSource, type SolUsdPriceSource } from './price-source';
import { createPaymentsService, QUOTE_TIMING, receivedLamports, type QuoteResult } from './service';
import {
  FakeChainGateway,
  landedPayment,
  landedTx,
  randomSignature,
  TestClock,
  decodeSystemTransfer,
} from './test-helpers';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const OWNER = PublicKey.unique();
const OTHER = PublicKey.unique();
const CASHBOX = PublicKey.unique();
const OWNER_WALLET = OWNER.toBase58();

/** $33 at 150 $/SOL = 0.22 SOL exactly. */
const CREATION_LAMPORTS = 220_000_000n;

const throwingPrices: SolUsdPriceSource = {
  getSolUsdPrice: () => Promise.reject(new Error('price source must not be called')),
};

function setup(options: { prices?: SolUsdPriceSource; included?: number } = {}) {
  const clock = new TestClock(T0);
  const store = new MemoryPaymentsStore();
  const gateway = new FakeChainGateway(CASHBOX);
  const logger = new MemoryLogger();
  const service = createPaymentsService({
    store,
    gateway,
    prices: options.prices ?? new FixedPriceSource(150),
    logger,
    now: clock.now,
    sleep: clock.sleep,
  });
  const launchpad = store.addLaunchpad({
    ownerWallet: OWNER_WALLET,
    includedModificationsLeft: options.included ?? 2,
  });
  const job = store.addJob({ launchpadId: launchpad.id, type: 'create_launchpad' });
  return { clock, store, gateway, logger, service, launchpad, job };
}

type Ctx = ReturnType<typeof setup>;

/** Lands the exact payment of `quote` for `jobId` and returns its signature. */
function pay(
  ctx: Ctx,
  quote: QuoteResult,
  jobId: string,
  overrides: { blockTime?: number | null } = {},
) {
  const signature = randomSignature();
  ctx.gateway.land(
    signature,
    landedPayment({
      payer: OWNER,
      cashbox: CASHBOX,
      lamports: BigInt(quote.lamports),
      jobId,
      blockTime: overrides.blockTime === undefined ? ctx.clock.seconds() : overrides.blockTime,
    }),
  );
  return signature;
}

function quoteCreation(ctx: Ctx, jobId = ctx.job.id) {
  return ctx.service.createQuote({ wallet: OWNER_WALLET, jobId, kind: 'creation' });
}

function confirm(ctx: Ctx, paymentId: string, signature: string, wallet = OWNER_WALLET) {
  return ctx.service.confirmPayment({ wallet, paymentId, signature });
}

describe('createQuote', () => {
  it('prices a creation server-side and returns an unsigned tx bound to payer, cashbox, amount and job', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);

    expect(quote).toMatchObject({
      kind: 'creation',
      lamports: CREATION_LAMPORTS.toString(),
      usdAmount: 33,
      expiresAt: new Date(T0 + 120_000).toISOString(),
    });
    const row = ctx.store.payments.get(quote.paymentId)!;
    expect(row).toMatchObject({
      jobId: ctx.job.id,
      payerWallet: OWNER_WALLET,
      kind: 'creation',
      lamports: CREATION_LAMPORTS,
      status: 'quoted',
      txSignature: null,
      quoteExpiresAt: T0 + 120_000,
    });

    // Decoded exactly like the browser client does.
    const tx = VersionedTransaction.deserialize(Buffer.from(quote.transaction!, 'base64'));
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.equals(OWNER)).toBe(true);
    const [transfer, memo] = tx.message.compiledInstructions;
    expect(keys[transfer!.programIdIndex]!.equals(SystemProgram.programId)).toBe(true);
    expect(keys[transfer!.accountKeyIndexes[1]!]!.equals(CASHBOX)).toBe(true);
    expect(decodeSystemTransfer(transfer!.data)).toBe(CREATION_LAMPORTS);
    expect(keys[memo!.programIdIndex]!.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(memo!.data).toString('utf8')).toBe(paymentMemo(ctx.job.id));
  });

  it('quotes a paid modification at $5.50 once the included ones are used', async () => {
    const ctx = setup({ included: 0 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const quote = await ctx.service.createQuote({
      wallet: OWNER_WALLET,
      jobId: job.id,
      kind: 'modification',
    });
    expect(quote.usdAmount).toBe(5.5);
    expect(quote.lamports).toBe('36666667'); // ceil(5.5 / 150 SOL)
    expect(quote.transaction).not.toBeNull();
    expect(ctx.store.jobs.get(job.id)!.status).toBe('spec_ready');
  });

  it('uses an included modification: zero quote, job paid, counter decremented, no transaction', async () => {
    const ctx = setup({ prices: throwingPrices, included: 2 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const quote = await ctx.service.createQuote({
      wallet: OWNER_WALLET,
      jobId: job.id,
      kind: 'modification',
    });
    expect(quote).toMatchObject({ lamports: '0', usdAmount: 0, transaction: null });
    expect(ctx.store.jobs.get(job.id)!.status).toBe('paid');
    expect(ctx.store.launchpads.get(ctx.launchpad.id)!.includedModificationsLeft).toBe(1);
    expect(ctx.store.payments.get(quote.paymentId)).toMatchObject({
      status: 'confirmed',
      lamports: 0n,
      txSignature: null,
    });
    expect(ctx.gateway.built).toHaveLength(0);
    expect(ctx.store.events.map((e) => e.jobId)).toEqual([job.id]);
  });

  it('consumes an included modification exactly once under concurrent requests for one job', async () => {
    const ctx = setup({ prices: throwingPrices, included: 2 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const input = { wallet: OWNER_WALLET, jobId: job.id, kind: 'modification' as const };
    const results = await Promise.allSettled([
      ctx.service.createQuote(input),
      ctx.service.createQuote(input),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ALREADY_PAID' });
    expect(ctx.store.launchpads.get(ctx.launchpad.id)!.includedModificationsLeft).toBe(1);
    expect(ctx.store.transitions).toHaveLength(1);
  });

  it('gives the last included modification to one job and a paid quote to the other', async () => {
    const ctx = setup({ included: 1 });
    const a = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const b = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const [qa, qb] = await Promise.all([
      ctx.service.createQuote({ wallet: OWNER_WALLET, jobId: a.id, kind: 'modification' }),
      ctx.service.createQuote({ wallet: OWNER_WALLET, jobId: b.id, kind: 'modification' }),
    ]);
    expect([qa.lamports, qb.lamports].sort()).toEqual(['0', '36666667']);
    expect(ctx.store.launchpads.get(ctx.launchpad.id)!.includedModificationsLeft).toBe(0);
    const statuses = [ctx.store.jobs.get(a.id)!.status, ctx.store.jobs.get(b.id)!.status].sort();
    expect(statuses).toEqual(['paid', 'spec_ready']);
  });

  it('rejects an unknown job, another wallet, a kind mismatch and a disabled launchpad', async () => {
    const ctx = setup();
    await expect(
      ctx.service.createQuote({
        wallet: OWNER_WALLET,
        jobId: '00000000-0000-4000-8000-000000000000',
        kind: 'creation',
      }),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'NOT_FOUND' });
    await expect(
      ctx.service.createQuote({ wallet: OTHER.toBase58(), jobId: ctx.job.id, kind: 'creation' }),
    ).rejects.toMatchObject({ httpStatus: 403, code: 'WRONG_WALLET' });
    await expect(
      ctx.service.createQuote({ wallet: OWNER_WALLET, jobId: ctx.job.id, kind: 'modification' }),
    ).rejects.toMatchObject({ httpStatus: 400, code: 'KIND_MISMATCH' });
    ctx.store.launchpads.get(ctx.launchpad.id)!.status = 'disabled';
    await expect(quoteCreation(ctx)).rejects.toMatchObject({ code: 'LAUNCHPAD_DISABLED' });
    expect(ctx.store.payments.size).toBe(0);
  });

  it('expires its own quote when the draft is released while the quote is being written', async () => {
    const ctx = setup();
    ctx.store.beforeStatement = (name) => {
      // The release (another wallet's confirmation) lands right after the quote row is written.
      if (name === 'insertQuote') {
        queueMicrotask(() => {
          ctx.store.launchpads.get(ctx.launchpad.id)!.status = 'disabled';
        });
      }
    };
    await expect(quoteCreation(ctx)).rejects.toMatchObject({
      httpStatus: 403,
      code: 'LAUNCHPAD_DISABLED',
    });
    const rows = [...ctx.store.payments.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('expired');
  });

  it('refuses to confirm a creation payment for a released draft and records it for a refund', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    ctx.store.launchpads.get(ctx.launchpad.id)!.status = 'disabled';
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 403,
      code: 'LAUNCHPAD_DISABLED',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('spec_ready');
    expect(ctx.store.payments.get(quote.paymentId)!.txSignature).toBeNull();
    expect(
      ctx.logger.entries.some(
        (e) => e.event === 'confirm.launchpad_disabled' && e.fields.signature === signature,
      ),
    ).toBe(true);
    expect([...ctx.store.anomalies.values()]).toEqual([
      {
        jobId: ctx.job.id,
        paymentId: quote.paymentId,
        wallet: OWNER_WALLET,
        signature,
        lamports: CREATION_LAMPORTS,
        reason: 'launchpad_released',
        note: null,
      },
    ]);
  });

  it('rejects when spec.ownerWallet differs from the launchpad owner', async () => {
    const ctx = setup();
    ctx.store.launchpads.get(ctx.launchpad.id)!.specOwnerWallet = OTHER.toBase58();
    await expect(quoteCreation(ctx)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
  });

  it('rejects a job that is no longer awaiting payment', async () => {
    const ctx = setup();
    ctx.store.jobs.get(ctx.job.id)!.status = 'building';
    await expect(quoteCreation(ctx)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'ALREADY_PAID',
    });
  });

  it('refuses creation quotes while signups are paused, not modification quotes', async () => {
    const ctx = setup({ included: 0 });
    ctx.store.flags.set('signups_paused', true);
    await expect(quoteCreation(ctx)).rejects.toMatchObject({
      httpStatus: 503,
      code: 'SIGNUPS_PAUSED',
    });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    await expect(
      ctx.service.createQuote({ wallet: OWNER_WALLET, jobId: job.id, kind: 'modification' }),
    ).resolves.toMatchObject({ kind: 'modification' });
  });

  it('creates no quote when the price or the chain is unavailable', async () => {
    const noPrice = setup({
      prices: { getSolUsdPrice: () => Promise.reject(new PriceUnavailableError()) },
    });
    await expect(quoteCreation(noPrice)).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(noPrice.store.payments.size).toBe(0);

    const noRpc = setup();
    noRpc.gateway.failure = new RpcUnavailableError();
    await expect(quoteCreation(noRpc)).rejects.toBeInstanceOf(RpcUnavailableError);
    expect(noRpc.store.payments.size).toBe(0);
  });

  it('hands the open quote out again instead of a second one (same amount, memo, expiry)', async () => {
    let priceCalls = 0;
    const ctx = setup({
      prices: {
        getSolUsdPrice: () => {
          priceCalls += 1;
          return Promise.resolve(priceCalls === 1 ? 150 : 100);
        },
      },
    });
    const first = await quoteCreation(ctx);
    ctx.clock.advance(30_000);
    const second = await quoteCreation(ctx);
    expect(second).toEqual({ ...first, transaction: second.transaction });
    expect(priceCalls).toBe(1);
    expect(ctx.store.payments.size).toBe(1);
    // A freshly built transaction paying the same quote.
    expect(ctx.gateway.built).toEqual([
      { payer: OWNER_WALLET, lamports: CREATION_LAMPORTS, jobId: ctx.job.id },
      { payer: OWNER_WALLET, lamports: CREATION_LAMPORTS, jobId: ctx.job.id },
    ]);
    const tx = VersionedTransaction.deserialize(Buffer.from(second.transaction!, 'base64'));
    const [transfer, memo] = tx.message.compiledInstructions;
    expect(decodeSystemTransfer(transfer!.data)).toBe(CREATION_LAMPORTS);
    expect(Buffer.from(memo!.data).toString('utf8')).toBe(paymentMemo(ctx.job.id));
    expect(ctx.logger.events()).toContain('quote.reused');
  });

  it('quotes again once the open quote is too close to its expiry, or expired', async () => {
    const ctx = setup();
    const first = await quoteCreation(ctx);
    ctx.clock.advance(QUOTE_TIMING.validityMs - QUOTE_TIMING.reuseMinRemainingMs);
    const second = await quoteCreation(ctx);
    expect(second.paymentId).not.toBe(first.paymentId);

    ctx.store.payments.get(second.paymentId)!.status = 'expired';
    const third = await quoteCreation(ctx);
    expect(new Set([first.paymentId, second.paymentId, third.paymentId]).size).toBe(3);
  });

  it('hands the same quote to concurrent requests and expires the extra rows', async () => {
    const ctx = setup();
    const quotes = await Promise.all([quoteCreation(ctx), quoteCreation(ctx), quoteCreation(ctx)]);
    expect(new Set(quotes.map((q) => q.paymentId)).size).toBe(1);
    const rows = [...ctx.store.payments.values()];
    expect(rows.filter((r) => r.status === 'quoted').map((r) => r.id)).toEqual([
      quotes[0]!.paymentId,
    ]);
    expect(rows.filter((r) => r.status === 'expired').length).toBe(rows.length - 1);
  });

  it('expires its own paid quote when the job got paid while the quote was written', async () => {
    const ctx = setup({ included: 0 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    ctx.store.beforeStatement = (name) => {
      if (name === 'insertQuote') {
        queueMicrotask(() => {
          ctx.store.jobs.get(job.id)!.status = 'paid';
        });
      }
    };
    await expect(
      ctx.service.createQuote({ wallet: OWNER_WALLET, jobId: job.id, kind: 'modification' }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'ALREADY_PAID' });
    expect([...ctx.store.payments.values()].map((p) => p.status)).toEqual(['expired']);
  });

  it('expires its own quote and repairs the job when a confirmed payment appears meanwhile', async () => {
    const ctx = setup();
    ctx.store.beforeStatement = (name) => {
      if (name === 'insertQuote') {
        ctx.store.beforeStatement = null;
        queueMicrotask(() => {
          ctx.store.payments.set('paid-elsewhere', {
            id: 'paid-elsewhere',
            jobId: ctx.job.id,
            payerWallet: OWNER_WALLET,
            kind: 'creation',
            usdAmount: 33,
            lamports: CREATION_LAMPORTS,
            quoteExpiresAt: T0,
            txSignature: randomSignature(),
            status: 'confirmed',
          });
        });
      }
    };
    await expect(quoteCreation(ctx)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    const own = [...ctx.store.payments.values()].find((p) => p.id !== 'paid-elsewhere')!;
    expect(own.status).toBe('expired');
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
  });

  it('never leaves a paid quote open for a job paid by its last included modification', async () => {
    const ctx = setup({ included: 1 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const input = { wallet: OWNER_WALLET, jobId: job.id, kind: 'modification' as const };
    const results = await Promise.allSettled([
      ctx.service.createQuote(input),
      ctx.service.createQuote(input),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<QuoteResult>).value.lamports).toBe('0');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'ALREADY_PAID' });
    expect(ctx.store.jobs.get(job.id)!.status).toBe('paid');
    const open = [...ctx.store.payments.values()].filter(
      (p) => p.status === 'quoted' && p.lamports > 0n,
    );
    expect(open).toEqual([]);
  });

  it('repairs a job left in spec_ready behind a confirmed payment', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const row = ctx.store.payments.get(quote.paymentId)!;
    row.status = 'confirmed';
    row.txSignature = randomSignature();
    await expect(quoteCreation(ctx)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
  });
});

describe('confirmPayment', () => {
  it('confirms an exact on-chain payment and moves the job to paid', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    ctx.clock.advance(20_000);
    const signature = pay(ctx, quote, ctx.job.id);

    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toEqual({
      httpStatus: 200,
      status: 'confirmed',
    });
    expect(ctx.store.payments.get(quote.paymentId)).toMatchObject({
      status: 'confirmed',
      txSignature: signature,
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
    expect(ctx.store.transitions).toEqual([{ jobId: ctx.job.id, from: 'spec_ready', to: 'paid' }]);
    expect(ctx.store.events).toEqual([{ jobId: ctx.job.id, message: 'Payment received.' }]);
    expect(ctx.logger.events()).toContain('payment.confirmed');
  });

  it('is idempotent on retries (no second verification, no second transition)', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    await confirm(ctx, quote.paymentId, signature);
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toEqual({
      httpStatus: 200,
      status: 'confirmed',
    });
    expect(ctx.gateway.verifyCalls).toHaveLength(1);
    expect(ctx.store.transitions).toHaveLength(1);
  });

  it('handles two concurrent verifies of the same signature: one write, one transition', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    const results = await Promise.all([
      confirm(ctx, quote.paymentId, signature),
      confirm(ctx, quote.paymentId, signature),
    ]);
    expect(results).toEqual([
      { httpStatus: 200, status: 'confirmed' },
      { httpStatus: 200, status: 'confirmed' },
    ]);
    expect(ctx.gateway.verifyCalls).toHaveLength(2);
    expect(ctx.store.transitions).toHaveLength(1);
    expect(ctx.logger.events().filter((e) => e === 'payment.confirmed')).toHaveLength(1);
  });

  it('rejects a replayed signature on another quote', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    await confirm(ctx, quote.paymentId, signature);

    const lp2 = ctx.store.addLaunchpad({ ownerWallet: OWNER_WALLET });
    const job2 = ctx.store.addJob({ launchpadId: lp2.id, type: 'create_launchpad' });
    const quote2 = await quoteCreation(ctx, job2.id);
    await expect(confirm(ctx, quote2.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'SIGNATURE_ALREADY_USED',
    });
    expect(ctx.gateway.verifyCalls).toHaveLength(1);
    expect(ctx.store.jobs.get(job2.id)!.status).toBe('spec_ready');
  });

  it('lets exactly one of two quotes of the same job claim one signature concurrently', async () => {
    const ctx = setup();
    const q1 = await quoteCreation(ctx);
    // Past the reuse window of q1, so that q2 is a distinct quote (same amount and memo).
    ctx.clock.advance(QUOTE_TIMING.validityMs - QUOTE_TIMING.reuseMinRemainingMs + 1);
    const q2 = await quoteCreation(ctx);
    expect(q2.paymentId).not.toBe(q1.paymentId);
    const signature = pay(ctx, q1, ctx.job.id);
    const results = await Promise.allSettled([
      confirm(ctx, q1.paymentId, signature),
      confirm(ctx, q2.paymentId, signature),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0]!.reason).toMatchObject({ code: 'SIGNATURE_ALREADY_USED' });
    const holders = [...ctx.store.payments.values()].filter((p) => p.txSignature === signature);
    expect(holders).toHaveLength(1);
    expect(ctx.store.transitions).toHaveLength(1);
  });

  it('accepts a single transaction per quote', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    await confirm(ctx, quote.paymentId, pay(ctx, quote, ctx.job.id));
    await expect(confirm(ctx, quote.paymentId, pay(ctx, quote, ctx.job.id))).rejects.toMatchObject({
      httpStatus: 409,
      code: 'PAYMENT_ALREADY_CONFIRMED',
    });
  });

  it('rejects a signature that pays for another job', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const otherJob = '11111111-2222-4333-8444-555555555555';
    const signature = pay(ctx, quote, otherJob);
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 422,
      code: 'PAYMENT_INVALID',
    });
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('quoted');
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('spec_ready');
  });

  it('rejects a payment sent from another wallet', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedPayment({
        payer: OTHER,
        cashbox: CASHBOX,
        lamports: CREATION_LAMPORTS,
        jobId: ctx.job.id,
        blockTime: ctx.clock.seconds(),
      }),
    );
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 403,
      code: 'WRONG_WALLET',
    });
  });

  it('rejects a confirmation from a wallet that is not the payer, before any RPC call', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    await expect(confirm(ctx, quote.paymentId, signature, OTHER.toBase58())).rejects.toMatchObject({
      httpStatus: 403,
      code: 'WRONG_WALLET',
    });
    expect(ctx.gateway.verifyCalls).toHaveLength(0);
  });

  it.each([
    ['underpayment', CREATION_LAMPORTS - 1n],
    ['overpayment', CREATION_LAMPORTS + 1n],
  ])('rejects an %s (the amount must be exact)', async (_label, lamports) => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedPayment({
        payer: OWNER,
        cashbox: CASHBOX,
        lamports,
        jobId: ctx.job.id,
        blockTime: ctx.clock.seconds(),
      }),
    );
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 422,
      code: 'PAYMENT_AMOUNT_MISMATCH',
    });
    expect(ctx.store.payments.get(quote.paymentId)!.txSignature).toBeNull();
    // The SOL reached the cashbox: recorded, with the amount actually paid, for a manual refund.
    expect(ctx.store.anomalies.get(signature)).toMatchObject({
      paymentId: quote.paymentId,
      wallet: OWNER_WALLET,
      lamports,
      reason: 'amount_mismatch',
    });
  });

  it('rejects a transfer to another recipient', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedPayment({
        payer: OWNER,
        cashbox: PublicKey.unique(),
        lamports: CREATION_LAMPORTS,
        jobId: ctx.job.id,
        blockTime: ctx.clock.seconds(),
      }),
    );
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      code: 'PAYMENT_INVALID',
    });
  });

  it('rejects a failed transaction', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedTx({
        feePayer: OWNER,
        transfers: [{ from: OWNER, to: CASHBOX, lamports: CREATION_LAMPORTS }],
        memos: [paymentMemo(ctx.job.id)],
        memoSigners: [OWNER],
        blockTime: ctx.clock.seconds(),
        err: { InstructionError: [0, { Custom: 1 }] },
      }),
    );
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 422,
      code: 'PAYMENT_FAILED',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('spec_ready');
  });

  it('answers pending (202) after waiting while the signature is not visible', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    await expect(confirm(ctx, quote.paymentId, randomSignature())).resolves.toEqual({
      httpStatus: 202,
      status: 'quoted',
    });
    expect(ctx.gateway.verifyCalls.length).toBeGreaterThan(5);
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('quoted');
  });

  it('confirms a transaction that becomes visible during the wait', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.onVerify = (sig, call) => {
      if (call === 3) {
        ctx.gateway.land(
          sig,
          landedPayment({
            payer: OWNER,
            cashbox: CASHBOX,
            lamports: CREATION_LAMPORTS,
            jobId: ctx.job.id,
            blockTime: ctx.clock.seconds(),
          }),
        );
      }
    };
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toMatchObject({
      status: 'confirmed',
    });
  });

  it('expires the quote when the signature never appears', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    ctx.clock.advance(QUOTE_TIMING.validityMs + QUOTE_TIMING.notFoundGraceMs + 1);
    await expect(confirm(ctx, quote.paymentId, randomSignature())).rejects.toMatchObject({
      httpStatus: 410,
      code: 'QUOTE_EXPIRED',
      paymentStatus: 'expired',
    });
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('expired');
  });

  it('keeps a landed but not yet finalized payment pending, even past the grace period', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id, { blockTime: ctx.clock.seconds(100_000) });
    ctx.gateway.notFinal.add(signature);
    ctx.clock.advance(QUOTE_TIMING.validityMs + QUOTE_TIMING.notFoundGraceMs + 1);
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toEqual({
      httpStatus: 202,
      status: 'quoted',
    });
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('quoted');

    // Finalized at the next poll: it landed inside the window, so it pays the job.
    ctx.gateway.notFinal.delete(signature);
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toEqual({
      httpStatus: 200,
      status: 'confirmed',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
  });

  it('accepts a payment that landed in time even when confirmed after the expiry', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id, { blockTime: ctx.clock.seconds(60_000) });
    ctx.store.payments.get(quote.paymentId)!.status = 'expired';
    ctx.clock.advance(10 * 60_000);
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
  });

  it('rejects a payment that landed after the quote expired and flags it', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const late = QUOTE_TIMING.validityMs + QUOTE_TIMING.blockTimeToleranceMs + 1_000;
    const signature = pay(ctx, quote, ctx.job.id, { blockTime: ctx.clock.seconds(late) });
    ctx.clock.advance(late + 5_000);
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      httpStatus: 410,
      code: 'QUOTE_EXPIRED',
    });
    expect(ctx.store.payments.get(quote.paymentId)).toMatchObject({
      status: 'expired',
      txSignature: null,
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('spec_ready');
    expect(ctx.logger.entries.find((e) => e.event === 'confirm.late_payment')?.level).toBe('warn');
    expect(ctx.store.anomalies.get(signature)).toEqual({
      jobId: ctx.job.id,
      paymentId: quote.paymentId,
      wallet: OWNER_WALLET,
      signature,
      lamports: CREATION_LAMPORTS,
      reason: 'late',
      note: null,
    });

    // A retry answers the same and records nothing twice.
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED',
    });
    expect(ctx.store.anomalies.size).toBe(1);
  });

  it('rejects a transaction that predates the quote', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id, { blockTime: ctx.clock.seconds(-120_000) });
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      code: 'PAYMENT_INVALID',
    });
  });

  it('without a block time: accepts before the deadline, stays pending after it', async () => {
    const early = setup();
    const q1 = await quoteCreation(early);
    await expect(
      confirm(early, q1.paymentId, pay(early, q1, early.job.id, { blockTime: null })),
    ).resolves.toMatchObject({ status: 'confirmed' });

    const late = setup();
    const q2 = await quoteCreation(late);
    const signature = pay(late, q2, late.job.id, { blockTime: null });
    late.clock.advance(QUOTE_TIMING.validityMs + QUOTE_TIMING.blockTimeToleranceMs + 1);
    await expect(confirm(late, q2.paymentId, signature)).resolves.toEqual({
      httpStatus: 202,
      status: 'quoted',
    });
  });

  it('surfaces a wrong cluster and records nothing', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    ctx.gateway.failure = new ClusterMismatchError();
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toBeInstanceOf(
      ClusterMismatchError,
    );
    expect(ctx.store.payments.get(quote.paymentId)!.txSignature).toBeNull();
  });

  it('recovers from a crash between recording the payment and moving the job', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    let crashed = false;
    ctx.store.beforeStatement = (name) => {
      if (name === 'transitionJob' && !crashed) {
        crashed = true;
        throw new Error('connection reset');
      }
    };
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toThrow('connection reset');
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('confirmed');
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('spec_ready');

    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
    expect(ctx.store.transitions).toHaveLength(1);
  });

  it('records and flags a second valid payment for an already paid job', async () => {
    const ctx = setup();
    const q1 = await quoteCreation(ctx);
    const s1 = pay(ctx, q1, ctx.job.id);
    // A second quote once the first one is too old to be handed out again.
    ctx.clock.advance(QUOTE_TIMING.validityMs - QUOTE_TIMING.reuseMinRemainingMs + 1);
    const q2 = await quoteCreation(ctx);
    expect(q2.paymentId).not.toBe(q1.paymentId);
    const s2 = pay(ctx, q2, ctx.job.id);
    await confirm(ctx, q1.paymentId, s1);
    expect(ctx.store.anomalies.size).toBe(0);
    await expect(confirm(ctx, q2.paymentId, s2)).resolves.toMatchObject({ status: 'confirmed' });
    expect(ctx.store.payments.get(q2.paymentId)!.txSignature).toBe(s2);
    expect(ctx.store.transitions).toHaveLength(1);
    expect(ctx.logger.entries.find((e) => e.event === 'confirm.duplicate_payment')?.level).toBe(
      'warn',
    );
    expect([...ctx.store.anomalies.values()]).toEqual([
      {
        jobId: ctx.job.id,
        paymentId: q2.paymentId,
        wallet: OWNER_WALLET,
        signature: s2,
        lamports: CREATION_LAMPORTS,
        reason: 'duplicate',
        note: `job already paid by payment ${q1.paymentId}`,
      },
    ]);
    // Retries record nothing twice.
    await confirm(ctx, q2.paymentId, s2);
    await confirm(ctx, q1.paymentId, s1);
    expect(ctx.store.anomalies.size).toBe(1);
  });

  it('never moves a job that is already past paid', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = pay(ctx, quote, ctx.job.id);
    await confirm(ctx, quote.paymentId, signature);
    ctx.store.jobs.get(ctx.job.id)!.status = 'building';
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('building');
    expect(ctx.store.transitions).toHaveLength(1);
  });

  it('confirms an included modification without any on-chain verification', async () => {
    const ctx = setup({ prices: throwingPrices });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const quote = await ctx.service.createQuote({
      wallet: OWNER_WALLET,
      jobId: job.id,
      kind: 'modification',
    });
    await expect(confirm(ctx, quote.paymentId, randomSignature())).resolves.toEqual({
      httpStatus: 200,
      status: 'confirmed',
    });
    expect(ctx.gateway.verifyCalls).toHaveLength(0);
  });

  it('returns 404 for an unknown payment', async () => {
    const ctx = setup();
    await expect(
      confirm(ctx, '00000000-0000-4000-8000-000000000000', randomSignature()),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'NOT_FOUND' });
  });
});

describe('payment anomalies (docs/DECISIONS.md D20)', () => {
  it('records a second transaction paying an already paid quote, then refuses it', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const first = pay(ctx, quote, ctx.job.id);
    const second = pay(ctx, quote, ctx.job.id);
    await confirm(ctx, quote.paymentId, first);
    await expect(confirm(ctx, quote.paymentId, second)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'PAYMENT_ALREADY_CONFIRMED',
    });
    expect(ctx.store.anomalies.get(second)).toEqual({
      jobId: ctx.job.id,
      paymentId: quote.paymentId,
      wallet: OWNER_WALLET,
      signature: second,
      lamports: CREATION_LAMPORTS,
      reason: 'duplicate',
      note: null,
    });
    expect(ctx.store.payments.get(quote.paymentId)!.txSignature).toBe(first);
    await expect(confirm(ctx, quote.paymentId, second)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_CONFIRMED',
    });
    expect(ctx.store.anomalies.size).toBe(1);
  });

  it('keeps answering 202 while that second transaction is seen but not final', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    await confirm(ctx, quote.paymentId, pay(ctx, quote, ctx.job.id));
    const second = pay(ctx, quote, ctx.job.id);
    ctx.gateway.notFinal.add(second);
    await expect(confirm(ctx, quote.paymentId, second)).resolves.toEqual({
      httpStatus: 202,
      status: 'confirmed',
    });
    expect(ctx.store.anomalies.size).toBe(0);
    ctx.gateway.notFinal.delete(second);
    await expect(confirm(ctx, quote.paymentId, second)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_CONFIRMED',
    });
    expect(ctx.store.anomalies.get(second)?.reason).toBe('duplicate');
  });

  it('records nothing for a signature that moved no money of this payer to the cashbox', async () => {
    const cases: [string, (ctx: Ctx) => ReturnType<typeof landedTx>][] = [
      [
        'another payer',
        (ctx) =>
          landedPayment({
            payer: OTHER,
            cashbox: CASHBOX,
            lamports: CREATION_LAMPORTS - 1n,
            jobId: ctx.job.id,
            blockTime: ctx.clock.seconds(),
          }),
      ],
      [
        'another recipient',
        (ctx) =>
          landedPayment({
            payer: OWNER,
            cashbox: PublicKey.unique(),
            lamports: CREATION_LAMPORTS - 1n,
            jobId: ctx.job.id,
            blockTime: ctx.clock.seconds(),
          }),
      ],
      [
        'a failed transaction',
        (ctx) =>
          landedTx({
            feePayer: OWNER,
            transfers: [{ from: OWNER, to: CASHBOX, lamports: CREATION_LAMPORTS - 1n }],
            memos: [paymentMemo(ctx.job.id)],
            memoSigners: [OWNER],
            blockTime: ctx.clock.seconds(),
            err: { InstructionError: [0, { Custom: 1 }] },
          }),
      ],
      [
        'the memo of another job',
        (ctx) =>
          landedPayment({
            payer: OWNER,
            cashbox: CASHBOX,
            lamports: CREATION_LAMPORTS,
            jobId: ctx.job.id,
            memo: paymentMemo('11111111-2222-4333-8444-555555555555'),
            blockTime: ctx.clock.seconds(),
          }),
      ],
    ];
    for (const [label, tx] of cases) {
      const ctx = setup();
      const quote = await quoteCreation(ctx);
      const signature = randomSignature();
      ctx.gateway.land(signature, tx(ctx));
      await expect(confirm(ctx, quote.paymentId, signature), label).rejects.toBeInstanceOf(Error);
      expect(ctx.store.anomalies.size, label).toBe(0);
    }
  });

  it('records nothing for a released draft when the signature never landed', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    ctx.store.launchpads.get(ctx.launchpad.id)!.status = 'disabled';
    await expect(confirm(ctx, quote.paymentId, randomSignature())).rejects.toMatchObject({
      code: 'LAUNCHPAD_DISABLED',
    });
    expect(ctx.store.anomalies.size).toBe(0);
  });

  it('records a wrong amount for a released draft under the released reason', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedPayment({
        payer: OWNER,
        cashbox: CASHBOX,
        lamports: CREATION_LAMPORTS + 5n,
        jobId: ctx.job.id,
        blockTime: ctx.clock.seconds(),
      }),
    );
    ctx.store.launchpads.get(ctx.launchpad.id)!.status = 'disabled';
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      code: 'LAUNCHPAD_DISABLED',
    });
    expect(ctx.store.anomalies.get(signature)).toMatchObject({
      reason: 'launchpad_released',
      lamports: CREATION_LAMPORTS + 5n,
      note: 'amount differs from the quote',
    });
  });

  it('records one duplicate when two quotes of a job are confirmed concurrently', async () => {
    const ctx = setup();
    const q1 = await quoteCreation(ctx);
    ctx.clock.advance(QUOTE_TIMING.validityMs - QUOTE_TIMING.reuseMinRemainingMs + 1);
    const q2 = await quoteCreation(ctx);
    expect(q2.paymentId).not.toBe(q1.paymentId);
    const s1 = pay(ctx, q1, ctx.job.id);
    const s2 = pay(ctx, q2, ctx.job.id);
    await Promise.all([confirm(ctx, q1.paymentId, s1), confirm(ctx, q2.paymentId, s2)]);
    expect(ctx.store.transitions).toHaveLength(1);
    expect([...ctx.store.anomalies.values()].map((a) => [a.paymentId, a.reason])).toEqual([
      [q2.paymentId, 'duplicate'],
    ]);
  });

  it('records a paid quote confirmed for a job paid by an included modification', async () => {
    const ctx = setup({ included: 0 });
    const job = ctx.store.addJob({ launchpadId: ctx.launchpad.id, type: 'modify_launchpad' });
    const quote = await ctx.service.createQuote({
      wallet: OWNER_WALLET,
      jobId: job.id,
      kind: 'modification',
    });
    const signature = pay(ctx, quote, job.id);
    // The job got paid meanwhile through an included modification (0 lamports).
    const included = await ctx.store.insertQuote({
      jobId: job.id,
      payerWallet: OWNER_WALLET,
      kind: 'modification',
      usdAmount: 0,
      lamports: 0n,
      quoteExpiresAt: new Date(T0 + 120_000),
    });
    await ctx.store.confirmIncludedPayment(included.id);
    ctx.store.jobs.get(job.id)!.status = 'paid';
    await expect(confirm(ctx, quote.paymentId, signature)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(ctx.store.anomalies.get(signature)).toMatchObject({
      paymentId: quote.paymentId,
      reason: 'duplicate',
      lamports: 36_666_667n,
      note: `job already paid by payment ${included.id}`,
    });
  });

  it('fails the request when the anomaly cannot be written, and records it on the retry', async () => {
    const ctx = setup();
    const quote = await quoteCreation(ctx);
    const late = QUOTE_TIMING.validityMs + QUOTE_TIMING.blockTimeToleranceMs + 1_000;
    const signature = pay(ctx, quote, ctx.job.id, { blockTime: ctx.clock.seconds(late) });
    ctx.clock.advance(late + 5_000);
    let failures = 1;
    ctx.store.beforeStatement = (name) => {
      if (name === 'recordPaymentAnomaly' && failures-- > 0) throw new Error('connection reset');
    };
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toThrow('connection reset');
    expect(ctx.store.anomalies.size).toBe(0);
    await expect(confirm(ctx, quote.paymentId, signature)).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED',
    });
    expect(ctx.store.anomalies.get(signature)?.reason).toBe('late');
  });
});

describe('receivedLamports', () => {
  const base = { signature: 'sig', slot: 1 } as const;
  it('reads the amount of a mismatched transfer and ignores everything else', () => {
    expect(
      receivedLamports({
        ...base,
        status: 'invalid',
        reason: 'amount_mismatch',
        detail: 'Transfer of 219999999 lamports, expected 220000000',
      }),
    ).toBe(219_999_999n);
    expect(
      receivedLamports({
        ...base,
        status: 'invalid',
        reason: 'amount_mismatch',
        detail: 'The cashbox balance did not grow by the expected amount',
      }),
    ).toBeNull();
    expect(
      receivedLamports({ ...base, status: 'invalid', reason: 'memo_mismatch', detail: 'x' }),
    ).toBeUndefined();
    expect(
      receivedLamports({ status: 'pending', signature: 'sig', reason: 'not_found' }),
    ).toBeUndefined();
  });
});
