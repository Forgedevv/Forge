import { handleRpcOptions, handleRpcPost } from '@/server/rpc/default-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Upstream deadline is 20 s (src/server/rpc/upstream.ts). */
export const maxDuration = 30;

/** POST /api/rpc — JSON-RPC relay (docs/INTERFACES.md §6, docs/SECURITY.md §11). */
export function POST(request: Request): Promise<Response> {
  return handleRpcPost(request);
}

/** CORS preflight: only FORGE client sites, the FORGE site and localhost outside production. */
export function OPTIONS(request: Request): Promise<Response> {
  return handleRpcOptions(request);
}
