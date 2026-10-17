import { healthResponse } from '@/server/readiness';

export const runtime = 'nodejs';
// Read at request time (never prerendered at build): it reports this instance's configuration.
export const dynamic = 'force-dynamic';

/**
 * GET /api/health: 200 `{ ok: true }` when the server configuration is valid and the browser
 * bundle's cluster matches the server's; 503 `{ ok: false, code }` otherwise, with a generic code
 * (`config_invalid`, `cluster_mismatch`). The details are in the server log (src/server/readiness.ts).
 */
export function GET(): Response {
  return healthResponse();
}
