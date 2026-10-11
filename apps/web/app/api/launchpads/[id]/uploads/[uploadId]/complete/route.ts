import { handleCompleteUpload } from '@/server/uploads/handlers';

export const runtime = 'nodejs';
/** Reads back an image of up to 2 MB from storage and writes the metadata. */
export const maxDuration = 30;

/**
 * POST /api/launchpads/{id}/uploads/{uploadId}/complete `{ mint }`: verifies the stored image and
 * writes the coin metadata JSON (contract v1). Idempotent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> },
): Promise<Response> {
  const { id, uploadId } = await params;
  return handleCompleteUpload(request, id, uploadId);
}
