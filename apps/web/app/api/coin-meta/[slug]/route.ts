import { handleCoinMeta } from '@/server/coin-meta/default-handler';

export const runtime = 'nodejs';
// Read at request time (never prerendered at build); caching is done by the handler's headers.
export const dynamic = 'force-dynamic';

/**
 * GET /api/coin-meta/:slug -> token metadata JSON of the launchpad coin (public, no session).
 * The coin's on-chain metadata URI points here (SIGNER_COIN_METADATA_URL): keep the path stable.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleCoinMeta(slug);
}
