import { handleChat } from '@/server/chat/handler';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
