import { handleQuote } from '@/server/payments/default-handlers';

export const runtime = 'nodejs';

/** POST /api/payments/quote `{ jobId, kind }` (docs/INTERFACES.md §6). */
export function POST(request: Request): Promise<Response> {
  return handleQuote(request);
}
