import { PRICING, type PaymentKind, type PaymentStatus } from '@forge/shared';
import { PublicKey } from '@solana/web3.js';
import type { ExpectedPayment, PaymentVerification } from './core-adapter';
import { PaymentError } from './errors';
import type { PaymentGateway } from './gateway';
import { errorName, type PaymentsLogger } from './log';
import { kindForJobType, usdPriceForKind, usdToLamports } from './pricing';
import type { SolUsdPriceSource } from './price-source';
import { defaultSleep } from './retry';
import type { JobContext, PaymentAnomalyReason, PaymentRecord, PaymentsStore } from './store';

/*
 * Quotes and on-chain payment confirmation (docs/INTERFACES.md §6, docs/SECURITY.md §10).
 *
 * Guarantees:
 * - amounts are computed here from PRICING and the current SOL/USD rate, never taken from the
 *   client; a quote is bound to the job, the payer wallet (= session wallet = launchpad owner),
 *   the exact amount, an expiry, and the memo `forge:job:<jobId>`;
 * - a transaction signature is recorded at most once (UNIQUE `payments.tx_signature`) and a quote
 *   accepts a single signature (conditional update on `tx_signature is null`);
 * - the job moves spec_ready -> paid with a conditional update, so retries and concurrent
 *   requests are idempotent. The payment row is written first: it is the source of truth, and a
 *   later confirm or quote request repairs a job left behind by a crash between the two writes;
 * - money that reached the cashbox without paying for its job (late, wrong amount, released
 *   draft, second payment of a paid job) is recorded in `payment_anomalies` for a manual refund
 *   (docs/DECISIONS.md D20) before the request is answered, idempotently on the signature. Only a
 *   transaction verified on-chain is recorded: landed without error, signed by the payer, with
 *   exactly one transfer from the payer to the cashbox.
 */

export const QUOTE_TIMING = {
  validityMs: PRICING.quoteValiditySeconds * 1000,
  /** Allowed gap between a block time estimate and our clock, on both ends of the window. */
  blockTimeToleranceMs: 30_000,
  /**
   * Past expiry + this delay, a signature still unknown to the cluster can no longer become a
   * valid payment (it would land after the window), so the quote is marked expired.
   */
  notFoundGraceMs: 90_000,
} as const;

/** The confirm route waits this long for a transaction that is not yet confirmed. */
export const CONFIRM_WAIT = { totalMs: 10_000, pollMs: 1_000 } as const;

export interface QuoteResult {
  paymentId: string;
  kind: PaymentKind;
  /** Decimal string. */
  lamports: string;
  usdAmount: number;
  expiresAt: string;
  /** Unsigned payment transaction (base64), null when nothing has to be paid. */
  transaction: string | null;
}

export interface ConfirmResult {
  /** 200 when final, 202 while the transaction is not yet confirmed. */
  httpStatus: 200 | 202;
  status: PaymentStatus;
}

export interface PaymentsServiceDeps {
  store: PaymentsStore;
  gateway: PaymentGateway;
  prices: SolUsdPriceSource;
  logger: PaymentsLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  confirmWaitMs?: number;
  confirmPollMs?: number;
}

export interface PaymentsService {
  createQuote(input: { wallet: string; jobId: string; kind: PaymentKind }): Promise<QuoteResult>;
  confirmPayment(input: {
    wallet: string;
    paymentId: string;
    signature: string;
  }): Promise<ConfirmResult>;
}

const CAS_ATTEMPTS = 5;

const WRONG_WALLET_MESSAGE = 'This action must be signed with the wallet that owns the launchpad.';
const ALREADY_PAID_MESSAGE = 'This job has already been paid.';
const SIGNATURE_USED_MESSAGE = 'This transaction was already used for another payment.';
const OTHER_SIGNATURE_MESSAGE = 'This quote has already been paid with another transaction.';
const LAUNCHPAD_DISABLED_MESSAGE = 'This launchpad has been disabled.';

function notFound(what: 'Job' | 'Payment'): PaymentError {
  return new PaymentError(404, 'NOT_FOUND', `${what} not found.`);
}

type PendingVerification = Extract<PaymentVerification, { status: 'pending' }>;
type MissingMetaVerification = Extract<PaymentVerification, { status: 'invalid' }> & {
  reason: 'missing_meta';
};

