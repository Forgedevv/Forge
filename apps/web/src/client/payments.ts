import { PaymentsConfirmRequest, PaymentsConfirmResponse, WEB_API_ROUTES } from '@forge/shared';
import { z } from 'zod';
import { ApiError, NetworkFailure, parseRetryAfter } from './errors';
import { rawRequest, validateBody } from './http';
import type { PendingPayment } from './types';

/*
 * A payment transaction, once sent, is never replaced by a new one while it is unresolved
 * (docs/DECISIONS.md D20: a second payment for the same job would need a manual refund).
 *
 * Right after the wallet-signed transaction is sent, `{ jobId, paymentId, signature }` is saved in
 * sessionStorage (and in memory when storage is unavailable). Confirmation is then retried with
 * the SAME signature until the server settles it; the screens read the record to resume after a
 * reload and to never offer a new quote meanwhile.
 */

export const PAYMENT_CONFIRM_TIMING = {
  /** Delay between two confirmation requests when the server gives no `Retry-After`. */
  intervalMs: 2_000,
  /** How long one `payQuote` / `resumePayment` call keeps re-confirming. */
  maxWaitMs: 90_000,
  /** One confirmation request (the server itself waits up to ~10 s). */
  requestTimeoutMs: 25_000,
  /** Upper bound on an honoured `Retry-After`. */
  maxRetryAfterMs: 15_000,
} as const;

export const PAYMENT_MESSAGES = {
  confirming:
    'Your payment was sent and is still being confirmed. Check again in a moment: you will not be asked to pay again.',
  late: 'Your payment reached FORGE after the quote expired, so it cannot start the build. It will be refunded manually: contact support with the transaction signature below. Do not pay again.',
  rejected:
    'Contact support with the transaction signature below before paying again: a second payment would need a manual refund.',
  failed: 'The payment failed on-chain and no SOL was transferred. You can request a new quote.',
  pending:
    'A payment for this job was already sent and is not settled yet. It is being confirmed with its original signature.',
} as const;

const STORAGE_KEY = 'forge.payments.sent';

const RecordSchema = z.object({
  jobId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
  outcome: z.enum(['confirming', 'late', 'rejected']),
  message: z.string().nullable(),
});
const StoreSchema = z.record(z.string(), RecordSchema);

/** Fallback when sessionStorage is unavailable (private mode, server, tests). */
let memory: Record<string, PendingPayment> = {};

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(): Record<string, PendingPayment> {
  const s = storage();
  if (!s) return memory;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { ...memory };
    const parsed = StoreSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ...memory, ...parsed.data } : { ...memory };
  } catch {
    return { ...memory };
  }
}

function writeAll(all: Record<string, PendingPayment>): void {
  memory = all;
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(all).length === 0) s.removeItem(STORAGE_KEY);
    else s.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // quota or privacy mode: the in-memory copy still protects this page
  }
}

export function getSentPayment(jobId: string): PendingPayment | null {
  return readAll()[jobId] ?? null;
}

export function saveSentPayment(record: PendingPayment): void {
  writeAll({ ...readAll(), [record.jobId]: record });
}

export function clearSentPayment(jobId: string): void {
  const all = { ...readAll() };
  if (!(jobId in all)) return;
  delete all[jobId];
  writeAll(all);
}

/** Test helper: forgets every record. */
export function resetSentPayments(): void {
  memory = {};
  writeAll({});
}

// ---------------------------------------------------------------------------------------------
// Confirmation loop
// ---------------------------------------------------------------------------------------------

export type ConfirmOutcome =
  | { kind: 'confirmed' }
  | { kind: 'confirming'; message: string }
  | { kind: 'late' }
  | { kind: 'failed'; message: string }
  | { kind: 'rejected'; message: string };

export interface ConfirmLoopOptions {
  /** Re-broadcasts the signed transaction (when the first send may not have reached the cluster). */
  resend?: () => Promise<void>;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function boundedDelay(retryAfterMs: number | null | undefined): number {
  const t = PAYMENT_CONFIRM_TIMING;
  if (retryAfterMs === null || retryAfterMs === undefined) return t.intervalMs;
  return Math.min(t.maxRetryAfterMs, Math.max(t.intervalMs, retryAfterMs));
}

/**
 * POSTs /api/payments/confirm with the same signature until the server settles the payment:
 * 202 (`quoted`), 429 (honouring Retry-After), 5xx, network errors and timeouts are retried for
 * up to `PAYMENT_CONFIRM_TIMING.maxWaitMs`; then `confirming` is returned (call again to resume).
 */
export async function confirmSentPayment(
  record: Pick<PendingPayment, 'paymentId' | 'signature'>,
  options: ConfirmLoopOptions = {},
): Promise<ConfirmOutcome> {
  const t = PAYMENT_CONFIRM_TIMING;
  const body = validateBody(PaymentsConfirmRequest, {
    paymentId: record.paymentId,
    signature: record.signature,
  });
  const deadline = Date.now() + t.maxWaitMs;
  for (;;) {
    let delay: number = t.intervalMs;
    try {
      const res = await rawRequest(WEB_API_ROUTES.paymentsConfirm.path, {
        method: 'POST',
        body,
        timeoutMs: t.requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const parsed = PaymentsConfirmResponse.safeParse(await res.json().catch(() => undefined));
      if (parsed.success && res.status !== 202) {
        const status = parsed.data.status;
        if (status === 'confirmed' || status === 'refunded') return { kind: 'confirmed' };
        if (status === 'expired') return { kind: 'late' };
      }
      // 202 (not confirmed on-chain yet), `quoted`, or an unreadable body: ask again.
      delay = boundedDelay(
        res.status === 202 ? parseRetryAfter(res.headers.get('retry-after')) : null,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 410 || err.code === 'QUOTE_EXPIRED') return { kind: 'late' };
        if (err.status === 429 || err.status >= 500) {
          delay = boundedDelay(err.retryAfterMs);
        } else if (err.code === 'UNAUTHORIZED' || err.code === 'BETA_NOT_INVITED') {
          // The session is gone: the payment stays unresolved until the owner signs in again.
          return {
            kind: 'confirming',
            message: `${err.message} Your payment was sent: sign in again to finish confirming it.`,
          };
        } else if (err.serverCode === 'PAYMENT_FAILED') {
          return { kind: 'failed', message: PAYMENT_MESSAGES.failed };
        } else {
          return { kind: 'rejected', message: `${err.message} ${PAYMENT_MESSAGES.rejected}` };
        }
      } else if (!(err instanceof NetworkFailure)) {
        // Unexpected (e.g. a bug in a listener): the payment is still unresolved, ask again.
        delay = t.intervalMs;
      }
    }
    if (options.resend) await options.resend().catch(() => undefined);
    if (options.signal?.aborted || Date.now() + delay > deadline) {
      return { kind: 'confirming', message: PAYMENT_MESSAGES.confirming };
    }
    await sleep(delay);
  }
}
