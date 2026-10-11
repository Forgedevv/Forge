import { handleReactivate } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** POST /api/launchpads/:id/reactivate -> { status } (wake a sleeping launchpad). */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleReactivate(request, context);
}
