import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openKeystore, type Keystore } from '../keystore.js';
import {
  RefundJournalEntry,
  RefundLedgerEntry,
  RefundManualMark,
  createFileRefundLedger,
  createPostgrestRefundStore,
  createRefundLedger,
  createRefundsJob,
  decideRefund,
  refundsConfigFromEnv,
  type RefundCandidate,
  type RefundsDeps,
} from './refunds.js';
import {
  createJobLogger,
  createMemoryJournal,
  Mutex,
  createPostgrestClient,
  silentJobLogger,
  type RetryOptions,
} from './shared.js';
import {
  FakeChain,
  FakeClock,
  FakeDbc,
  MemoryRefundDb,
  RecordingAlerter,
  TransientRpcError,
  chainSleep,
  memoryFlags,
  randomAddress,
  randomSignature,
  uuid,
} from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'refunds job test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const PRICE = 300_000_000n;

let dir: string;
let keystore: Keystore;
let cashbox: PublicKey;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-refunds-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  cashbox = (await keystore.createKey('cashbox')).publicKey;
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(overrides: Partial<RefundsDeps> = {}) {
  const chain = new FakeChain();
  const dbc = new FakeDbc(chain);
  const core = dbc.core({ cashbox });
  const db = new MemoryRefundDb();
  const journal = createMemoryJournal(RefundJournalEntry);
  const ledger = createRefundLedger(createMemoryJournal(RefundLedgerEntry));
  const alerter = new RecordingAlerter();
  const flags = memoryFlags();
  const sleeps: number[] = [];
  const clock = new FakeClock();
  const sleep = chainSleep(chain, sleeps, clock);
  const retry: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, sleep };
  chain.setBalance(cashbox, 5n * SOL);

  const job = (extra: Partial<RefundsDeps> = {}) =>
    createRefundsJob({
      store: db,
      rpc: chain,
      core,
      keystore,
      journal,
      ledger,
      manualMarks: createMemoryJournal(RefundManualMark),
      walletLock: new Mutex(),
      onBeforeSend: () => undefined,
      flags,
      alerter,
      logger: silentJobLogger,
      config: { cashbox, maxRefundLamports: 2n * SOL },
      sleep,
      now: clock.now,
      retry,
      ...overrides,
      ...extra,
    });

  /** A twice-failed build job with one confirmed payment; the payer holds a little SOL. */
  const failedJob = (lamports = PRICE) => {
    const j = db.addJob();
    const p = db.addPayment(j, { lamports });
    chain.setBalance(new PublicKey(j.ownerWallet), 10_000_000n);
    return { job: j, payment: p, payer: new PublicKey(j.ownerWallet) };
  };

  return {
    chain,
    dbc,
    core,
    db,
    journal,
    ledger,
    alerter,
    flags,
    sleeps,
    clock,
    retry,
    job,
    failedJob,
  };
}

describe('refunds: happy path and idempotency', () => {
  it('refunds a twice-failed build once, from the cashbox, to the payer, for the paid amount', async () => {
    const t = setup();
    const { job, payment, payer } = t.failedJob();
    const before = t.chain.balanceOf(cashbox);

    const report = await t.job().runOnce();

    expect(report.status).toBe('ran');
    const refunded = report.outcomes.find((o) => o.result === 'refunded');
    expect(refunded).toMatchObject({ jobId: job.id, paymentId: payment.id, lamports: PRICE });
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.transfers[0]).toMatchObject({ from: cashbox.toBase58(), to: payer.toBase58() });
    expect(t.chain.balanceOf(cashbox)).toBe(before - PRICE - 5_000n);
    const row = t.db.payments.get(payment.id)!;
    expect(row.status).toBe('refunded');
    expect(row.refundSignature).toBe(t.chain.transfers[0]!.signature);
    expect(t.db.jobs.get(job.id)!.status).toBe('refunded');
    expect(t.db.events[0]?.message).toContain('refunded');
    expect(t.alerter.alerts.find((a) => a.code === 'refund_sent')?.level).toBe('normal');
    expect(await t.journal.list()).toHaveLength(0);

    // Second and third runs: nothing left to do, nothing sent.
    const sendsAfterFirst = t.chain.sendAttempts.length;
    await t.job().runOnce();
    await t.job().runOnce();
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.sendAttempts.length).toBe(sendsAfterFirst);
  });

  it('memos the payment id and calls onBeforeSend before the first broadcast', async () => {
    const t = setup();
    const { payment } = t.failedJob();
    const seen: Array<{ signature: string; sentBefore: number }> = [];
    const report = await t
      .job({
        onBeforeSend: (signature) =>
          seen.push({ signature, sentBefore: t.chain.sendAttempts.length }),
      })
      .runOnce();
    const signature = t.chain.transfers[0]!.signature;
    expect(seen).toEqual([{ signature, sentBefore: 0 }]);
    expect(report.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.db.payments.get(payment.id)!.refundSignature).toBe(signature);
  });

  it('does not broadcast when onBeforeSend fails; a later run with a working hook pays once', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    const first = await t
      .job({
        onBeforeSend: () => {
          throw new Error('watcher unavailable');
        },
      })
      .runOnce();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ result: 'in_flight', state: 'not_announced' }),
    );
    expect(t.chain.sendAttempts).toHaveLength(0);
    const recorded = t.db.payments.get(payment.id)!.refundSignature;
    expect(recorded).not.toBeNull();
    const hook = vi.fn();
    await t.job({ onBeforeSend: hook }).runOnce();
    expect(hook).toHaveBeenCalledWith(recorded);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([recorded]));
  });

  it('refunds several jobs in one run, each once', async () => {
    const t = setup();
    const a = t.failedJob(PRICE);
    const b = t.failedJob(55_000_000n);
    await t.job().runOnce();
    expect(t.chain.receivedBy(a.payer)).toBe(PRICE);
    expect(t.chain.receivedBy(b.payer)).toBe(55_000_000n);
    expect(t.chain.transfers).toHaveLength(2);
  });
});

