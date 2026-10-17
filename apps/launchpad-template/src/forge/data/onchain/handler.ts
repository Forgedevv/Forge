import type { NextApiRequest, NextApiResponse } from 'next';
import type { SiteMode } from '@forge/shared';
import { rejectIfNotLive } from '../../mode-guard';
import type { OnchainCoinService } from './service';

/**
 * LOCKED ZONE. SERVER ONLY. `GET /api/coins`: this launchpad's coins read on-chain, in the data
 * API shape, for the browser fallback of the coin data (`../source.ts`). Contract:
 *
 * - `GET /api/coins`: `{ source: 'chain', recent, aboutToGraduate, graduated }`, each
 *   `{ pools: Pool[] }` (at most 30 coins each);
 * - `GET /api/coins?mint=<address>`: `{ source: 'chain', pool: Pool | null, description: string | null }`
 *   (`pool` is null when the mint is not a coin of this launchpad); 400 for an invalid address;
 * - without a relay (development, the builder's visual review), `source: 'none'` and nothing
 *   (empty lists, no pool), never cached: what a devnet site showed before this fallback existed;
 * - 503 `{ error }` (never cached) when the site is not live or the chain cannot be read; 405 for
 *   any other method.
 *
 * Answers are cacheable by the CDN (`s-maxage`), so most visitors never reach the function.
 */

export const LIST_CACHE_CONTROL = 'public, max-age=0, s-maxage=15, stale-while-revalidate=60';
export const COIN_CACHE_CONTROL = 'public, max-age=0, s-maxage=10, stale-while-revalidate=30';

export interface CoinsHandlerOptions {
  /** The service, or null when the relay is not configured. Built on first use. */
  service: () => OnchainCoinService | null;
  mode?: SiteMode;
}

const EMPTY_LISTS = {
  recent: { pools: [] },
  aboutToGraduate: { pools: [] },
  graduated: { pools: [] },
};

function unavailable(res: NextApiResponse, error: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error });
}

export function createCoinsHandler(options: CoinsHandlerOptions) {
  return async function coins(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    if (rejectIfNotLive(req, res, options.mode)) return;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }
    const mint = req.query.mint;
    const service = options.service();
    if (!service) {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(200)
        .json(
          mint === undefined
            ? { source: 'none', ...EMPTY_LISTS }
            : { source: 'none', pool: null, description: null },
        );
      return;
    }
    try {
      if (mint !== undefined) {
        const result = typeof mint === 'string' ? await service.coin(mint) : null;
        if (!result) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(400).json({ error: 'Invalid mint address.' });
          return;
        }
        res.setHeader('Cache-Control', COIN_CACHE_CONTROL);
        res.status(200).json({ source: 'chain', ...result });
        return;
      }
      const lists = await service.lists();
      res.setHeader('Cache-Control', LIST_CACHE_CONTROL);
      res.status(200).json({ source: 'chain', ...lists });
    } catch {
      unavailable(res, 'On-chain coin data is temporarily unavailable.');
    }
  };
}
