import { handleClaimTransaction } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** GET /api/launchpads/:id/claim-transaction -> { transaction } (docs/INTERFACES.md §6). */
export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleClaimTransaction(request, context);
}
