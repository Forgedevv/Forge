import { handleRequestModification } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** POST /api/launchpads/:id/modifications `{ conversationId, request }` -> { jobId }. */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRequestModification(request, context);
}
