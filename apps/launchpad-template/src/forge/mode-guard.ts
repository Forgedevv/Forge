import type { NextApiRequest, NextApiResponse } from 'next';
import type { SiteMode } from '@forge/shared';
import { siteConfig } from './config';

/**
 * LOCKED ZONE. What a site may do in each mode (forge.config.json `mode`, written by FORGE only).
 *
 * - `live`: everything.
 * - `sleeping`: read-only. Trading, coin creation and claims are disabled and a banner says so.
 *   The app shell serves the static sleeping page without any RPC or Jupiter call.
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
  sleeping: { browse: true, trade: false, create: false, claim: false },
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
        body: 'It is read-only for now: trading, coin creation and fee claims are paused. Come back later.',
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
 * touch the RPC, R2 or Jupiter. Returns true when the request was rejected. `mode` defaults to the
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