describe('refunds: eligibility (D4 / D18)', () => {
  it('never refunds a failure after approval, a pending retry or a locked job', async () => {
    const t = setup();
    for (const job of [
      t.db.addJob({ failedStage: 'onchain' }),
      t.db.addJob({ failedStage: 'deploy' }),
      t.db.addJob({ attempts: 1 }),
      t.db.addJob({ lockedAt: new Date().toISOString() }),
      t.db.addJob({ status: 'building' }),
    ]) {
      t.db.addPayment(job);
    }
    const report = await t.job().runOnce();
    expect(t.chain.transfers).toHaveLength(0);
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    expect(report.outcomes.every((o) => o.result === 'skipped')).toBe(true);
  });

  it('sends anomalies to manual handling with an alert and no transaction', async () => {
    const t = setup();
    const tooMany = t.db.addJob({ attempts: 3 });
    t.db.addPayment(tooMany);
    const noPayment = t.db.addJob();
    t.db.addPayment(noPayment, { status: 'expired' });
    const twoPayments = t.db.addJob();
    t.db.addPayment(twoPayments);
    t.db.addPayment(twoPayments);
    const zero = t.db.addJob();
    t.db.addPayment(zero, { lamports: 0n });
    const huge = t.db.addJob();
    t.db.addPayment(huge, { lamports: 3n * SOL });
    const unsigned = t.db.addJob();
    t.db.addPayment(unsigned, { txSignature: null });

    const report = await t.job().runOnce();
    const reasons = report.outcomes.filter((o) => o.result === 'manual').map((o) => o.reason);
    expect(reasons.sort()).toEqual(
      [
        'above_refund_cap',
        'attempts_anomaly',
        'missing_payment_signature',
        'multiple_payments',
        'no_paid_payment',
        'zero_amount',
      ].sort(),
    );
    expect(t.chain.transfers).toHaveLength(0);
    expect(t.alerter.codes().filter((c) => c === 'refund_manual')).toHaveLength(6);
  });

  it('jobs left for manual handling never starve newer refunds (paging, maxPerRun)', async () => {
    const t = setup({ config: { cashbox, maxRefundLamports: 2n * SOL, maxPerRun: 1 } });
    for (let i = 0; i < 120; i++) t.db.addPayment(t.db.addJob({ attempts: 3 }));
    const { payer } = t.failedJob();
    const report = await t.job().runOnce();
    expect(report.outcomes.filter((o) => o.result === 'manual')).toHaveLength(120);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('refuses a payer that is not the launchpad owner (wrong payer)', async () => {
    const t = setup();
    const job = t.db.addJob();
    const payment = t.db.addPayment(job, { payerWallet: randomAddress().toBase58() });
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        result: 'manual',
        reason: 'payer_mismatch',
        paymentId: payment.id,
      }),
    );
    expect(t.chain.transfers).toHaveLength(0);
    expect(t.db.payments.get(payment.id)!.refundSignature).toBeNull();
  });

  it('refuses when the on-chain verification disagrees (payer, recipient, amount) or fails', async () => {
    const t = setup();
    const a = t.failedJob();
    const b = t.failedJob();
    const c = t.failedJob();
    const d = t.failedJob();
    const base = {
      status: 'confirmed' as const,
      slot: 1,
      confirmationStatus: 'finalized' as const,
      memo: 'm',
    };
    t.core.verifications.set(a.payment.txSignature!, {
      ...base,
      signature: a.payment.txSignature!,
      payer: randomAddress(),
      recipient: cashbox,
      lamports: PRICE,
    });
    t.core.verifications.set(b.payment.txSignature!, {
      ...base,
      signature: b.payment.txSignature!,
      payer: b.payer,
      recipient: randomAddress(),
      lamports: PRICE,
    });
    t.core.verifications.set(c.payment.txSignature!, {
      ...base,
      signature: c.payment.txSignature!,
      payer: c.payer,
      recipient: cashbox,
      lamports: PRICE + 1n,
    });
    t.core.verifications.set(d.payment.txSignature!, {
      status: 'invalid',
      signature: d.payment.txSignature!,
      reason: 'payer_mismatch',
      detail: 'transfer does not come from the payer',
      slot: 1,
    });
    const report = await t.job().runOnce();
    const manual = report.outcomes.filter((o) => o.result === 'manual').map((o) => o.reason);
    expect(manual.sort()).toEqual(
      ['payment_mismatch', 'payment_mismatch', 'payment_mismatch', 'payment_not_verified'].sort(),
    );
    expect(t.chain.transfers).toHaveLength(0);
  });

  it('waits while the payment is not finalized', async () => {
    const t = setup();
    const { payment } = t.failedJob();
    t.core.verifications.set(payment.txSignature!, {
      status: 'pending',
      signature: payment.txSignature!,
    });
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'skipped', reason: 'payment_not_final' }),
    );
    expect(t.chain.transfers).toHaveLength(0);
  });

  it('skips with an alert when the cashbox cannot cover the refund and its own rent', async () => {
    const t = setup();
    t.failedJob();
    t.chain.setBalance(cashbox, PRICE + t.chain.rentExempt(0)); // fee buffer missing
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'skipped', reason: 'cashbox_insufficient' }),
    );
    expect(t.alerter.codes()).toContain('cashbox_low_balance');
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('uses the lower of the confirmed and finalized cashbox balances', async () => {
    const t = setup();
    t.failedJob();
    t.chain.finalizedBalances.set(cashbox.toBase58(), 1_000_000n);
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'skipped', reason: 'cashbox_insufficient' }),
    );
  });

  it('refuses a refund that would leave a brand-new payer wallet below rent', async () => {
    const t = setup();
    const job = t.db.addJob();
    t.db.addPayment(job, { lamports: 1_000n });
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'manual', reason: 'recipient_not_rent_exempt' }),
    );
  });
});

