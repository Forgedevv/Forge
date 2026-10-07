import type { NextApiRequest, NextApiResponse } from 'next';
import { siteConfig } from './config';

/**
 * LOCKED ZONE. API routes call this first: when the site is `sleeping` or `disabled` they answer
 * 503 and never touch the RPC, R2 or Jupiter. Returns true when the request was rejected.
 */
export function rejectIfNotLive(_req: NextApiRequest, res: NextApiResponse): boolean {
  if (siteConfig.mode === 'live') return false;
  res.status(503).json({ error: 'This site is not available.' });
  return true;
}
