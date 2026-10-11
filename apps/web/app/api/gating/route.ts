import { handleGating } from '@/server/gating/handler';

export const runtime = 'nodejs';
// Per-session answer, read at request time (never prerendered); responses are `no-store`.
export const dynamic = 'force-dynamic';

/** GET /api/gating → GatingResponse `{ ok, required, balance, enabled }` (docs/INTERFACES.md §6). */
export function GET(request: Request): Promise<Response> {
  return handleGating(request);
}