describe('refunds: kill switches', () => {
  it('does nothing at all when the refunds_paused flag is set', async () => {
    const t = setup();
    t.failedJob();
    t.flags.values.refunds_paused = true;
    const report = await t.job().runOnce();
    expect(report).toEqual({ status: 'paused', reason: 'flag', outcomes: [] });
    expect(t.chain.calls).toHaveLength(0);
    expect(t.db.calls).toHaveLength(0);
  });

  it('fails closed when the flags cannot be read, and honours the env switch', async () => {
    const t = setup();
    t.failedJob();
    t.flags.fail = true;
    expect((await t.job().runOnce()).reason).toBe('flags_unavailable');
    t.flags.fail = false;
    const paused = setup({ config: { cashbox, maxRefundLamports: SOL, paused: true } });
    expect((await paused.job().runOnce()).reason).toBe('config');
    expect(t.chain.calls).toHaveLength(0);
  });
});

describe('refunds: concurrency and crashes', () => {
  it('two processes running at the same time refund once (CAS on refund_signature)', async () => {
    const t = setup();
    const { payer } = t.failedJob();
    const journalB = createMemoryJournal(RefundJournalEntry);
    const [ra, rb] = await Promise.all([t.job().runOnce(), t.job({ journal: journalB }).runOnce()]);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
    const results = [...ra.outcomes, ...rb.outcomes].map((o) => o.result);
    expect(results.filter((r) => r === 'refunded')).toHaveLength(1);
    expect(results).toContain('lost_race');
  });

  it('two processes building the identical transaction still pay once', async () => {
    const t = setup();
    const { payer } = t.failedJob();
    t.chain.fixedBlockhash = new PublicKey(Buffer.alloc(32, 7)).toBase58();
    const journalB = createMemoryJournal(RefundJournalEntry);
    await Promise.all([t.job().runOnce(), t.job({ journal: journalB }).runOnce()]);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('a second runOnce while one is running returns busy', async () => {
    const t = setup();
    t.failedJob();
    const job = t.job();
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'ran']);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('crash between send and record: the next run records it without sending again', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.db.failBefore.set('completeRefund', [new Error('process crashed')]);
    const first = await t.job().runOnce();
    expect(first.outcomes.some((o) => o.result === 'error')).toBe(true);
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.db.payments.get(payment.id)!.status).toBe('confirmed');
    const sends = t.chain.sendAttempts.length;

    const second = await t.job().runOnce(); // new process, same journal
    expect(second.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.sendAttempts.length).toBe(sends);
    expect(t.db.payments.get(payment.id)!.status).toBe('refunded');
  });

  it('crash between send and record with the journal lost: still recorded, never resent', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.db.failBefore.set('completeRefund', [new Error('process crashed')]);
    await t.job().runOnce();
    const sends = t.chain.sendAttempts.length;
    const second = await t.job({ journal: createMemoryJournal(RefundJournalEntry) }).runOnce();
    expect(second.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.sendAttempts.length).toBe(sends);
    expect(t.db.payments.get(payment.id)!.status).toBe('refunded');
  });

  it('send response lost after landing: detected as processed, paid once', async () => {
    const t = setup();
    const { payer } = t.failedJob();
    t.chain.behaviors.push('land_then_network_error');
    const report = await t.job().runOnce();
    expect(report.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('send never reached the network: the next run re-broadcasts the same bytes only', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.chain.failNext('sendRawTransaction', new TransientRpcError(), 4);
    const first = await t.job().runOnce();
    expect(first.outcomes.some((o) => o.result === 'error')).toBe(true);
    const recorded = t.db.payments.get(payment.id)!.refundSignature;
    expect(recorded).not.toBeNull();
    expect(t.chain.transfers).toHaveLength(0);

    const second = await t.job().runOnce();
    expect(second.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([recorded]));
  });

  it('dropped transaction: released only once proven expired, then retried and paid once', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.chain.defaultBehavior = 'drop';
    let heightAtRelease = -1;
    const release = t.db.releaseRefund.bind(t.db);
    t.db.releaseRefund = async (p) => {
      heightAtRelease = t.chain.finalizedHeight;
      return release(p);
    };
    const first = await t.job().runOnce();
    expect(first.outcomes.some((o) => o.result === 'in_flight')).toBe(true);
    t.chain.advance(600); // expiry and finality margins must both be proven by the RPC
    const expired = await t.job().runOnce();
    const released = expired.outcomes.find((o) => o.result === 'released');
    expect(released).toBeDefined();
    const entryHeight = t.chain.blockhashes.values().next().value as number;
    expect(heightAtRelease).toBeGreaterThan(entryHeight);
    expect(t.db.payments.get(payment.id)!.refundSignature).not.toBeNull();
    expect(t.chain.transfers).toHaveLength(0);

    t.chain.defaultBehavior = 'land';
    await t.job().runOnce();
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('a recorded signature without a journal entry waits for the fallback expiry', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    const ghost = randomSignature();
    t.db.payments.get(payment.id)!.refundSignature = ghost;
    const quick = { cashbox, maxRefundLamports: 2n * SOL, settle: { timeoutMs: 10_000 } };
    const first = await t.job({ config: quick }).runOnce();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ result: 'in_flight', signature: ghost }),
    );
    expect(t.db.payments.get(payment.id)!.refundSignature).toBe(ghost);
    expect(t.chain.transfers).toHaveLength(0);

    t.chain.advance(600); // past the expiry and finality margins
    const second = await t.job().runOnce();
    expect(second.outcomes.map((o) => o.result)).toEqual(
      expect.arrayContaining(['released', 'refunded']),
    );
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('beginRefund response lost: nothing sent in that run, the recorded signature is resumed', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.db.failAfter.set('beginRefund', [new Error('connection reset')]);
    const first = await t.job().runOnce();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ result: 'error', error: 'begin_refund_unknown' }),
    );
    expect(t.chain.sendAttempts).toHaveLength(0);
    const recorded = t.db.payments.get(payment.id)!.refundSignature;
    expect(recorded).not.toBeNull();

    await t.job().runOnce();
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([recorded]));
  });

  it('beginRefund failing before the write: the unsent attempt is dropped, then a new one pays', async () => {
    const t = setup();
    const { payer } = t.failedJob();
    t.db.failBefore.set('beginRefund', [new Error('database down')]);
    await t.job().runOnce();
    expect(t.chain.sendAttempts).toHaveLength(0);
    const second = await t.job().runOnce();
    expect(second.outcomes.map((o) => o.result)).toEqual(expect.arrayContaining(['refunded']));
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('an older attempt of ours that landed blocks a different recorded signature', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.db.failBefore.set('completeRefund', [new Error('process crashed')]);
    await t.job().runOnce(); // S landed, recorded, not completed
    t.db.payments.get(payment.id)!.refundSignature = randomSignature(); // tampered / foreign
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'manual', reason: 'refund_record_conflict' }),
    );
    expect(t.alerter.alerts.find((a) => a.code === 'refund_double_risk')?.level).toBe('immediate');
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('a landed refund lost by the database is repaired, never paid twice', async () => {
    const t = setup();
    const { job, payment, payer } = t.failedJob();
    t.db.failBefore.set('completeRefund', [new Error('process crashed')]);
    await t.job().runOnce();
    t.db.payments.get(payment.id)!.refundSignature = null; // someone cleared the column
    const second = await t.job().runOnce();
    expect(second.outcomes.map((o) => o.result)).toContain('repaired');
    expect(t.alerter.codes()).toContain('refund_record_repaired');
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.db.payments.get(payment.id)!.status).toBe('refunded');
    expect(t.db.jobs.get(job.id)!.status).toBe('refunded');
    await t.job().runOnce();
    expect(t.chain.transfers).toHaveLength(1);
  });
});

