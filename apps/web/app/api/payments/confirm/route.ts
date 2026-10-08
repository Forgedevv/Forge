import { handleConfirm } from '@/server/payments/default-handlers';

export const runtime = 'nodejs';
/** Confirmation waits a few seconds for a transaction that is not yet confirmed. */
export const maxDuration = 30;

/** POST /api/payments/confirm `{ paymentId, signature }` (docs/INTERFACES.md §6). */
export function POST(request: Request): Promise<Response> {
  return handleConfirm(request);
}
