import { describe, expect, it, vi } from 'vitest';
import { creatorRole } from '../keystore.js';
import {
  METADATA,
  dbcAccounts,
  ok,
  refused,
  setup,
  useTestKeystore,
  type Harness,
} from './harness.js';
import { randomKey, randomSignature } from './testing.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

// ---------------------------------------------------------------------------------------
// Creation payment proven on-chain before any payer spend

describe('creation payment verified on-chain', () => {
  it('spends nothing until the payment is finalized on-chain, then journals the proof', async () => {
    const h = await setup(ks.keystore);
    const payment = h.store.payments[0]!;
    h.chain.payments.get(payment.txSignature!)!.finalized = false;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'payment_not_final',
    });
    expect(h.chain.built.config).toBe(0);
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();
    expect(h.alerter.codes()).toEqual([]); // retryable: no alert

    h.chain.payments.get(payment.txSignature!)!.finalized = true;
    ok(await h.routes.configs({ jobId: h.jobId }));
    expect(await h.journals.payments.get(payment.id)).toMatchObject({
      jobId: h.jobId,
      signature: payment.txSignature,
      payer: h.owner.publicKey.toBase58(),
      recipient: h.chain.cashbox.toBase58(),
      lamports: '300000000',
      memo: `forge:job:${h.jobId}`,
    });
    // The journaled proof is reused: no second on-chain verification.
    const verifications = () => h.chain.calls.filter((c) => c === 'verifyPayment').length;
    const before = verifications();
    ok(await h.routes.configs({ jobId: h.jobId }));
    ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
    expect(verifications()).toBe(before);
  });

  const mismatches: Array<[string, (h: Harness, signature: string) => void]> = [
    ['a failed transaction', (h, sig) => void (h.chain.payments.get(sig)!.failed = true)],
    ['another amount', (h, sig) => void (h.chain.payments.get(sig)!.lamports = 1_000n)],
    ['another recipient', (h, sig) => void (h.chain.payments.get(sig)!.recipient = randomKey())],
    ['another payer', (h, sig) => void (h.chain.payments.get(sig)!.payer = randomKey())],
    ['the memo of another job', (h, sig) => void (h.chain.payments.get(sig)!.memo = 'forge:job:x')],
  ];
  for (const [name, mutate] of mismatches) {
    it(`refuses ${name}, before any key or spend, with an alert`, async () => {
      const h = await setup(ks.keystore);
      const payment = h.store.payments[0]!;
      mutate(h, payment.txSignature!);
      expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
        status: 409,
        error: 'payment_not_verified',
      });
      expect(h.alerter.codes()).toContain('payment_not_verified');
      expect(h.chain.built.config).toBe(0);
      expect(h.chain.sendAttempts).toHaveLength(0);
      expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();
      expect(await h.journals.payments.get(payment.id)).toBeUndefined();
    });
  }

  it('refuses a payment row below the floor of its kind or not at the shared price, before any key, proof or spend', async () => {
    const h = await setup(ks.keystore);
    const payment = h.store.payments[0]!;
    payment.lamports = 5_939_999n; // one lamport under the default creation floor (0.00594 SOL)
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_below_minimum',
    });
    const low = h.alerter.alerts.find((a) => a.code === 'payment_below_minimum');
    expect(low?.level).toBe('high');
    expect(low?.details).toMatchObject({ paymentId: payment.id, kind: 'creation' });
    expect(h.chain.calls).not.toContain('verifyPayment');
    expect(h.chain.built.config).toBe(0);
    expect(h.chain.sendAttempts).toHaveLength(0);
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();

    payment.lamports = 300_000_000n;
    payment.usdAmount = 1;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_price_mismatch',
    });
    expect(
      h.alerter.alerts.find((a) => a.code === 'payment_price_mismatch')?.details,
    ).toMatchObject({ paymentId: payment.id, expected: 33 });
    expect(h.chain.calls).not.toContain('verifyPayment');
    expect(h.chain.built.config).toBe(0);

    payment.usdAmount = 33;
    ok(await h.routes.configs({ jobId: h.jobId }));
    // The same checks guard the launch preparation.
    payment.usdAmount = 5.5;
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_price_mismatch',
    });
    expect(h.chain.built.nonce).toBe(0);
  });

  it('takes the floors from the configuration', async () => {
    const h = await setup(ks.keystore, {
      config: {
        metadataUriTemplate: METADATA,
        minPaymentLamports: { creation: 300_000_001n, modification: 0n },
      },
    });
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_below_minimum',
    });
    const exact = h.restart({
      config: {
        metadataUriTemplate: METADATA,
        minPaymentLamports: { creation: 300_000_000n, modification: 0n },
      },
    });
    ok(await exact.configs({ jobId: h.jobId }));
  });

  it('waits (503) for a payment transaction the chain does not know', async () => {
    const h = await setup(ks.keystore);
    h.chain.payments.clear();
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'payment_not_final',
    });
    expect(h.chain.built.config).toBe(0);
  });

  it('refuses a job whose payment has a refund signature, whatever its status', async () => {
    const h = await setup(ks.keystore);
    h.store.payments[0]!.refundSignature = randomSignature();
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_refunded',
    });
    expect(h.chain.calls).not.toContain('verifyPayment');
    expect(h.chain.built.config).toBe(0);
    // Also once the configs exist: no launch is prepared for a refunded job.
    h.store.payments[0]!.refundSignature = null;
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.store.payments.push({
      ...h.store.payments[0]!,
      id: 'other-payment',
      kind: 'modification',
      status: 'quoted',
      refundSignature: randomSignature(),
    });
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_refunded',
    });
    expect(h.chain.built.nonce).toBe(0);
  });

  it('refuses a confirmed payment row without a transaction signature', async () => {
    const h = await setup(ks.keystore);
    h.store.payments[0]!.txSignature = null;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_signature_missing',
    });
    expect(h.chain.calls).not.toContain('verifyPayment');
  });

  it('refuses a payment row that changed after its verification', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    const payment = h.store.payments[0]!;
    const other = randomSignature();
    h.chain.recordPayment(other, {
      payer: h.owner.publicKey,
      lamports: payment.lamports,
      jobId: h.jobId,
    });
    payment.txSignature = other;
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_record_changed',
    });
    expect(h.alerter.codes()).toContain('payment_record_changed');
    expect(h.chain.built.nonce).toBe(0);
  });

  it('verifies the payment before prepare too', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    const payment = h.store.payments[0]!;
    await h.journals.payments.delete(payment.id);
    h.chain.payments.get(payment.txSignature!)!.failed = true;
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'payment_not_verified',
    });
    expect(h.chain.built.nonce).toBe(0);
    expect(h.chain.built.launch).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Daily cap of the new launchpads the routes create accounts for

