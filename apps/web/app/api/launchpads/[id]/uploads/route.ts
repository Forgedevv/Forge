import { handleCreateUpload } from '@/server/uploads/handlers';

export const runtime = 'nodejs';

/**
 * POST /api/launchpads/{id}/uploads: presigned coin-image upload ticket for a client site
 * (contract v1, src/server/uploads/contract.ts). `{id}` is the launchpad slug or uuid.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleCreateUpload(request, id);
}
