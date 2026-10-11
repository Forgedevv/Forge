/**
 * The creation payment, proven on-chain before the payer wallet spends anything for a job
 * (docs/SECURITY.md §10: the signer never trusts the `payments` row alone).
 *
 * For every `confirmed` creation payment of the job, `assertCreationPaid` requires:
 * - a `tx_signature` on the row (checked with the other row checks, context.ts);
 * - core `verifyPayment` at FINALIZED commitment on SOLANA_CLUSTER (core-adapter.ts): exactly
 *   `lamports` from `payer_wallet` (the launchpad owner) to FORGE_CASHBOX_WALLET, with the memo
 *   `forge:job:<jobId>`, in a successful transaction signed by the payer;
 * - the verified result matching the row field by field (belt and braces).
 * The verified result is journaled (`route-payment.<paymentId>`): later calls reuse it without an
 * RPC round trip, as long as the row still says the same thing. A row that changed after its
 * verification is refused and alerted (manual check). A payment not finalized yet is a retryable
 * 503; an invalid one a 409, alerted.
 */
import { PublicKey } from '@solana/web3.js';
import { paymentMemo } from '@forge/core';
import type { ExpectedPayment, PaymentVerification } from '../core-adapter.js';
import { withRetry } from '../jobs/shared.js';
import type { OnchainSetup, RouteRuntime } from './context.js';
import { fail } from './errors.js';
import type { VerifiedPaymentEntry } from './journal.js';
import type { RoutePayment } from './store.js';

/** On-chain proof of a client payment (`SignerCore.verifyPayment` in production). */
export interface RoutePaymentVerifier {
  /** FORGE_CASHBOX_WALLET: the only valid recipient of a creation payment. */
  readonly cashbox: PublicKey;
  /** core `verifyPayment` at FINALIZED commitment, on the configured cluster. */
  verifyPayment(signature: string, expected: ExpectedPayment): Promise<PaymentVerification>;
}

function entryMatches(entry: VerifiedPaymentEntry, jobId: string, payment: RoutePayment): boolean {
  return (
    entry.paymentId === payment.id &&
    entry.jobId === jobId &&
    entry.signature === payment.txSignature &&
    entry.payer === payment.payerWallet &&
    entry.lamports === payment.lamports.toString()
  );
}

async function verifyOne(rt: RouteRuntime, jobId: string, payment: RoutePayment): Promise<void> {
  const signature = payment.txSignature;
  if (!signature) fail(409, 'payment_signature_missing');
  const details = { jobId, paymentId: payment.id, signature };

  const journaled = await rt.journals.payments.get(payment.id);
  if (journaled) {
    if (entryMatches(journaled, jobId, payment)) return;
    await rt.alert(
      'high',
      'payment_record_changed',
      'A payment row changed after the signer verified it on-chain: manual check needed',
      details,
      `payment_record_changed:${payment.id}`,
    );
    fail(409, 'payment_record_changed');
  }

  const payer = new PublicKey(payment.payerWallet);
  const verified = await withRetry(
    () => rt.payments.verifyPayment(signature, { payer, lamports: payment.lamports, jobId }),
    rt.retry,
  );
  if (verified.status === 'pending') {
    rt.log.info(details, 'creation payment not finalized yet');
    fail(503, 'payment_not_final');
  }
  const refuse = async (reason: string, detail: string): Promise<never> => {
    await rt.alert(
      'high',
      'payment_not_verified',
      'A job marked as paid has no matching payment on-chain: nothing was signed, manual check needed',
      { ...details, reason, detail },
      `payment_not_verified:${payment.id}`,
    );
    fail(409, 'payment_not_verified');
  };
  if (verified.status === 'invalid') return refuse(verified.reason, verified.detail);
  if (
    verified.signature !== signature ||
    verified.confirmationStatus !== 'finalized' ||
    !verified.payer.equals(payer) ||
    !verified.recipient.equals(rt.payments.cashbox) ||
    verified.lamports !== payment.lamports ||
    verified.memo !== paymentMemo(jobId)
  ) {
    return refuse('result_mismatch', 'the verified transaction does not match the payment row');
  }

  const entry: VerifiedPaymentEntry = {
    v: 1,
    paymentId: payment.id,
    jobId,
    signature,
    payer: payment.payerWallet,
    recipient: verified.recipient.toBase58(),
    lamports: payment.lamports.toString(),
    memo: verified.memo,
    slot: verified.slot,
    verifiedAt: new Date(rt.now()).toISOString(),
  };
  await rt.journals.payments.put(payment.id, entry);
  rt.log.info({ ...details, slot: verified.slot }, 'creation payment verified on-chain');
}

/**
 * Proves every confirmed creation payment of the job on-chain (finalized), or throws a
 * RouteError. Called inside the launchpad lock, before any key is created or any payer spend.
 */
export async function assertCreationPaid(rt: RouteRuntime, setup: OnchainSetup): Promise<void> {
  for (const payment of setup.payments) await verifyOne(rt, setup.job.id, payment);
}