describe('daily cap of new launchpads', () => {
  it('fails closed with an alert past the cap, never recounts an admitted launchpad', async () => {
    const h = await setup(ks.keystore);
    let t = Date.UTC(2026, 9, 11, 10);
    const capped = () =>
      h.restart({ config: { ...h.deps.config, maxLaunchpadsPerDay: 2 }, now: () => t });
    const routes = capped();
    const second = h.addJob();
    const third = h.addJob();
    ok(await routes.configs({ jobId: h.jobId }));
    ok(await routes.configs({ jobId: second.jobId }));
    expect(refused(await routes.configs({ jobId: third.jobId }))).toEqual({
      status: 503,
      error: 'launchpad_daily_cap',
    });
    expect(h.alerter.codes()).toContain('launchpad_daily_cap');
    expect(await ks.keystore.findRef(creatorRole(third.launchpadId))).toBeUndefined();
    expect(h.chain.built.config).toBe(4);

    // Admitted launchpads go through, also after a restart, and so does their launch.
    ok(await routes.configs({ jobId: h.jobId }));
    const restarted = capped();
    ok(await restarted.launchCoinPrepare({ jobId: second.jobId }));
    expect(refused(await restarted.configs({ jobId: third.jobId })).error).toBe(
      'launchpad_daily_cap',
    );
    expect(await h.journals.admissions.get('2026-10-11')).toMatchObject({
      launchpads: [h.launchpadId, second.launchpadId],
    });

    // The next UTC day has its own budget.
    t = Date.UTC(2026, 9, 12, 0, 1);
    ok(await restarted.configs({ jobId: third.jobId }));
    expect(dbcAccounts(h)).toHaveLength(6);
  });

  it('refuses an invalid cap at startup', async () => {
    const h = await setup(ks.keystore);
    for (const maxLaunchpadsPerDay of [0, -1, 1.5, 1_001]) {
      expect(() => h.restart({ config: { ...h.deps.config, maxLaunchpadsPerDay } })).toThrow(
        /maxLaunchpadsPerDay/,
      );
    }
  });
});
