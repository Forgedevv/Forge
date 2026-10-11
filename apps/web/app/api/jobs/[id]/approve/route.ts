import { handleApprove } from '@/server/jobs/default-handlers';

export const runtime = 'nodejs';

/** POST /api/jobs/:id/approve -> { status } (docs/INTERFACES.md §6). */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApprove(request, context);
}
