import type { LaunchpadStatus } from '@forge/shared';
import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import type { RoutesStore } from '../jobs/store';

/*
 * POST /api/launchpads/:id/reactivate -> `{ status: 'live' }` (docs/OPERATIONS.md, sleep mode:
 * "the client can reactivate it from their dashboard").
 *
 * Moves the launchpad `sleeping -> live` with a conditional update and resets the dormancy clock
 * (`last_trade_at = now`), so the daily sleep task does not put it back to sleep at once. The
 * builder redeploys the site in `live` mode (it alone writes `forge.config.json#mode`). Owner
 * only; idempotent (an already live launchpad answers `live`); refused while `deploys_paused` is
 * set (the reactivation needs a deployment) and for a draft or disabled launchpad.
 */

export interface ReactivateServiceDeps {
  store: RoutesStore;
  logger: RoutesLogger;
  now?: () => number;
}

export interface ReactivateService {
  reactivate(input: { wallet: string; launchpadId: string }): Promise<{ status: LaunchpadStatus }>;
}

export function createReactivateService(deps: ReactivateServiceDeps): ReactivateService {
  const { store, logger } = deps;
  const now = deps.now ?? Date.now;

  async function reactivate(input: { wallet: string; launchpadId: string }) {
    const launchpad = await store.getOwnedLaunchpad(input.launchpadId, input.wallet);
    if (!launchpad) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.launchpad);
    if (launchpad.status === 'live') return { status: 'live' as const };
    if (launchpad.status === 'disabled') {
      throw new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
    }
    if (launchpad.status !== 'sleeping') {
      throw new RouteError(409, 'INVALID_STATUS', 'Only a sleeping launchpad can be reactivated.', {
        status: launchpad.status,
      });
    }
    // Fails closed: an unreadable flag throws and is answered 503.
    if (await store.getFlag('deploys_paused')) {
      throw new RouteError(
        503,
        'DEPLOYS_PAUSED',
        'Reactivations are temporarily paused. Please try again later.',
      );
    }
    const at = new Date(now()).toISOString();
    if (await store.transitionLaunchpad(launchpad.id, input.wallet, 'sleeping', 'live', at)) {
      logger.log('info', 'launchpad.reactivated', { launchpadId: launchpad.id });
      return { status: 'live' as const };
    }
    const fresh = await store.getOwnedLaunchpad(launchpad.id, input.wallet);
    if (fresh?.status === 'live') return { status: 'live' as const };
    throw new RouteError(409, 'INVALID_STATUS', 'Only a sleeping launchpad can be reactivated.', {
      status: fresh?.status ?? null,
    });
  }

  return { reactivate };
}
