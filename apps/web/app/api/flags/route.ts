import { handleFlags } from '@/server/flags/flags';

export const runtime = 'nodejs';
// Read at request time (never prerendered at build); caching is done by the handler's headers.
export const dynamic = 'force-dynamic';

/** GET /api/flags → FlagsResponse `{ signupsPaused }` (docs/INTERFACES.md §6). */
export function GET(): Promise<Response> {
  return handleFlags();
}
