import { handleRetryLaunchpad } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** POST /api/launchpads/:id/retry -> { jobId } (start a refunded draft again). */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRetryLaunchpad(request, context);
}