/** Not decided yet: poll again (a transaction without its status meta is treated the same). */
function isPending(
  verification: PaymentVerification,
): verification is PendingVerification | MissingMetaVerification {
  return (
    verification.status === 'pending' ||
    (verification.status === 'invalid' && verification.reason === 'missing_meta')
  );
}

/** The cluster does not know the signature at all (as opposed to seen but not final yet). */
function isUnseen(verification: PaymentVerification): boolean {
  return verification.status === 'pending' && verification.reason === 'not_found';
}

/** `Transfer of <n> lamports, expected <m>`: the detail of the core's amount_mismatch result. */
const TRANSFER_DETAIL_RE = /^Transfer of (\d{1,20}) lamports\b/;

/**
 * Lamports a verified transaction moved from the payer to the cashbox:
 * - `undefined` when there is nothing to record (not landed, failed, not signed by the payer, no
 *   single transfer from the payer to the cashbox, or not decided yet);
 * - `null` when money moved (the core reports amount_mismatch only after those checks) but the
 *   amount is not readable from the result.
 */
export function receivedLamports(verification: PaymentVerification): bigint | null | undefined {
  if (verification.status === 'confirmed') return verification.lamports;
  if (verification.status !== 'invalid' || verification.reason !== 'amount_mismatch') {
    return undefined;
  }
  const match = TRANSFER_DETAIL_RE.exec(verification.detail);
  if (!match) return null;
  const lamports = BigInt(match[1]!);
  return lamports > 0n ? lamports : undefined;
}

