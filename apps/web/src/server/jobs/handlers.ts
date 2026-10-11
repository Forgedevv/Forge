import {
  JobApproveResponse,
  OwnerTransactionGetResponse,
  OwnerTransactionSubmitRequest,
  OwnerTransactionSubmitResponse,
  type Session,
} from '@forge/shared';
import type { RateLimiter, RateLimitRule } from '../payments/rate-limit';
import { ClusterMismatchError, RpcUnavailableError } from './chain';
import { RoutesConfigError } from './config';
import {
  NOT_FOUND_MESSAGES,
  RouteError,
  apiError,
  guard,
  json,
  parseIdParam,
  readBoundedJson,
  type GuardDeps,
} from './http';
import { errorName, type RoutesLogger } from './log';
import type { OwnerTransactionService } from './owner-transaction';
import type { JobsService } from './service';
import { StoreError } from './store';

/*
 * HTTP layer of the job routes:
 *   GET  /api/jobs/:id                    -> { job, events }      (tracking page)
 *   POST /api/jobs/:id/approve            -> { status }
 *   GET  /api/jobs/:id/owner-transaction  -> { transaction, summary, simulation }
 *   POST /api/jobs/:id/owner-transaction  -> { signature }
 * Each one: origin check, per-IP limit, session, per-wallet limit, strict zod body, owner-scoped
 * service call. Responses are `no-store`.
 */

export type RouteParams = Promise<Record<string, string | string[] | undefined>>;
export interface IdRouteContext {
  params: RouteParams;
}

export interface JobsHandlers {
  getJob(request: Request, context: IdRouteContext): Promise<Response>;
  approve(request: Request, context: IdRouteContext): Promise<Response>;
  getOwnerTransaction(request: Request, context: IdRouteContext): Promise<Response>;
  submitOwnerTransaction(request: Request, context: IdRouteContext): Promise<Response>;
}

export const JOB_RATE_LIMITS = {
  readIp: { limit: 120, windowMs: 60_000 },
  readWallet: { limit: 60, windowMs: 60_000 },
  approveIp: { limit: 30, windowMs: 60_000 },
  approveWallet: { limit: 10, windowMs: 60_000 },
  ownerTxGetIp: { limit: 30, windowMs: 60_000 },
  ownerTxGetWallet: { limit: 15, windowMs: 60_000 },
  ownerTxPostIp: { limit: 20, windowMs: 60_000 },
  ownerTxPostWallet: { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/** A base64 legacy transaction is at most 1,644 characters; the JSON envelope adds little. */
export const OWNER_TX_MAX_BODY_BYTES = 4096;

export interface JobsHandlerDeps {
  jobs: JobsService;
  ownerTransactions: OwnerTransactionService;
  rateLimiter: RateLimiter;
  logger: RoutesLogger;
  requireSession?: (request: Request) => Session | Response;
  checkOrigin?: (request: Request) => Response | null;
}

/** Maps any error to a response. Only error names, codes and fixed texts are logged. */
export function errorToResponse(error: unknown, logger: RoutesLogger, route: string): Response {
  if (error instanceof RouteError) return error.toResponse();
  if (error instanceof RpcUnavailableError) {
    logger.log('warn', 'rpc.unavailable', { route });
    return apiError(
      503,
      'RPC_UNAVAILABLE',
      'The Solana network could not be reached. Please try again in a moment.',
      {},
      { 'Retry-After': '5' },
    );
  }
  if (error instanceof ClusterMismatchError) {
    logger.log('error', 'rpc.wrong_cluster', { route });
    return apiError(503, 'WRONG_CLUSTER', 'This service is temporarily unavailable.');
  }
  if (error instanceof RoutesConfigError) {
    // Config messages name variables only.
    logger.log('error', 'config.invalid', { route, detail: error.message });
  } else if (error instanceof StoreError) {
    logger.log('error', 'store.failed', { route, dbCode: error.dbCode ?? null });
  } else {
    logger.log('error', 'unexpected', { route, error: errorName(error) });
  }
  return apiError(
    503,
    'SERVER_ERROR',
    'This service is temporarily unavailable. Please try again.',
  );
}

export function createJobsHandlers(deps: JobsHandlerDeps): JobsHandlers {
  const { jobs, ownerTransactions, logger } = deps;
  const guardDeps: GuardDeps = {
    rateLimiter: deps.rateLimiter,
    ...(deps.requireSession ? { requireSession: deps.requireSession } : {}),
    ...(deps.checkOrigin ? { checkOrigin: deps.checkOrigin } : {}),
  };

  async function run(
    route: string,
    ip: RateLimitRule,
    wallet: RateLimitRule,
    request: Request,
    context: IdRouteContext,
    body: (wallet: string, jobId: string) => Promise<Response>,
  ): Promise<Response> {
    try {
      const guarded = guard(request, route, { ip, wallet }, guardDeps);
      if (guarded instanceof Response) return guarded;
      const jobId = await parseIdParam(context.params, NOT_FOUND_MESSAGES.job);
      return await body(guarded.wallet, jobId);
    } catch (error) {
      return errorToResponse(error, logger, route);
    }
  }

  return {
    getJob(request, context) {
      const r = JOB_RATE_LIMITS;
      return run('jobs:get', r.readIp, r.readWallet, request, context, async (wallet, jobId) =>
        json(await jobs.getJob({ wallet, jobId })),
      );
    },

    approve(request, context) {
      const r = JOB_RATE_LIMITS;
      return run(
        'jobs:approve',
        r.approveIp,
        r.approveWallet,
        request,
        context,
        async (wallet, jobId) =>
          json(JobApproveResponse.parse(await jobs.approve({ wallet, jobId }))),
      );
    },

    getOwnerTransaction(request, context) {
      const r = JOB_RATE_LIMITS;
      return run(
        'jobs:owner-tx:get',
        r.ownerTxGetIp,
        r.ownerTxGetWallet,
        request,
        context,
        async (wallet, jobId) => {
          const view = await ownerTransactions.get({ wallet, jobId });
          // Contract shape first (validated), then the extra `simulation` field.
          const body = OwnerTransactionGetResponse.parse(view);
          return json({ ...body, simulation: view.simulation });
        },
      );
    },

    submitOwnerTransaction(request, context) {
      const r = JOB_RATE_LIMITS;
      return run(
        'jobs:owner-tx:post',
        r.ownerTxPostIp,
        r.ownerTxPostWallet,
        request,
        context,
        async (wallet, jobId) => {
          const parsed = OwnerTransactionSubmitRequest.safeParse(
            await readBoundedJson(request, OWNER_TX_MAX_BODY_BYTES),
          );
          if (!parsed.success) {
            return apiError(400, 'BAD_REQUEST', 'Invalid signed transaction request.');
          }
          const result = await ownerTransactions.submit({
            wallet,
            jobId,
            signedTransaction: parsed.data.signedTransaction,
          });
          return json(OwnerTransactionSubmitResponse.parse(result));
        },
      );
    },
  };
}