describe('refunds: on-chain and RPC failures', () => {
  it('an on-chain failure goes to manual handling, without automatic retry', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.chain.behaviors.push('fail_onchain');
    const first = await t.job().runOnce();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ result: 'manual', reason: 'refund_failed_onchain' }),
    );
    expect(t.alerter.alerts.find((a) => a.code === 'refund_failed_onchain')?.level).toBe('high');
    const sends = t.chain.sendAttempts.length;
    await t.job().runOnce();
    await t.job().runOnce();
    expect(t.chain.sendAttempts.length).toBe(sends);
    expect(t.chain.receivedBy(payer)).toBe(0n);

    // The team clears refund_signature to retry: the next run pays once.
    t.db.payments.get(payment.id)!.refundSignature = null;
    await t.job().runOnce();
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('a preflight rejection keeps the signature recorded until it is proven expired', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.chain.behaviors.push('reject');
    const first = await t.job().runOnce();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ result: 'in_flight', state: 'rejected' }),
    );
    expect(t.alerter.codes()).toContain('refund_send_rejected');
    expect(t.db.payments.get(payment.id)!.refundSignature).not.toBeNull();
    t.chain.advance(250);
    await t.job().runOnce();
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('retries transient RPC errors with exponential backoff', async () => {
    const t = setup();
    const { payer } = t.failedJob();
    t.chain.failNext('getMinimumBalanceForRentExemption', new TransientRpcError(), 3);
    const report = await t.job().runOnce();
    expect(report.outcomes.some((o) => o.result === 'refunded')).toBe(true);
    expect(t.sleeps.slice(0, 3)).toEqual([500, 1_000, 2_000]);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('gives up after the retries without any state change, alerts, and succeeds later', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    t.chain.failNext('getLatestBlockhash', new TransientRpcError(), 4);
    const first = await t.job().runOnce();
    expect(first.outcomes).toContainEqual(expect.objectContaining({ result: 'error' }));
    expect(t.alerter.codes()).toContain('refund_error');
    expect(t.db.payments.get(payment.id)!.refundSignature).toBeNull();
    expect(t.chain.transfers).toHaveLength(0);
    await t.job().runOnce();
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('does not retry a non-transient error', async () => {
    const t = setup();
    t.failedJob();
    t.chain.failNext('getMinimumBalanceForRentExemption', new Error('invalid param'), 1);
    await t.job().runOnce();
    expect(t.sleeps).not.toContain(500);
  });

  it('a database outage stops the run with an alert', async () => {
    const t = setup();
    t.db.failBefore.set('listInFlightRefunds', [new Error('db down')]);
    const report = await t.job().runOnce();
    expect(report.status).toBe('error');
    expect(t.alerter.codes()).toContain('refunds_run_failed');
  });
});

describe('refunds: signing safety', () => {
  it('refuses a transfer from core that does not match the refund, before signing', async () => {
    const t = setup();
    const { payment } = t.failedJob();
    const attacker = randomAddress();
    const signSpy = vi.spyOn(keystore, 'withSigner');
    t.core.buildSolTransferTx = (p) =>
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: p.from, toPubkey: attacker, lamports: p.lamports }),
      );
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(expect.objectContaining({ result: 'error' }));
    expect(t.alerter.codes()).toContain('refund_policy_violation');
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    expect(t.db.payments.get(payment.id)!.refundSignature).toBeNull();
  });

  it('refuses to run when the keystore cashbox is not FORGE_CASHBOX_WALLET', async () => {
    const t = setup({ config: { cashbox: randomAddress(), maxRefundLamports: SOL } });
    t.failedJob();
    const report = await t.job().runOnce();
    expect(report).toMatchObject({ status: 'error', reason: 'cashbox_key' });
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('never logs or alerts an RPC URL key, a passphrase or key bytes', async () => {
    const lines: string[] = [];
    const stream = { write: (s: string) => void lines.push(s) };
    const logger = createJobLogger(pino({ level: 'debug' }, stream), 'refunds');
    const t = setup({ logger });
    t.failedJob();
    t.chain.failNext(
      'getLatestBlockhash',
      new Error('400 Bad Request from https://devnet.helius-rpc.com/?api-key=SUPERSECRET123'),
      1,
    );
    await t.job().runOnce();
    const output = lines.join('\n') + JSON.stringify(t.alerter.alerts);
    expect(output).not.toContain('SUPERSECRET123');
    expect(output).not.toContain('helius-rpc.com');
    expect(output).not.toContain(PASSPHRASE);
    const keyFile = (await fs.readdir(dir)).find((f) => f.endsWith('.json'))!;
    const envelope = JSON.parse(await fs.readFile(path.join(dir, keyFile), 'utf8')) as {
      ciphertext?: string;
    };
    if (envelope.ciphertext) expect(output).not.toContain(envelope.ciphertext);
  });
});

