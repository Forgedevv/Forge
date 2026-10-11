import { handleSpecConfirm } from '@/server/chat/spec-confirm';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handleSpecConfirm(request);
}
