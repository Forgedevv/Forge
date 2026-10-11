import { handleUploadSweep } from '@/server/uploads/sweep-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One run deletes at most a few hundred objects. */
export const maxDuration = 60;

/**
 * POST /api/internal/uploads/sweep (scheduler only, `Authorization: Bearer
 * <FORGE_INTERNAL_CRON_SECRET>`): deletes the staged and orphaned objects of coin uploads.
 */
export function POST(request: Request): Promise<Response> {
  return handleUploadSweep(request);
}