describe('refunds: never twice, whatever the database says', () => {
  /** Puts the rows back as if the refund had never happened (a service-key rewrite). */
  const rewrite = (t: ReturnType<typeof setup>, jobId: string, paymentId: string) => {
    const row = t.db.payments.get(paymentId)!;
    row.status = 'confirmed';
    row.refundSignature = null;
    t.db.jobs.get(jobId)!.status = 'failed';
  };

  it('refuses a payment the ledger knows as refunded once the rows are rewritten (alert high, nothing sent)', async () => {
    const t = setup();
    // The manual marks persist across restarts (file journal): shared by every run here.
    const manualMarks = createMemoryJournal(RefundManualMark);
    const { job, payment, payer } = t.failedJob();
    await t.job({ manualMarks }).runOnce();
    expect(t.chain.transfers).toHaveLength(1);
    rewrite(t, job.id, payment.id);
    const sends = t.chain.sendAttempts.length;

    const report = await t.job({ manualMarks }).runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        result: 'manual',
        reason: 'refund_already_sent',
        paymentId: payment.id,
      }),
    );
    const blocked = t.alerter.alerts.find((a) => a.code === 'refund_ledger_blocked');
    expect(blocked?.level).toBe('high');
    expect(blocked?.details).toMatchObject({ paymentId: payment.id, ledgerState: 'landed' });
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.sendAttempts.length).toBe(sends);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.db.payments.get(payment.id)!.refundSignature).toBeNull(); // nothing recorded either
    // Every later run: still refused, nothing sent, alerted once (remembered per job and reason).
    await t.job({ manualMarks }).runOnce();
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.alerter.codes().filter((c) => c === 'refund_ledger_blocked')).toHaveLength(1);
  });

  it('finds a refunded payment by its transaction signature when its row is re-created under another id', async () => {
    const t = setup();
    const { job, payment } = t.failedJob();
    await t.job().runOnce();
    t.db.payments.delete(payment.id);
    t.db.jobs.delete(job.id);
    const again = t.db.addJob({ ownerWallet: job.ownerWallet });
    const copy = t.db.addPayment(again, { txSignature: payment.txSignature });
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        result: 'manual',
        reason: 'refund_already_sent',
        paymentId: copy.id,
      }),
    );
    expect(t.alerter.codes()).toContain('refund_ledger_blocked');
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('settles a broadcast attempt the journal lost before deciding: landed means refused', async () => {
    const t = setup();
    const { job, payment, payer } = t.failedJob();
    const ids = { paymentId: payment.id, paymentSignature: payment.txSignature! };
    // The refund lands, then the settlement poll breaks before anything else is recorded.
    t.chain.failNext('getSignatureState', new Error('rpc exploded'), 1);
    const first = await t.job().runOnce();
    expect(first.outcomes.some((o) => o.result === 'error')).toBe(true);
    expect(t.chain.transfers).toHaveLength(1);
    expect(await t.ledger.find(ids)).toMatchObject([{ state: 'sent' }]);

    rewrite(t, job.id, payment.id);
    t.chain.advance(40);
    const report = await t.job({ journal: createMemoryJournal(RefundJournalEntry) }).runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'manual', reason: 'refund_already_sent' }),
    );
    expect(await t.ledger.find(ids)).toMatchObject([{ state: 'landed' }]);
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
  });

  it('refuses when the cashbox history already carries the refund memo, with every local file lost', async () => {
    const t = setup();
    const { job, payment, payer } = t.failedJob();
    await t.job().runOnce();
    rewrite(t, job.id, payment.id);
    const fresh = t.job({
      journal: createMemoryJournal(RefundJournalEntry),
      ledger: createRefundLedger(createMemoryJournal(RefundLedgerEntry)),
      manualMarks: createMemoryJournal(RefundManualMark),
    });
    const report = await fresh.runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        result: 'manual',
        reason: 'refund_onchain_found',
        paymentId: payment.id,
      }),
    );
    const duplicate = t.alerter.alerts.find((a) => a.code === 'refund_onchain_duplicate');
    expect(duplicate?.level).toBe('high');
    expect(duplicate?.details).toMatchObject({ signature: t.chain.transfers[0]!.signature });
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    expect(t.chain.calls.filter((c) => c === 'sendRawTransaction')).toHaveLength(1);
  });

  it('an attempt proven expired does not block the refund: the ledger keeps both attempts', async () => {
    const t = setup();
    const { payment, payer } = t.failedJob();
    const ids = { paymentId: payment.id, paymentSignature: payment.txSignature! };
    t.chain.defaultBehavior = 'drop';
    await t.job().runOnce(); // S recorded and sent, dropped by the network
    expect(await t.ledger.find(ids)).toMatchObject([{ state: 'sent' }]);
    t.chain.defaultBehavior = 'land';
    for (let run = 0; run < 4 && t.chain.transfers.length === 0; run++) {
      t.chain.advance(200);
      await t.job().runOnce();
    }
    expect(t.chain.transfers).toHaveLength(1);
    expect(t.chain.receivedBy(payer)).toBe(PRICE);
    const attempts = (await t.ledger.find(ids)).map((a) => a.state).sort();
    expect(attempts).toEqual(['expired', 'landed']);
    expect(t.db.payments.get(payment.id)!.status).toBe('refunded');
  });

  it('leaves a confirmed payment below the floor of its kind to manual handling', async () => {
    const t = setup({
      config: {
        cashbox,
        maxRefundLamports: 2n * SOL,
        minPaymentLamports: { creation: 100_000_000n, modification: 10_000_000n },
      },
    });
    const low = t.db.addJob();
    const payment = t.db.addPayment(low, { lamports: 99_999_999n });
    const fine = t.failedJob();
    const report = await t.job().runOnce();
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ result: 'manual', reason: 'below_minimum', paymentId: payment.id }),
    );
    expect(t.chain.receivedBy(fine.payer)).toBe(PRICE);
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('the file ledger keeps every attempt for good: never deleted, never moved back', async () => {
    const ledgerDir = path.join(dir, 'ledger');
    const ledger = createFileRefundLedger(ledgerDir);
    const paymentId = uuid();
    const paymentSignature = randomSignature();
    const refundSignature = randomSignature();
    const base = {
      paymentId,
      jobId: uuid(),
      paymentSignature,
      refundSignature,
      lamports: PRICE,
      recipient: randomAddress().toBase58(),
      lastValidBlockHeight: 1_150,
      at: '2026-10-16T00:00:00.000Z',
    };
    await ledger.record({ ...base, state: 'sent' });
    await ledger.record({ ...base, state: 'landed', at: '2026-10-16T00:01:00.000Z' });
    await ledger.record({ ...base, state: 'expired', at: '2026-10-16T00:02:00.000Z' }); // never back
    const second = randomSignature();
    await ledger.record({ ...base, refundSignature: second, state: 'expired' });

    const byId = await ledger.find({ paymentId, paymentSignature: randomSignature() });
    const bySignature = await ledger.find({ paymentId: uuid(), paymentSignature });
    for (const attempts of [byId, bySignature]) {
      expect(attempts.map((a) => [a.refundSignature, a.state])).toEqual([
        [refundSignature, 'landed'],
        [second, 'expired'],
      ]);
    }
    const files = (await fs.readdir(ledgerDir)).filter((f) => f.startsWith('refund-ledger.'));
    expect(files.sort()).toEqual([
      `refund-ledger.p-${paymentId}.json`,
      `refund-ledger.s-${paymentSignature}.json`,
    ]);
    // A restart reads the same record.
    expect(
      await createFileRefundLedger(ledgerDir).find({ paymentId, paymentSignature }),
    ).toHaveLength(2);
  });

  it('requires the ledger', () => {
    const t = setup();
    expect(() => t.job({ ledger: undefined as unknown as RefundsDeps['ledger'] })).toThrow(
      /ledger is required/,
    );
  });
});

