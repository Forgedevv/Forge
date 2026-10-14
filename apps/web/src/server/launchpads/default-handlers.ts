import { getDefaultGatingCheck } from '../chat/gating';
import { errorToResponse, type IdRouteContext } from '../jobs/handlers';
import { getRoutesRuntime, launchpadsLogger } from '../jobs/runtime';
import { createCoreClaimsChain } from './chain';
import { createClaimsService } from './claims';
import { createLaunchpadsHandlers, type LaunchpadsHandlers } from './handlers';
import { createModificationsService } from './modifications';
import { createReactivateService } from './reactivate';
import { createRetryService } from './retry';
import { createLaunchpadReads } from './summary';

/* Production wiring of the launchpad routes (app/api/launchpads/**, except `[id]/uploads`). */

let handlers: LaunchpadsHandlers | null = null;

function getLaunchpadsHandlers(): LaunchpadsHandlers {
  if (handlers) return handlers;
  const runtime = getRoutesRuntime();
  const chain = createCoreClaimsChain({
    connection: runtime.connection,
    cluster: runtime.config.cluster,
  });
  const { store } = runtime;
  const logger = launchpadsLogger;
  handlers = createLaunchpadsHandlers({
    reads: createLaunchpadReads({
      store,
      chain,
      logger,
      clientsDomain: runtime.config.clientsDomain,
    }),
    claims: createClaimsService({ store, chain, logger }),
    modifications: createModificationsService({
      store,
      logger,
      gating: (wallet) => getDefaultGatingCheck()(wallet),
    }),
    reactivation: createReactivateService({ store, logger }),
    retries: createRetryService({
      store,
      logger,
      gating: (wallet) => getDefaultGatingCheck()(wallet),
    }),
    rateLimiter: runtime.rateLimiter,
    logger,
  });
  return handlers;
}

function withHandlers(
  route: string,
  run: (h: LaunchpadsHandlers) => Promise<Response>,
): Promise<Response> {
  let h: LaunchpadsHandlers;
  try {
    h = getLaunchpadsHandlers();
  } catch (error) {
    return Promise.resolve(errorToResponse(error, launchpadsLogger, route));
  }
  return run(h);
}

export function handleListLaunchpads(request: Request): Promise<Response> {
  return withHandlers('launchpads:list', (h) => h.list(request));
}

export function handleGetLaunchpad(request: Request, context: IdRouteContext): Promise<Response> {
  return withHandlers('launchpads:get', (h) => h.detail(request, context));
}

export function handleClaimTransaction(
  request: Request,
  context: IdRouteContext,
): Promise<Response> {
  return withHandlers('launchpads:claim', (h) => h.claimTransaction(request, context));
}

export function handleRequestModification(
  request: Request,
  context: IdRouteContext,
): Promise<Response> {
  return withHandlers('launchpads:modification', (h) => h.requestModification(request, context));
}

export function handleReactivate(request: Request, context: IdRouteContext): Promise<Response> {
  return withHandlers('launchpads:reactivate', (h) => h.reactivate(request, context));
}

export function handleRetryLaunchpad(request: Request, context: IdRouteContext): Promise<Response> {
  return withHandlers('launchpads:retry', (h) => h.retry(request, context));
}
