import { Slug } from '@forge/shared';
import { buildCoinMetadata, isCoinPublic, type CoinMetaRecord } from './metadata';

/*
 * GET /api/coin-meta/:slug — public (no session, no beta gate): wallets, explorers and indexers
 * fetch it from the coin's on-chain metadata URI.
 *
 * - The slug is validated (shared Slug) before any database read.
 * - 404 for an unknown, not yet approved or disabled launchpad (same answer for all three).
 * - 200: the metadata JSON, cached by browsers 5 minutes and by the CDN a day; also cached in
 *   memory per instance (TTL), so the database sees at most one read per slug and TTL.
 * - Errors never carry a database message.
 */

export const CACHE_CONTROL_OK = 'public, max-age=300, s-maxage=86400';
export const CACHE_CONTROL_NOT_FOUND = 'public, max-age=60, s-maxage=60';
export const MEMORY_TTL_MS = 60_000;
const MEMORY_MAX_ENTRIES = 500;

export interface CoinMetaSource {
  /** The launchpad holding `slug` and its creation job, or null. */
  find(slug: string): Promise<CoinMetaRecord | null>;
}

export interface CoinMetaHandlerDeps {
  /** Lazily built source (a configuration error is answered with a 503). */
  source: () => CoinMetaSource;
  clientsDomain: () => string | null;
  now?: () => number;
  onError?: (event: string, error: unknown) => void;
}

type Body = Record<string, unknown>;

function json(body: Body, status: number, cacheControl: string): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': cacheControl,
      // Public data read by explorer front-ends from other origins; no credentials involved.
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

const NOT_FOUND: Body = { code: 'NOT_FOUND', message: 'Coin metadata not found.' };

export function createCoinMetaHandler(
  deps: CoinMetaHandlerDeps,
): (slug: string) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { body: Body | null; at: number }>();

  function remember(slug: string, body: Body | null): void {
    if (cache.size >= MEMORY_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(slug, { body, at: now() });
  }

  function answer(body: Body | null): Response {
    return body ? json(body, 200, CACHE_CONTROL_OK) : json(NOT_FOUND, 404, CACHE_CONTROL_NOT_FOUND);
  }

  return async (rawSlug) => {
    const parsed = Slug.safeParse(rawSlug);
    if (!parsed.success) return answer(null);
    const slug = parsed.data;
    const hit = cache.get(slug);
    if (hit && now() - hit.at < MEMORY_TTL_MS) return answer(hit.body);
    try {
      const record = await deps.source().find(slug);
      const metadata =
        record && record.slug === slug && isCoinPublic(record)
          ? buildCoinMetadata(record, deps.clientsDomain())
          : null;
      if (record && isCoinPublic(record) && !metadata) {
        deps.onError?.('unusable_spec', new Error('stored spec has no usable coin'));
      }
      const body = metadata ? { ...metadata } : null;
      remember(slug, body);
      return answer(body);
    } catch (error) {
      deps.onError?.('read_failed', error);
      return json(
        { code: 'UNAVAILABLE', message: 'Coin metadata is temporarily unavailable.' },
        503,
        'no-store',
      );
    }
  };
}
