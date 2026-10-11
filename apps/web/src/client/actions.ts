import {
  ClaimTransactionResponse,
  ClientError,
  JobApproveResponse,
  LaunchpadModificationRequest,
  LaunchpadModificationResponse,
  OwnerTransactionGetResponse,
  PaymentsQuoteRequest,
  PaymentsQuoteResponse,
  SpecConfirmRequest,
  SpecConfirmResponse,
  WEB_API_ROUTES,
  type ClaimTransactionSummary,
  type LaunchpadSpec,
  type OnTxPhase,
  type PaymentKind,
  type Quote,
  type TxPhase,
  type TxResult,
} from '@forge/shared';
import type { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import { bytesToBase64 } from './base58';
import { defaultMessage, errorMessage, isUserRejection } from './errors';
import { request, route, validateBody } from './http';
import {
  getKeptLaunch,
  isAlreadySigned,
  keepLaunch,
  submitKeptLaunch,
  type KeptLaunch,
} from './launches';
import {
  PAYMENT_MESSAGES,
  clearSentPayment,
  confirmSentPayment,
  getSentPayment,
  saveSentPayment,
  type ConfirmOutcome,
} from './payments';
import {
  deserializeTransaction,
  feePayerSignature,
  isNodeAnswer,
  isPreflightRejection,
  preflightMessage,
  requireSessionWallet,
  safeReporter,
  sendAndConfirm,
} from './tx';
import {
  assertSignedByWallet,
  assertSignedCopy,
  configuredCashbox,
  verifyLaunchTransaction,
  verifyPartnerClaimTransaction,
  verifyPaymentTransaction,
} from './verify';
import type {
  ClaimOptions,
  ClaimResult,
  LaunchReview,
  PaymentResult,
  PendingPayment,
} from './types';
import { getWalletBridge } from './wallet-bridge';

/**
 * Quotes by payment id (the shared `Quote` type carries neither the job nor the transaction).
 * `transaction` is dropped once sent: the same quote can then only be re-confirmed.
 */
const quotedPayments = new Map<string, { jobId: string; transaction: string | null }>();

/** Thrown by `getQuote` while a payment sent for the job is unresolved. */
export class PaymentPendingError extends ClientError {
  readonly signature: string;

  constructor(signature: string) {
    super('NETWORK', PAYMENT_MESSAGES.pending);
    this.name = 'PaymentPendingError';
    this.signature = signature;
  }
}

export async function confirmSpec(
  conversationId: string,
  spec: LaunchpadSpec,
): Promise<{ launchpadId: string; jobId: string }> {
  const body = validateBody(SpecConfirmRequest, { conversationId, spec });
  return request(WEB_API_ROUTES.specConfirm.path, SpecConfirmResponse, { method: 'POST', body });
}

export async function requestModification(
  launchpadId: string,
  conversationId: string,
  requestText: string,
): Promise<{ jobId: string }> {
  const body = validateBody(LaunchpadModificationRequest, {
    conversationId,
    request: requestText,
  });
  return request(
    route(WEB_API_ROUTES.launchpadModifications.path, { id: launchpadId }),
    LaunchpadModificationResponse,
    { method: 'POST', body },
  );
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export async function getQuote(jobId: string, kind: PaymentKind): Promise<Quote> {
  // Never quote again while a payment sent for this job is unresolved.
  const sent = getSentPayment(jobId);
  if (sent) throw new PaymentPendingError(sent.signature);
  const body = validateBody(PaymentsQuoteRequest, { jobId, kind });
  const res = await request(WEB_API_ROUTES.paymentsQuote.path, PaymentsQuoteResponse, {
    method: 'POST',
    body,
  });
  const { transaction, ...quote } = res;
  if (transaction) quotedPayments.set(quote.paymentId, { jobId, transaction });
  else quotedPayments.delete(quote.paymentId);
  return quote;
}

/** The payment already sent for this job and not settled yet, if any. */
export function getPendingPayment(jobId: string): PendingPayment | null {
  return getSentPayment(jobId);
}

/** Records the outcome of a confirmation and maps it to the result shown by the screen. */
function settle(
  record: PendingPayment,
  outcome: ConfirmOutcome,
  report: (phase: TxPhase) => void,
): PaymentResult {
  const { signature, jobId } = record;
  switch (outcome.kind) {
    case 'confirmed':
      clearSentPayment(jobId);
      report('confirmed');
      return { phase: 'confirmed', signature, outcome: 'confirmed' };
    case 'confirming':
      saveSentPayment({ ...record, outcome: 'confirming', message: null });
      report('error');
      return { phase: 'error', signature, outcome: 'confirming', error: outcome.message };
    case 'late':
      saveSentPayment({ ...record, outcome: 'late', message: PAYMENT_MESSAGES.late });
      report('error');
      return { phase: 'error', signature, outcome: 'late', error: PAYMENT_MESSAGES.late };
    case 'rejected':
      saveSentPayment({ ...record, outcome: 'rejected', message: outcome.message });
      report('error');
      return { phase: 'error', signature, outcome: 'rejected', error: outcome.message };
    case 'failed':
      clearSentPayment(jobId);
      report('error');
      return { phase: 'error', signature, outcome: 'failed', error: outcome.message };
  }
}

/**
 * Re-confirms the payment already sent for `jobId`, with its original signature. Never signs or
 * sends a new payment. Resolves `phase: 'idle'` when nothing was sent for this job.
 */
export async function resumePayment(jobId: string, onPhase: OnTxPhase): Promise<PaymentResult> {
  const report = safeReporter(onPhase);
  const record = getSentPayment(jobId);
  if (!record) return { phase: 'idle' };
  if (record.outcome !== 'confirming') {
    report('error');
    return {
      phase: 'error',
      signature: record.signature,
      outcome: record.outcome,
      error: record.message ?? PAYMENT_MESSAGES.rejected,
    };
  }
  report('sending');
  return settle(record, await confirmSentPayment(record), report);
}

/**
 * Signs and sends the quoted payment, then confirms it with the server. Once the transaction is
 * sent, the signature is saved and every later failure resolves with it (never throws), so the
 * screen can re-confirm it instead of offering a second payment.
 */
export async function payQuote(quote: Quote, onPhase: OnTxPhase): Promise<PaymentResult> {
  const report = safeReporter(onPhase);
  // Nothing to pay: an included modification remains and the job already moved to `paid`.
  if (quote.lamports === '0') {
    report('confirmed');
    return { phase: 'confirmed' };
  }
  const quoted = quotedPayments.get(quote.paymentId);
  // A payment already went out for this job: confirm that one, never a second one.
  if (quoted && getSentPayment(quoted.jobId)) return resumePayment(quoted.jobId, onPhase);
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    report('error');
    throw new ClientError('QUOTE_EXPIRED', defaultMessage('QUOTE_EXPIRED'));
  }
  if (!quoted?.transaction) {
    report('error');
    throw new ClientError('QUOTE_EXPIRED', 'This quote is no longer available. Request a new one.');
  }
  const { jobId, transaction } = quoted;

  let signed: VersionedTransaction;
  try {
    const { signTransaction, address } = requireSessionWallet();
    const tx = deserializeTransaction(transaction);
    // Exactly the quoted transfer to FORGE plus this job's memo, paid by the session wallet.
    const check = (t: VersionedTransaction) =>
      verifyPaymentTransaction(t, {
        wallet: address,
        lamports: BigInt(quote.lamports),
        jobId,
        cashbox: configuredCashbox(),
      });
    check(tx);
    report('awaiting_signature');
    try {
      signed = await signTransaction(tx);
    } catch (err) {
      if (isUserRejection(err)) {
        report('rejected');
        return { phase: 'rejected' };
      }
      throw err;
    }
    assertSignedCopy(signed, address, check);
  } catch (err) {
    report('error');
    if (err instanceof ClientError) throw err;
    return { phase: 'error', error: errorMessage(err) };
  }

  const signature = feePayerSignature(signed);
  const { connection } = getWalletBridge();
  if (!signature || !connection) {
    report('error');
    return {
      phase: 'error',
      error: signature ? defaultMessage('NETWORK') : 'The wallet did not sign the payment.',
    };
  }
  report('sending');
  const bytes = signed.serialize();
  let delivered = true;
  try {
    await connection.sendRawTransaction(bytes);
  } catch (err) {
    if (isPreflightRejection(err)) {
      // Refused before broadcast: nothing left the wallet and this quote can be retried.
      report('error');
      return { phase: 'error', error: preflightMessage(err) };
    }
    // It may have gone out anyway: treat it as sent and keep re-broadcasting the same bytes.
    delivered = false;
  }
  const record: PendingPayment = {
    jobId,
    paymentId: quote.paymentId,
    signature,
    outcome: 'confirming',
    message: null,
  };
  saveSentPayment(record);
  quotedPayments.set(quote.paymentId, { jobId, transaction: null });
  const resend = async () => {
    if (delivered) return;
    try {
      await connection.sendRawTransaction(bytes);
      delivered = true;
    } catch (err) {
      // The node answered (already processed, or refused): nothing more to re-broadcast.
      if (isNodeAnswer(err)) delivered = true;
    }
  };
  return settle(record, await confirmSentPayment(record, { resend }), report);
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export async function approvePreview(jobId: string): Promise<void> {
  await request(route(WEB_API_ROUTES.jobApprove.path, { id: jobId }), JobApproveResponse, {
    method: 'POST',
  });
}

/**
 * What the owner reviews before signing the launch: the summary plus whether the server simulated
 * the exact transaction (when not `ok`, the amounts are a lower bound).
 */
export async function getOwnerTransactionSummary(jobId: string): Promise<LaunchReview> {
  const res = await request(
    route(WEB_API_ROUTES.ownerTransactionGet.path, { id: jobId }),
    OwnerTransactionGetResponse,
  );
  return { ...res.summary, simulation: res.simulation ?? 'unavailable' };
}

/**
 * Signs the launch prepared by FORGE and submits it. The signed bytes are kept until the server
 * settles them: a retry (after a pending confirmation, a network error or a reload of the tab)
 * re-submits the same bytes without asking the wallet again. An already signed launch (409
 * ALREADY_SIGNED, or the job is `owner_signed` or later) is a success.
 */
export async function signOwnerTransaction(jobId: string, onPhase: OnTxPhase): Promise<TxResult> {
  const report = safeReporter(onPhase);
  const kept = getKeptLaunch(jobId);
  if (kept) {
    report('sending');
    return submitKeptLaunch(kept, report);
  }
  let signed: VersionedTransaction;
  try {
    const { address, signTransaction } = requireSessionWallet();
    let res: OwnerTransactionGetResponse;
    try {
      res = await request(
        route(WEB_API_ROUTES.ownerTransactionGet.path, { id: jobId }),
        OwnerTransactionGetResponse,
      );
    } catch (err) {
      if (isAlreadySigned(err)) {
        report('confirmed');
        return { phase: 'confirmed' };
      }
      throw err;
    }
    if (res.summary.ownerWallet !== address) {
      throw new ClientError('WRONG_WALLET', defaultMessage('WRONG_WALLET'));
    }
    const prepared = deserializeTransaction(res.transaction);
    // Paid by the session wallet, already signed by FORGE: only the owner's signature missing.
    verifyLaunchTransaction(prepared, { wallet: address });
    report('awaiting_signature');
    try {
      signed = await signTransaction(prepared);
    } catch (err) {
      if (isUserRejection(err)) {
        report('rejected');
        return { phase: 'rejected' };
      }
      throw err;
    }
    // The server only accepts the prepared message, byte for byte.
    assertSignedByWallet(prepared, signed, address);
  } catch (err) {
    report('error');
    if (err instanceof ClientError) throw err;
    return { phase: 'error', error: errorMessage(err) };
  }
  const record: KeptLaunch = {
    jobId,
    signedTransaction: bytesToBase64(signed.serialize()),
    signature: feePayerSignature(signed)!,
  };
  keepLaunch(record);
  report('sending');
  return submitKeptLaunch(record, report);
}

// ---------------------------------------------------------------------------------------------
// Launchpads
// ---------------------------------------------------------------------------------------------

/**
 * Claims the owner's partner fees of ONE pool (the server picks the richest one). The summary of
 * the claim transaction (amount claimed by this transaction, owner cost, pools left) is handed to
 * `options.review` before the wallet is asked to sign; call again while `remainingPools > 0`.
 */
export async function claimPartnerFees(
  launchpadId: string,
  onPhase: OnTxPhase,
  options: ClaimOptions = {},
): Promise<ClaimResult> {
  const report = safeReporter(onPhase);
  let summary: ClaimTransactionSummary | null = null;
  let signed: VersionedTransaction;
  try {
    const { signTransaction, address } = requireSessionWallet();
    const res = await request(
      route(WEB_API_ROUTES.claimTransaction.path, { id: launchpadId }),
      ClaimTransactionResponse,
    );
    summary = res.summary ?? null;
    const tx = deserializeTransaction(res.transaction);
    // Fees paid to the session wallet only, through the expected programs only.
    const check = (t: VersionedTransaction) =>
      verifyPartnerClaimTransaction(t, { wallet: address });
    check(tx);
    if (options.review && !(await options.review(summary))) return { phase: 'idle', summary };
    report('awaiting_signature');
    try {
      signed = await signTransaction(tx);
    } catch (err) {
      if (isUserRejection(err)) {
        report('rejected');
        return { phase: 'rejected', summary };
      }
      throw err;
    }
    assertSignedCopy(signed, address, check);
  } catch (err) {
    report('error');
    if (err instanceof ClientError) throw err;
    return { phase: 'error', error: errorMessage(err), summary };
  }
  report('sending');
  const signature = feePayerSignature(signed) ?? undefined;
  try {
    const sent = await sendAndConfirm(signed);
    report('confirmed');
    return { phase: 'confirmed', signature: sent, summary };
  } catch (err) {
    report('error');
    const error = isPreflightRejection(err) ? preflightMessage(err) : errorMessage(err);
    return { phase: 'error', error, summary, ...(signature ? { signature } : {}) };
  }
}

/** Wakes a sleeping launchpad (`POST /api/launchpads/:id/reactivate`). */
export async function reactivateLaunchpad(launchpadId: string): Promise<void> {
  await request(route(WEB_API_ROUTES.launchpadReactivate.path, { id: launchpadId }), z.unknown(), {
    method: 'POST',
  });
}
