import { handleListLaunchpads } from '@/server/launchpads/default-handlers';

export const runtime = 'nodejs';

/** GET /api/launchpads -> { launchpads, quotas } (owner's dashboard). */
export function GET(request: Request): Promise<Response> {
  return handleListLaunchpads(request);
}
