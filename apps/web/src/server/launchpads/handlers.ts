import {
  ClaimTransactionResponse,
  LaunchpadModificationRequest,
  LaunchpadModificationResponse,
  SolanaAddress,
  type Session,
} from '@forge/shared';
import { z } from 'zod';
import { errorToResponse, type IdRouteContext } from '../jobs/handlers';
import {
  NOT_FOUND_MESSAGES,
  apiError,
  guard,
  json,
  parseIdParam,
  readBoundedJson,
  type GuardDeps,
} from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import type { RateLimiter, RateLimitRule } from '../payments/rate-limit';
import type { ClaimsService } from './claims';
import type { ModificationsService } from './modifications';
import type { ReactivateService } from './reactivate';
import type { LaunchpadReads } from './summary';

/*
 * HTTP layer of the launchpad routes (the `[id]/uploads` routes belong to another module):
 *   GET  /api/launchpads                         -> { launchpads, quotas }   (dashboard)
 *   GET  /api/launchpads/:id                     -> LaunchpadDetail + quotas (detail page)
 *   GET  /api/launchpads/:id/claim-transaction   -> { transaction, summary } (?pool=<address>)
 *   POST /api/launchpads/:id/modifications       -> { jobId, ... }
 *   POST /api/launchpads/:id/reactivate          -> { status }
 * Origin check, per-IP limit, session, per-wallet limit, strict zod body, owner-scoped service.
 */

export interface LaunchpadsHandlers {
  list(request: Request): Promise<Response>;
  detail(request: Request, context: IdRouteContext): Promise<Response>;
  claimTransaction(request: Request, context: IdRouteContext): Promise<Response>;
  requestModification(request: Request, context: IdRouteContext): Promise<Response>;
  reactivate(request: Request, context: IdRouteContext): Promise<Response>;
}

const MINUTE = 60_000;

export const LAUNCHPAD_RATE_LIMITS = {
  // Dashboard reads hit the chain (cached 30 s per config).
  readIp: { limit: 60, windowMs: MINUTE },
  readWallet: { limit: 30, windowMs: MINUTE },
  claimIp: { limit: 20, windowMs: MINUTE },
  claimWallet: { limit: 10, windowMs: MINUTE },
  modificationIp: { limit: 20, windowMs: 10 * MINUTE },
  modificationWallet: { limit: 10, windowMs: 10 * MINUTE },
  reactivateIp: { limit: 20, windowMs: 10 * MINUTE },
  reactivateWallet: { limit: 5, windowMs: 10 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export const MODIFICATION_MAX_BODY_BYTES = 16 * 1024;

const ClaimQuery = z.strictObject({ pool: SolanaAddress.optional() });

export interface LaunchpadsHandlerDeps {
  reads: LaunchpadReads;
  claims: ClaimsService;
  modifications: ModificationsService;
  reactivation: ReactivateService;
  rateLimiter: RateLimiter;
  logger: RoutesLogger;
  requireSession?: (request: Request) => Session | Response;
  checkOrigin?: (request: Request) => Response | null;
}

export function createLaunchpadsHandlers(deps: LaunchpadsHandlerDeps): LaunchpadsHandlers {
  const { logger } = deps;
  const guardDeps: GuardDeps = {
    rateLimiter: deps.rateLimiter,
    ...(deps.requireSession ? { requireSession: deps.requireSession } : {}),
    ...(deps.checkOrigin ? { checkOrigin: deps.checkOrigin } : {}),
  };
  const r = LAUNCHPAD_RATE_LIMITS;

  async function run(
    route: string,
    ip: RateLimitRule,
    wallet: RateLimitRule,
    request: Request,
    context: IdRouteContext | null,
    body: (wallet: string, launchpadId: string) => Promise<Response>,
  ): Promise<Response> {
    try {
      const guarded = guard(request, route, { ip, wallet }, guardDeps);
      if (guarded instanceof Response) return guarded;
      const id = context ? await parseIdParam(context.params, NOT_FOUND_MESSAGES.launchpad) : '';
      return await body(guarded.wallet, id);
    } catch (error) {
      return errorToResponse(error, logger, route);
    }
  }

  return {
    list(request) {
      return run('launchpads:list', r.readIp, r.readWallet, request, null, async (wallet) =>
        json(await deps.reads.list({ wallet })),
      );
    },

    detail(request, context) {
      return run('launchpads:get', r.readIp, r.readWallet, request, context, async (wallet, id) =>
        json(await deps.reads.detail({ wallet, launchpadId: id })),
      );
    },

    claimTransaction(request, context) {
      return run(
        'launchpads:claim',
        r.claimIp,
        r.claimWallet,
        request,
        context,
        async (wallet, id) => {
          const query = ClaimQuery.safeParse(
            Object.fromEntries(new URL(request.url).searchParams.entries()),
          );
          if (!query.success) return apiError(400, 'BAD_REQUEST', 'Invalid claim request.');
          const view = await deps.claims.getClaimTransaction({
            wallet,
            launchpadId: id,
            ...(query.data.pool ? { pool: query.data.pool } : {}),
          });
          const body = ClaimTransactionResponse.parse(view);
          return json({ ...body, summary: view.summary });
        },
      );
    },

    requestModification(request, context) {
      return run(
        'launchpads:modification',
        r.modificationIp,
        r.modificationWallet,
        request,
        context,
        async (wallet, id) => {
          const parsed = LaunchpadModificationRequest.safeParse(
            await readBoundedJson(request, MODIFICATION_MAX_BODY_BYTES),
          );
          if (!parsed.success) {
            return apiError(400, 'BAD_REQUEST', 'Invalid modification request.');
          }
          const result = await deps.modifications.request({
            wallet,
            launchpadId: id,
            conversationId: parsed.data.conversationId,
            request: parsed.data.request,
          });
          const body = LaunchpadModificationResponse.parse(result);
          return json(
            {
              ...body,
              includedModificationsLeft: result.includedModificationsLeft,
              modificationPriceUsd: result.modificationPriceUsd,
            },
            result.created ? 201 : 200,
          );
        },
      );
    },

    reactivate(request, context) {
      return run(
        'launchpads:reactivate',
        r.reactivateIp,
        r.reactivateWallet,
        request,
        context,
        async (wallet, id) => json(await deps.reactivation.reactivate({ wallet, launchpadId: id })),
      );
    },
  };
}
