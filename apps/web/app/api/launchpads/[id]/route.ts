import { handleGetLaunchpad } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** GET /api/launchpads/:id -> LaunchpadDetail + quotas (owner only). */
export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGetLaunchpad(request, context);
}