export function createPaymentsService(deps: PaymentsServiceDeps): PaymentsService {
  const { store, gateway, prices, logger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const confirmWaitMs = deps.confirmWaitMs ?? CONFIRM_WAIT.totalMs;
  const confirmPollMs = deps.confirmPollMs ?? CONFIRM_WAIT.pollMs;

  /** Session wallet = launchpads.owner_wallet = spec.ownerWallet (docs/SECURITY.md §10). */
  function assertOwner(ctx: JobContext, wallet: string): void {
    const { launchpad } = ctx;
    if (launchpad.specOwnerWallet !== launchpad.ownerWallet) {
      logger.log('error', 'launchpad.owner_mismatch', { launchpadId: launchpad.id });
      throw new PaymentError(403, 'WRONG_WALLET', WRONG_WALLET_MESSAGE);
    }
    if (launchpad.ownerWallet !== wallet) {
      throw new PaymentError(403, 'WRONG_WALLET', WRONG_WALLET_MESSAGE);
    }
  }

  async function jobEvent(jobId: string, message: string): Promise<void> {
    try {
      await store.addJobEvent(jobId, message);
    } catch (error) {
      logger.log('warn', 'job_event.failed', { jobId, error: errorName(error) });
    }
  }

  /** spec_ready -> paid, idempotent: a job already past spec_ready is left untouched. */
  async function markJobPaid(jobId: string, reason: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await store.transitionJob(jobId, 'spec_ready', 'paid')) {
        logger.log('info', 'job.paid', { jobId, reason });
        await jobEvent(jobId, 'Payment received.');
        return;
      }
      const ctx = await store.getJobContext(jobId);
      if (!ctx) throw notFound('Job');
      if (ctx.job.status !== 'spec_ready') return;
    }
    throw new Error('job transition to paid did not apply');
  }

  // -------------------------------------------------------------------------------------------
  // Quotes
  // -------------------------------------------------------------------------------------------

  async function createQuote(input: {
    wallet: string;
    jobId: string;
    kind: PaymentKind;
  }): Promise<QuoteResult> {
    const { wallet, jobId, kind } = input;
    const ctx = await store.getJobContext(jobId);
    if (!ctx) throw notFound('Job');
    assertOwner(ctx, wallet);
    if (kindForJobType(ctx.job.type) !== kind) {
      throw new PaymentError(400, 'KIND_MISMATCH', 'This quote kind does not match the job.');
    }
    if (ctx.launchpad.status === 'disabled') {
      throw new PaymentError(403, 'LAUNCHPAD_DISABLED', LAUNCHPAD_DISABLED_MESSAGE);
    }
    // Every status after spec_ready implies the job was paid.
    if (ctx.job.status !== 'spec_ready') {
      throw new PaymentError(409, 'ALREADY_PAID', ALREADY_PAID_MESSAGE);
    }
    // Self-repair: a confirmed payment whose job did not move (crash between the two writes).
    if (await store.findConfirmedPaymentForJob(jobId)) {
      await markJobPaid(jobId, 'reconcile_on_quote');
      throw new PaymentError(409, 'ALREADY_PAID', ALREADY_PAID_MESSAGE);
    }
    if (kind === 'creation' && (await store.getFlag('signups_paused'))) {
      throw new PaymentError(503, 'SIGNUPS_PAUSED', 'New signups are temporarily paused.');
    }
    if (kind === 'modification' && ctx.launchpad.includedModificationsLeft > 0) {
      const included = await useIncludedModification(ctx, wallet);
      if (included) return included;
      // The last included modification was taken concurrently: this one is paid.
    }
    return createPaidQuote(ctx, wallet, kind);
  }

  async function createPaidQuote(
    ctx: JobContext,
    wallet: string,
    kind: PaymentKind,
  ): Promise<QuoteResult> {
    const usdAmount = usdPriceForKind(kind);
    const solUsd = await prices.getSolUsdPrice();
    const lamports = usdToLamports(usdAmount, solUsd);
    // Built before the quote row so that the blockhash is never older than the quote window.
    const built = await gateway.buildPayment({
      payer: new PublicKey(wallet),
      lamports,
      jobId: ctx.job.id,
    });
    const payment = await store.insertQuote({
      jobId: ctx.job.id,
      payerWallet: wallet,
      kind,
      usdAmount,
      lamports,
      quoteExpiresAt: new Date(now() + QUOTE_TIMING.validityMs),
    });
    // An expired unpaid draft can be released (disabled, slug freed) by a confirmation of another
    // wallet (chat/store.ts). The release writes the launchpad then reads the payments; a quote
    // writes its row then reads the launchpad: whatever the interleaving, one of the two sees the
    // other and backs off, so a quote is never handed out for a released draft.
    const fresh = await store.getJobContext(ctx.job.id);
    if (!fresh || fresh.launchpad.status === 'disabled') {
      await store.markPaymentExpired(payment.id);
      throw new PaymentError(403, 'LAUNCHPAD_DISABLED', LAUNCHPAD_DISABLED_MESSAGE);
    }
    logger.log('info', 'quote.created', {
      paymentId: payment.id,
      jobId: ctx.job.id,
      kind,
      lamports: lamports.toString(),
      usdAmount,
    });
    return {
      paymentId: payment.id,
      kind,
      lamports: lamports.toString(),
      usdAmount,
      expiresAt: new Date(payment.quoteExpiresAt).toISOString(),
      transaction: built.transaction,
    };
  }

  /** Compare-and-set decrement; false when none is left. */
  async function consumeIncludedModification(launchpadId: string): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const left = await store.getIncludedModificationsLeft(launchpadId);
      if (left === null || left <= 0) return false;
      if (await store.setIncludedModificationsLeft(launchpadId, left, left - 1)) return true;
    }
    throw new Error('included modifications counter under contention');
  }

  async function restoreIncludedModification(launchpadId: string): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS * 2; attempt++) {
      const left = await store.getIncludedModificationsLeft(launchpadId);
      if (left === null) break;
      if (await store.setIncludedModificationsLeft(launchpadId, left, left + 1)) return;
    }
    logger.log('error', 'included.restore_failed', { launchpadId });
  }

  /**
   * Included modification: ledger row first (0 lamports), then the counter (compare-and-set),
   * then the job (conditional). Losing the job race gives the modification back. This order never
   * lets a job become paid without consuming an included modification.
   */
  async function useIncludedModification(
    ctx: JobContext,
    wallet: string,
  ): Promise<QuoteResult | null> {
    const jobId = ctx.job.id;
    const payment = await store.insertQuote({
      jobId,
      payerWallet: wallet,
      kind: 'modification',
      usdAmount: 0,
      lamports: 0n,
      quoteExpiresAt: new Date(now() + QUOTE_TIMING.validityMs),
    });
    if (!(await consumeIncludedModification(ctx.launchpad.id))) {
      await store.markPaymentExpired(payment.id);
      return null;
    }
    if (!(await store.transitionJob(jobId, 'spec_ready', 'paid'))) {
      await restoreIncludedModification(ctx.launchpad.id);
      await store.markPaymentExpired(payment.id);
      throw new PaymentError(409, 'ALREADY_PAID', ALREADY_PAID_MESSAGE);
    }
    if (!(await store.confirmIncludedPayment(payment.id))) {
      logger.log('error', 'included.confirm_failed', { paymentId: payment.id, jobId });
    }
    logger.log('info', 'job.paid', { jobId, reason: 'included_modification' });
    await jobEvent(jobId, 'Included modification used: no payment needed.');
    return {
      paymentId: payment.id,
      kind: 'modification',
      lamports: '0',
      usdAmount: 0,
      expiresAt: new Date(payment.quoteExpiresAt).toISOString(),
      transaction: null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------------------------

  async function verifyWithWait(
    signature: string,
    expected: ExpectedPayment,
  ): Promise<PaymentVerification> {
    const deadline = now() + confirmWaitMs;
    for (;;) {
      const result = await gateway.verify(signature, expected);
      if (!isPending(result) || now() + confirmPollMs > deadline) return result;
      await sleep(confirmPollMs);
    }
  }

  function expectedFor(payment: PaymentRecord): ExpectedPayment {
    return {
      payer: new PublicKey(payment.payerWallet),
      lamports: payment.lamports,
      jobId: payment.jobId,
    };
  }

  /**
   * Records money received for `payment` that cannot pay for its job (idempotent on the
   * signature). A database failure propagates: the request fails and its retry records it.
   */
  async function recordAnomaly(
    payment: PaymentRecord,
    signature: string,
    reason: PaymentAnomalyReason,
    lamports: bigint | null,
    note: string | null = null,
  ): Promise<void> {
    const outcome = await store.recordPaymentAnomaly({
      jobId: payment.jobId,
      paymentId: payment.id,
      wallet: payment.payerWallet,
      signature,
      lamports,
      reason,
      note,
    });
    logger.log('warn', 'payment.anomaly', {
      paymentId: payment.id,
      jobId: payment.jobId,
      signature,
      reason,
      lamports: lamports === null ? null : lamports.toString(),
      outcome,
    });
  }

  /**
   * Second payment of a job: every confirmed payment of the job except the one that paid it is
   * recorded as a duplicate. Run after each signature write, so of two payments confirmed
   * concurrently the later reader sees both and records the extra one. The included modification
   * (0 lamports) paid the job when there is one, otherwise the oldest payment did.
   */
  async function recordDuplicates(jobId: string): Promise<void> {
    const confirmed = await store.listConfirmedPaymentsForJob(jobId);
    if (confirmed.length < 2) return;
    const primary = confirmed.find((p) => p.lamports === 0n) ?? confirmed[0]!;
    for (const extra of confirmed) {
      if (extra.id === primary.id || extra.txSignature === null || extra.lamports === 0n) continue;
      await recordAnomaly(
        extra,
        extra.txSignature,
        'duplicate',
        extra.lamports,
        `job already paid by payment ${primary.id}`,
      );
    }
  }

  /**
   * A signature presented for a quote that can no longer accept it (released draft, quote already
   * paid by another transaction). It is verified like a payment of that quote and, when it moved
   * money to the cashbox, recorded before `refusal` is thrown. While the transaction is seen but
   * not final the answer is 202, so the client keeps confirming until it can be recorded.
   */
  async function refuseStray(
    payment: PaymentRecord,
    signature: string,
    reason: PaymentAnomalyReason,
    refusal: PaymentError,
  ): Promise<ConfirmResult> {
    // A signature already held by a payment brought no new money.
    if (!(await store.findPaymentBySignature(signature))) {
      const verification = await verifyWithWait(signature, expectedFor(payment));
      if (isPending(verification) && !isUnseen(verification)) {
        return { httpStatus: 202, status: payment.status };
      }
      const received = receivedLamports(verification);
      if (received !== undefined) {
        const note = verification.status === 'invalid' ? 'amount differs from the quote' : null;
        await recordAnomaly(payment, signature, reason, received, note);
      }
    }
    throw refusal;
  }

  function reject(payment: PaymentRecord, signature: string, reason: string): never {
    logger.log('warn', 'confirm.rejected', {
      paymentId: payment.id,
      jobId: payment.jobId,
      signature,
      reason,
    });
    switch (reason) {
      case 'transaction_failed':
        throw new PaymentError(422, 'PAYMENT_FAILED', 'The transaction failed on-chain.');
      case 'payer_not_signer':
      case 'payer_mismatch':
        throw new PaymentError(403, 'WRONG_WALLET', 'This payment was not sent from your wallet.');
      case 'memo_missing':
      case 'memo_mismatch':
        throw new PaymentError(
          422,
          'PAYMENT_INVALID',
          'This transaction does not pay for this job.',
        );
      case 'recipient_mismatch':
      case 'multiple_transfers':
        throw new PaymentError(422, 'PAYMENT_INVALID', 'This transaction is not a FORGE payment.');
      case 'amount_mismatch':
        throw new PaymentError(
          422,
          'PAYMENT_AMOUNT_MISMATCH',
          'The amount paid does not match the quote.',
        );
      case 'malformed_signature':
        throw new PaymentError(400, 'BAD_REQUEST', 'Invalid transaction signature.');
      case 'before_quote':
        throw new PaymentError(422, 'PAYMENT_INVALID', 'This transaction predates this quote.');
      default:
        throw new PaymentError(422, 'PAYMENT_INVALID', 'This transaction is not a valid payment.');
    }
  }

  async function expire(payment: PaymentRecord, event: string, signature: string): Promise<never> {
    await store.markPaymentExpired(payment.id);
    logger.log(event === 'confirm.late_payment' ? 'warn' : 'info', event, {
      paymentId: payment.id,
      jobId: payment.jobId,
      signature,
    });
    throw new PaymentError(
      410,
      'QUOTE_EXPIRED',
      'This quote has expired. Please request a new one.',
      'expired',
    );
  }

  async function confirmPayment(input: {
    wallet: string;
    paymentId: string;
    signature: string;
  }): Promise<ConfirmResult> {
    const { wallet, paymentId, signature } = input;
    const payment = await store.getPayment(paymentId);
    if (!payment) throw notFound('Payment');
    const ctx = await store.getJobContext(payment.jobId);
    if (!ctx) throw notFound('Job');
    assertOwner(ctx, wallet);
    if (payment.payerWallet !== wallet) {
      throw new PaymentError(403, 'WRONG_WALLET', WRONG_WALLET_MESSAGE);
    }
    if (payment.kind !== kindForJobType(ctx.job.type)) {
      throw new PaymentError(409, 'KIND_MISMATCH', 'This quote does not match the job.');
    }

    // Included modification: nothing to verify on-chain.
    if (payment.lamports === 0n) return { httpStatus: 200, status: payment.status };

    // A creation draft released after expiry (its slug went to another wallet) can no longer be
    // paid. Only reachable for a quote that was never confirmed within an hour of its expiry (the
    // release requires that); money that reached the cashbox anyway is recorded for a refund.
    if (
      payment.kind === 'creation' &&
      payment.txSignature === null &&
      ctx.launchpad.status === 'disabled'
    ) {
      logger.log('warn', 'confirm.launchpad_disabled', {
        paymentId,
        jobId: payment.jobId,
        signature,
      });
      return refuseStray(
        payment,
        signature,
        'launchpad_released',
        new PaymentError(403, 'LAUNCHPAD_DISABLED', LAUNCHPAD_DISABLED_MESSAGE),
      );
    }

    // Already recorded: idempotent retry (which also repairs the job) or another signature, which
    // is a second payment of this quote when it moved money (two tabs paying one quote).
    if (payment.txSignature !== null) {
      if (payment.txSignature !== signature) {
        return refuseStray(
          payment,
          signature,
          'duplicate',
          new PaymentError(409, 'PAYMENT_ALREADY_CONFIRMED', OTHER_SIGNATURE_MESSAGE),
        );
      }
      if (payment.status === 'confirmed') {
        await recordDuplicates(payment.jobId);
        await markJobPaid(payment.jobId, 'confirm_retry');
      }
      return { httpStatus: 200, status: payment.status };
    }
    if (payment.status !== 'quoted' && payment.status !== 'expired') {
      return { httpStatus: 200, status: payment.status };
    }

    // Fast path; the UNIQUE constraint below is the actual guard against replays.
    const holder = await store.findPaymentBySignature(signature);
    if (holder && holder.id !== payment.id) {
      throw new PaymentError(409, 'SIGNATURE_ALREADY_USED', SIGNATURE_USED_MESSAGE);
    }

    const verification = await verifyWithWait(signature, expectedFor(payment));

    if (isPending(verification)) {
      if (now() > payment.quoteExpiresAt + QUOTE_TIMING.notFoundGraceMs) {
        return expire(payment, 'confirm.expired_unseen', signature);
      }
      return { httpStatus: 202, status: payment.status };
    }
    if (verification.status === 'invalid') {
      if (verification.reason === 'amount_mismatch') {
        // The payer's transfer reached the cashbox with another amount: refunded by hand.
        const received = receivedLamports(verification);
        if (received !== undefined) {
          await recordAnomaly(payment, signature, 'amount_mismatch', received);
        }
      }
      reject(payment, signature, verification.reason);
    }

    // Defense in depth: the core already requires the exact amount.
    if (verification.lamports !== payment.lamports) {
      await recordAnomaly(payment, signature, 'amount_mismatch', verification.lamports);
      reject(payment, signature, 'amount_mismatch');
    }

    // The transaction must have landed inside the quote window.
    const windowStart =
      payment.quoteExpiresAt - QUOTE_TIMING.validityMs - QUOTE_TIMING.blockTimeToleranceMs;
    const windowEnd = payment.quoteExpiresAt + QUOTE_TIMING.blockTimeToleranceMs;
    if (verification.blockTime === null) {
      // Without a block time, "confirmed by now" only proves the deadline while now <= windowEnd.
      if (now() > windowEnd) return { httpStatus: 202, status: payment.status };
    } else {
      const landedAt = verification.blockTime * 1000;
      if (landedAt > windowEnd) {
        // The money arrived but this quote no longer accepts it: recorded for a manual refund.
        await recordAnomaly(payment, signature, 'late', verification.lamports);
        return expire(payment, 'confirm.late_payment', signature);
      }
      if (landedAt < windowStart) reject(payment, signature, 'before_quote');
    }

    const other = await store.findConfirmedPaymentForJob(payment.jobId);
    if (other && other.id !== payment.id) {
      // Second valid payment for the same job: recorded (the money was received) and flagged.
      logger.log('warn', 'confirm.duplicate_payment', {
        paymentId,
        otherPaymentId: other.id,
        jobId: payment.jobId,
        signature,
      });
    }

    const write = await store.confirmPayment(payment.id, signature);
    if (write === 'signature_taken') {
      throw new PaymentError(409, 'SIGNATURE_ALREADY_USED', SIGNATURE_USED_MESSAGE);
    }
    if (write === 'not_updated') {
      const fresh = await store.getPayment(payment.id);
      if (!fresh) throw notFound('Payment');
      if (fresh.txSignature !== signature) {
        if (fresh.txSignature !== null) {
          // Another transaction paid this quote meanwhile: this verified one is a second payment.
          await recordAnomaly(fresh, signature, 'duplicate', verification.lamports);
          throw new PaymentError(409, 'PAYMENT_ALREADY_CONFIRMED', OTHER_SIGNATURE_MESSAGE);
        }
        return { httpStatus: 200, status: fresh.status };
      }
      // A concurrent request recorded the same signature first: same outcome.
      if (fresh.status !== 'confirmed') return { httpStatus: 200, status: fresh.status };
    } else {
      logger.log('info', 'payment.confirmed', {
        paymentId,
        jobId: payment.jobId,
        signature,
        lamports: payment.lamports.toString(),
        slot: verification.slot,
        commitment: verification.confirmationStatus,
      });
    }

    await recordDuplicates(payment.jobId);
    await markJobPaid(payment.jobId, 'payment_confirmed');
    return { httpStatus: 200, status: 'confirmed' };
  }

  return { createQuote, confirmPayment };
}