describe('decideRefund', () => {
  const owner = randomAddress().toBase58();
  const jobId = uuid();
  const candidate = (
    over: Partial<RefundCandidate['job']> = {},
    payments?: RefundCandidate['payments'],
  ): RefundCandidate => ({
    job: {
      id: jobId,
      launchpadId: uuid(),
      type: 'modify_launchpad',
      status: 'failed',
      attempts: 2,
      failedStage: 'build',
      lockedAt: null,
      ownerWallet: owner,
      ...over,
    },
    payments: payments ?? [
      {
        id: uuid(),
        jobId,
        payerWallet: owner,
        kind: 'modification',
        lamports: 50_000_000n,
        txSignature: randomSignature(),
        status: 'confirmed',
        refundSignature: null,
      },
    ],
  });
  const opts = { maxAttempts: 2, maxRefundLamports: SOL };

  it('leaves a payment below the floor of its kind to manual handling', () => {
    const atFloor = { ...opts, minPaymentLamports: { creation: 1n, modification: 50_000_000n } };
    expect(decideRefund(candidate(), atFloor).action).toBe('refund');
    const above = { ...opts, minPaymentLamports: { creation: 1n, modification: 50_000_001n } };
    expect(decideRefund(candidate(), above)).toMatchObject({
      action: 'manual',
      reason: 'below_minimum',
    });
  });

  it('refunds exactly at the threshold and the cap', () => {
    expect(decideRefund(candidate(), opts).action).toBe('refund');
    const atCap = candidate();
    atCap.payments[0]!.lamports = SOL;
    expect(decideRefund(atCap, opts).action).toBe('refund');
    atCap.payments[0]!.lamports = SOL + 1n;
    expect(decideRefund(atCap, opts)).toMatchObject({
      action: 'manual',
      reason: 'above_refund_cap',
    });
  });

  it('ignores quoted and expired payments and finalizes an already refunded one', () => {
    const c = candidate();
    const p = c.payments[0]!;
    c.payments.push(
      { ...p, id: uuid(), status: 'expired' },
      { ...p, id: uuid(), status: 'quoted' },
    );
    expect(decideRefund(c, opts).action).toBe('refund');
    p.status = 'refunded';
    p.refundSignature = randomSignature();
    expect(decideRefund(c, opts).action).toBe('finalize_job');
    p.refundSignature = null;
    expect(decideRefund(c, opts)).toMatchObject({ reason: 'refunded_without_signature' });
  });

  it('leaves in-flight refunds to the recovery pass and rejects invalid payers', () => {
    const c = candidate();
    c.payments[0]!.refundSignature = randomSignature();
    expect(decideRefund(c, opts)).toEqual({ action: 'skip', reason: 'in_flight' });
    const bad = candidate();
    bad.payments[0]!.payerWallet = 'not-an-address';
    expect(decideRefund(bad, opts)).toMatchObject({ action: 'manual', reason: 'invalid_payer' });
  });
});

