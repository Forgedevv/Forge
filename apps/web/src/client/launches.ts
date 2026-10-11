import {
  OwnerTransactionSubmitRequest,
  OwnerTransactionSubmitResponse,
  WEB_API_ROUTES,
  type JobStatus,
  type TxPhase,
  type TxResult,
} from '@forge/shared';
import { z } from 'zod';
import { ApiError, isTransientError } from './errors';
import { request, route, validateBody } from './http';

/*
 * The launch transaction carries a durable nonce: once the owner signed it, the very same bytes
 * stay valid. They are kept (memory + sessionStorage) until the server settles them, so a retry
 * re-POSTs them instead of asking the wallet to sign again.
 */

export const LAUNCH_SUBMIT_TIMING = {
  /** Delay between two submissions when the server gives no `Retry-After`. */
  intervalMs: 5_000,
  /** How long one call keeps re-submitting while the confirmation is pending. */
  maxWaitMs: 90_000,
  /** One submission (the server waits up to ~25 s for the confirmation). */
  requestTimeoutMs: 60_000,
  maxRetryAfterMs: 15_000,
} as const;

export const LAUNCH_MESSAGES = {
  pending:
    'Your signed launch was sent and is still confirming. Retry in a moment: you will not be asked to sign again.',
} as const;

/** Job statuses reached once the owner's launch transaction is confirmed. */
export const SIGNED_OR_LATER: ReadonlySet<JobStatus> = new Set([
  'owner_signed',
  'deploying',
  'live',
]);

export interface KeptLaunch {
  jobId: string;
  /** The owner-signed launch transaction (base64), exactly as it will be submitted. */
  signedTransaction: string;
  /** Its fee payer signature (the transaction id). */
  signature: string;
}

const STORAGE_KEY = 'forge.launch.signed';
const RecordSchema = z.object({
  jobId: z.string().min(1),
  signedTransaction: z.string().min(1),
  signature: z.string().min(1),
});
const StoreSchema = z.record(z.string(), RecordSchema);

let memory: Record<string, KeptLaunch> = {};

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(): Record<string, KeptLaunch> {
  const s = storage();
  if (!s) return memory;
  try {
    const raw = s.getItem(STORAGE_KEY);
    const parsed = raw ? StoreSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? { ...memory, ...parsed.data } : { ...memory };
  } catch {
    return { ...memory };
  }
}

function writeAll(all: Record<string, KeptLaunch>): void {
  memory = all;
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(all).length === 0) s.removeItem(STORAGE_KEY);
    else s.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // the in-memory copy still serves this page
  }
}

export function getKeptLaunch(jobId: string): KeptLaunch | null {
  return readAll()[jobId] ?? null;
}

export function keepLaunch(record: KeptLaunch): void {
  writeAll({ ...readAll(), [record.jobId]: record });
}

export function forgetLaunch(jobId: string): void {
  const all = { ...readAll() };
  if (!(jobId in all)) return;
  delete all[jobId];
  writeAll(all);
}

/** Test helper. */
export function resetKeptLaunches(): void {
  memory = {};
  writeAll({});
}

/** The launch was already signed and confirmed (409 ALREADY_SIGNED, or a later job status). */
export function isAlreadySigned(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.serverCode === 'ALREADY_SIGNED') return true;
  const status = err.details.status;
  return (
    err.serverCode === 'INVALID_STATUS' &&
    typeof status === 'string' &&
    SIGNED_OR_LATER.has(status as JobStatus)
  );
}

/** Refusals after which the same signed bytes can still land (e.g. the wallet lacked SOL). */
const RETRYABLE_REFUSALS = new Set(['TRANSACTION_REJECTED']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function boundedDelay(retryAfterMs: number | null): number {
  const t = LAUNCH_SUBMIT_TIMING;
  if (retryAfterMs === null) return t.intervalMs;
  return Math.min(t.maxRetryAfterMs, Math.max(1_000, retryAfterMs));
}

/**
 * POSTs the kept signed launch until the server settles it: 503 CONFIRMATION_PENDING, 429, 5xx,
 * network errors and timeouts re-POST the same bytes; 409 ALREADY_SIGNED (or a later job status)
 * is a success. Never asks the wallet for anything.
 */
export async function submitKeptLaunch(
  record: KeptLaunch,
  report: (phase: TxPhase) => void,
): Promise<TxResult> {
  const t = LAUNCH_SUBMIT_TIMING;
  const body = validateBody(OwnerTransactionSubmitRequest, {
    signedTransaction: record.signedTransaction,
  });
  const path = route(WEB_API_ROUTES.ownerTransactionSubmit.path, { id: record.jobId });
  const deadline = Date.now() + t.maxWaitMs;
  for (;;) {
    let delay: number;
    try {
      const res = await request(path, OwnerTransactionSubmitResponse, {
        method: 'POST',
        body,
        timeoutMs: t.requestTimeoutMs,
      });
      forgetLaunch(record.jobId);
      report('confirmed');
      return { phase: 'confirmed', signature: res.signature };
    } catch (err) {
      if (isAlreadySigned(err)) {
        forgetLaunch(record.jobId);
        report('confirmed');
        return { phase: 'confirmed', signature: record.signature };
      }
      if (err instanceof ApiError && err.serverCode === 'CONFIRMATION_PENDING') {
        delay = boundedDelay(err.retryAfterMs);
      } else if (isTransientError(err)) {
        delay = boundedDelay(err instanceof ApiError ? err.retryAfterMs : null);
      } else {
        // A definitive answer. The bytes are dropped unless they can still land as they are.
        const keep =
          err instanceof ApiError &&
          (RETRYABLE_REFUSALS.has(err.serverCode ?? '') ||
            err.code === 'UNAUTHORIZED' ||
            err.code === 'BETA_NOT_INVITED');
        if (!keep) forgetLaunch(record.jobId);
        report('error');
        return {
          phase: 'error',
          signature: record.signature,
          error: err instanceof Error ? err.message : 'The launch could not be submitted.',
        };
      }
    }
    if (Date.now() + delay > deadline) {
      report('error');
      return { phase: 'error', signature: record.signature, error: LAUNCH_MESSAGES.pending };
    }
    await sleep(delay);
  }
}
