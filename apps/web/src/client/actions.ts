import {
  ClaimTransactionResponse,
  ClientError,
  JobApproveResponse,
  LaunchpadModificationRequest,
  LaunchpadModificationResponse,
  OwnerTransactionGetResponse,
  OwnerTransactionSubmitRequest,
  OwnerTransactionSubmitResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsQuoteRequest,
  PaymentsQuoteResponse,
  SpecConfirmRequest,
  SpecConfirmResponse,
  WEB_API_ROUTES,
  type LaunchpadSpec,
  type OnTxPhase,
  type OwnerTransactionSummary,
  type PaymentKind,
  type Quote,
  type TxResult,
} from '@forge/shared';
import { z } from 'zod';
import { defaultMessage } from './errors';
import { request, route, validateBody } from './http';
import { bytesToBase64 } from './base58';
import { deserializeTransaction, requireWallet, runTransaction, sendAndConfirm } from './tx';

/** Unsigned payment transactions by payment id (the shared `Quote` type does not carry it). */
const pendingPaymentTx = new Map<string, string>();

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

export async function getQuote(jobId: string, kind: PaymentKind): Promise<Quote> {
  const body = validateBody(PaymentsQuoteRequest, { jobId, kind });
  const res = await request(WEB_API_ROUTES.paymentsQuote.path, PaymentsQuoteResponse, {
    method: 'POST',
    body,
  });
  const { transaction, ...quote } = res;
  if (transaction) pendingPaymentTx.set(quote.paymentId, transaction);
  else pendingPaymentTx.delete(quote.paymentId);
  return quote;
}

export async function payQuote(quote: Quote, onPhase: OnTxPhase): Promise<TxResult> {
  // Nothing to pay: an included modification remains and the job already moved to `paid`.
  if (quote.lamports === '0') {
    onPhase('confirmed');
    return { phase: 'confirmed' };
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    onPhase('error');
    throw new ClientError('QUOTE_EXPIRED', defaultMessage('QUOTE_EXPIRED'));
  }
  const transaction = pendingPaymentTx.get(quote.paymentId);
  if (!transaction) {
    onPhase('error');
    throw new ClientError('QUOTE_EXPIRED', 'This quote is no longer available. Request a new one.');
  }
  return runTransaction(onPhase, {
    prepare: async () => deserializeTransaction(transaction),
    submit: async (signed) => {
      const signature = await sendAndConfirm(signed);
      const body = validateBody(PaymentsConfirmRequest, {
        paymentId: quote.paymentId,
        signature,
      });
      const res = await request(WEB_API_ROUTES.paymentsConfirm.path, PaymentsConfirmResponse, {
        method: 'POST',
        body,
      });
      if (res.status === 'expired') {
        throw new ClientError('QUOTE_EXPIRED', defaultMessage('QUOTE_EXPIRED'));
      }
      if (res.status !== 'confirmed') {
        throw new Error('The payment could not be confirmed.');
      }
      pendingPaymentTx.delete(quote.paymentId);
      return signature;
    },
  });
}

export async function approvePreview(jobId: string): Promise<void> {
  await request(route(WEB_API_ROUTES.jobApprove.path, { id: jobId }), JobApproveResponse, {
    method: 'POST',
  });
}

export async function getOwnerTransactionSummary(jobId: string): Promise<OwnerTransactionSummary> {
  const res = await request(
    route(WEB_API_ROUTES.ownerTransactionGet.path, { id: jobId }),
    OwnerTransactionGetResponse,
  );
  return res.summary;
}

export async function signOwnerTransaction(jobId: string, onPhase: OnTxPhase): Promise<TxResult> {
  const path = route(WEB_API_ROUTES.ownerTransactionGet.path, { id: jobId });
  return runTransaction(onPhase, {
    prepare: async () => {
      const { publicKey } = requireWallet();
      const res = await request(path, OwnerTransactionGetResponse);
      if (res.summary.ownerWallet !== publicKey.toBase58()) {
        throw new ClientError('WRONG_WALLET', defaultMessage('WRONG_WALLET'));
      }
      return deserializeTransaction(res.transaction);
    },
    submit: async (signed) => {
      const body = validateBody(OwnerTransactionSubmitRequest, {
        signedTransaction: bytesToBase64(signed.serialize()),
      });
      const res = await request(
        route(WEB_API_ROUTES.ownerTransactionSubmit.path, { id: jobId }),
        OwnerTransactionSubmitResponse,
        { method: 'POST', body },
      );
      return res.signature;
    },
  });
}

export async function claimPartnerFees(launchpadId: string, onPhase: OnTxPhase): Promise<TxResult> {
  return runTransaction(onPhase, {
    prepare: async () => {
      requireWallet();
      const res = await request(
        route(WEB_API_ROUTES.claimTransaction.path, { id: launchpadId }),
        ClaimTransactionResponse,
      );
      return deserializeTransaction(res.transaction);
    },
    submit: (signed) => sendAndConfirm(signed),
  });
}

/**
 * Wakes a sleeping launchpad. The route is not part of INTERFACES.md §6 yet: implemented
 * against `POST /api/launchpads/:id/reactivate`.
 */
export const REACTIVATE_PATH = '/api/launchpads/:id/reactivate';

export async function reactivateLaunchpad(launchpadId: string): Promise<void> {
  await request(route(REACTIVATE_PATH, { id: launchpadId }), z.unknown(), { method: 'POST' });
}