describe('refundsConfigFromEnv', () => {
  it('parses strictly with safe defaults', () => {
    const c = refundsConfigFromEnv({}, cashbox);
    expect(c.config.maxRefundLamports).toBe(2n * SOL);
    expect(c.config.paused).toBe(false);
    expect(c.intervalMs).toBe(5 * 60_000);
    // $33 and $5.5 at the web's highest quotable SOL price ($5 000), with a 10% margin.
    expect(c.config.minPaymentLamports).toEqual({
      creation: 5_940_000n,
      modification: 990_000n,
    });
    expect(
      refundsConfigFromEnv({ SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS: '7' }, cashbox).config
        .minPaymentLamports,
    ).toEqual({ creation: 5_940_000n, modification: 7n });
    expect(() =>
      refundsConfigFromEnv({ SIGNER_MIN_CREATION_PAYMENT_LAMPORTS: '0.5' }, cashbox),
    ).toThrow(/SIGNER_MIN_CREATION_PAYMENT_LAMPORTS/);
    expect(
      refundsConfigFromEnv(
        { SIGNER_REFUNDS_MAX_LAMPORTS: '500000000', SIGNER_REFUNDS_PAUSED: 'true' },
        cashbox,
      ).config,
    ).toMatchObject({ maxRefundLamports: 500_000_000n, paused: true });
    expect(() => refundsConfigFromEnv({ SIGNER_REFUNDS_MAX_LAMPORTS: '0.5' }, cashbox)).toThrow();
    expect(() => refundsConfigFromEnv({ SIGNER_REFUNDS_PAUSED: 'yes' }, cashbox)).toThrow();
  });
});

