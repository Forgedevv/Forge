import type { NextApiRequest, NextApiResponse } from 'next';
import type { SiteMode } from '@forge/shared';
import { siteConfig } from './config';

/**
 * LOCKED ZONE. What a site may do in each mode (forge.config.json `mode`, written by FORGE only).
 *
 * - `live`: everything.
 * - `sleeping`: the app shell serves the lightweight sleeping page (no browsing, no indexer data).
 *   Trading and coin creation are disabled. Coin creators can still claim their creator fees
 *   (decision D29): the claim widget is the only action left, and it runs in the browser through
 *   the FORGE RPC relay, so every API route of the site still answers 503.
 * - `disabled`: cut off by FORGE (maintenance). Nothing is available.
 *
 * Every component and API route that moves money checks these capabilities, so that a wrong
 * page composition can never enable an action in a non-live mode.
 */
export interface ModeCapabilities {
  /** Browse coins, charts and balances (read-only). */
  browse: boolean;
  trade: boolean;
  create: boolean;
  claim: boolean;
}

const CAPABILITIES: Record<SiteMode, ModeCapabilities> = {
  live: { browse: true, trade: true, create: true, claim: true },
  sleeping: { browse: false, trade: false, create: false, claim: true },
  disabled: { browse: false, trade: false, create: false, claim: false },
};

export function capabilitiesFor(mode: SiteMode): ModeCapabilities {
  return CAPABILITIES[mode];
}

/** Mode of this site, from the bundled forge.config.json. */
export function currentMode(): SiteMode {
  return siteConfig.mode;
}

export interface ModeNotice {
  title: string;
  body: string;
}

/** Notice shown instead of an action when the mode forbids it. Null when live. */
export function modeNotice(mode: SiteMode): ModeNotice | null {
  switch (mode) {
    case 'live':
      return null;
    case 'sleeping':
      return {
        title: 'This launchpad is sleeping',
        body: 'Trading and coin creation are paused for now. Coin creators can still claim their fees.',
      };
    case 'disabled':
      return {
        title: 'Under maintenance',
        body: 'This launchpad is temporarily unavailable. Nothing can be traded, created or claimed.',
      };
  }
}

/**
 * API routes call this first: when the site is `sleeping` or `disabled` they answer 503 and never
 * touch the RPC, R2 or Jupiter. No API route serves the creator fee claim (it is built and sent
 * from the browser through the FORGE RPC relay), so a sleeping site keeps refusing them all. Returns true when the request was rejected. `mode` defaults to the
 * site's mode and exists for tests.
 */
export function rejectIfNotLive(
  _req: NextApiRequest,
  res: NextApiResponse,
  mode: SiteMode = siteConfig.mode,
): boolean {
  if (mode === 'live') return false;
  res.status(503).json({ error: 'This site is not available.' });
  return true;
}
