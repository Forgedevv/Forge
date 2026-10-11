import {
  handleGetOwnerTransaction,
  handleSubmitOwnerTransaction,
} from '@/server/jobs/default-handlers';

export const runtime = 'nodejs';
// The POST waits for the on-chain confirmation (about 25 s at most).
export const maxDuration = 60;

/** GET /api/jobs/:id/owner-transaction -> { transaction, summary } (docs/INTERFACES.md §6). */
export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGetOwnerTransaction(request, context);
}

/** POST /api/jobs/:id/owner-transaction `{ signedTransaction }` -> { signature }. */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSubmitOwnerTransaction(request, context);
}