describe('PostgREST refund store', () => {
  const KEY = 'service-role-key-for-tests-0123456789';

  function fakeDb(responses: Array<{ status?: number; body: unknown }>) {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      });
      const next = responses.shift() ?? { body: [] };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }) as unknown as typeof fetch;
    const client = createPostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: KEY,
      fetch: fetchImpl,
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined },
    });
    return { store: createPostgrestRefundStore(client), requests };
  }

  const paymentRow = (over: Record<string, unknown> = {}) => ({
    id: uuid(),
    job_id: uuid(),
    payer_wallet: randomAddress().toBase58(),
    kind: 'creation',
    lamports: '300000000',
    tx_signature: randomSignature(),
    status: 'confirmed',
    refund_signature: null,
    ...over,
  });

  it('records the refund signature with a compare-and-set PATCH', async () => {
    const row = paymentRow();
    const sig = randomSignature();
    const { store, requests } = fakeDb([{ body: [{ ...row, refund_signature: sig }] }]);
    const ok = await store.beginRefund({
      paymentId: row.id,
      txSignature: row.tx_signature,
      refundSignature: sig,
    });
    expect(ok).toBe(true);
    const req = requests[0]!;
    expect(req.method).toBe('PATCH');
    const url = new URL(req.url);
    expect(url.pathname).toBe('/rest/v1/payments');
    expect(url.searchParams.get('id')).toBe(`eq.${row.id}`);
    expect(url.searchParams.get('status')).toBe('eq.confirmed');
    expect(url.searchParams.get('refund_signature')).toBe('is.null');
    expect(url.searchParams.get('tx_signature')).toBe(`eq.${row.tx_signature}`);
    expect(JSON.parse(req.body!)).toEqual({ refund_signature: sig });
    expect(req.headers.prefer).toBe('return=representation');
    expect(req.headers.apikey).toBe(KEY);
    expect(req.url).not.toContain(KEY);
  });

  it('re-reads after a 0-row update (lost response) instead of guessing', async () => {
    const row = paymentRow();
    const sig = randomSignature();
    const won = fakeDb([{ body: [] }, { body: [{ ...row, refund_signature: sig }] }]);
    expect(
      await won.store.beginRefund({
        paymentId: row.id,
        txSignature: row.tx_signature,
        refundSignature: sig,
      }),
    ).toBe(true);
    const lost = fakeDb([
      { body: [] },
      { body: [{ ...row, refund_signature: randomSignature() }] },
    ]);
    expect(
      await lost.store.beginRefund({
        paymentId: row.id,
        txSignature: row.tx_signature,
        refundSignature: sig,
      }),
    ).toBe(false);
  });

  it('parses candidates with embedded payments and bigint-safe lamports', async () => {
    const owner = randomAddress().toBase58();
    const jobRow = {
      id: uuid(),
      launchpad_id: uuid(),
      type: 'create_launchpad',
      status: 'failed',
      attempts: 2,
      failed_stage: 'build',
      locked_at: null,
      launchpads: { owner_wallet: owner },
      payments: [paymentRow({ lamports: '18446744073709551615' })],
    };
    const { store, requests } = fakeDb([{ body: [jobRow] }]);
    const [c] = await store.listRefundCandidates(10, 0);
    expect(c!.job.ownerWallet).toBe(owner);
    expect(c!.payments[0]!.lamports).toBe(18446744073709551615n);
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('select')).toContain('lamports::text');
    expect(url.searchParams.get('failed_stage')).toBe('eq.build');
    expect(url.searchParams.get('attempts')).toBe('gte.2');
  });

  it('retries 5xx, never puts the key in an error, and rejects malformed rows', async () => {
    const { store } = fakeDb([
      { status: 503, body: { code: 'PGRST000' } },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    const err = await store.listInFlightRefunds(5, 0).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 503');
    expect((err as Error).message).not.toContain(KEY);
    const bad = fakeDb([{ body: [{ id: 1 }] }]);
    await expect(bad.store.listInFlightRefunds(5, 0)).rejects.toThrow(/unexpected/);
  });

  it('refuses unsafe filter values', async () => {
    const { store } = fakeDb([]);
    await expect(store.getPayment('x&status=eq.refunded')).rejects.toThrow(/unsafe/);
  });
});
