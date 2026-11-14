import { handlePreview } from '@/server/prelaunch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Team preview of the site while FORGE_PRELAUNCH is on (src/server/prelaunch/handler.ts). */
export function GET(request: Request): Response {
  return handlePreview(request);
}
