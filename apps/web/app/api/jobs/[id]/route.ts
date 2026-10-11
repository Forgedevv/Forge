import { handleGetJob } from '@/server/jobs/default-handlers';

export const runtime = 'nodejs';

/** GET /api/jobs/:id -> { job, events } (owner only; tracking page). */
export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGetJob(request, context);
}
