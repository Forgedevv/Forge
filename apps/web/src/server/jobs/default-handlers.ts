import { createConnectionLaunchChain } from './chain';
import {
  createJobsHandlers,
  errorToResponse,
  type JobsHandlers,
  type IdRouteContext,
} from './handlers';
import { createOwnerTransactionService } from './owner-transaction';
import { getRoutesRuntime, jobsLogger } from './runtime';
import { createJobsService } from './service';

/* Production wiring of the job routes (app/api/jobs/**). */

let handlers: JobsHandlers | null = null;

function getJobsHandlers(): JobsHandlers {
  if (handlers) return handlers;
  const runtime = getRoutesRuntime();
  const chain = createConnectionLaunchChain({
    connection: runtime.connection,
    cluster: runtime.config.cluster,
  });
  handlers = createJobsHandlers({
    jobs: createJobsService({ store: runtime.store, logger: jobsLogger }),
    ownerTransactions: createOwnerTransactionService({
      store: runtime.store,
      chain,
      logger: jobsLogger,
    }),
    rateLimiter: runtime.rateLimiter,
    logger: jobsLogger,
  });
  return handlers;
}

function withHandlers(
  route: string,
  run: (h: JobsHandlers) => Promise<Response>,
): Promise<Response> {
  let h: JobsHandlers;
  try {
    h = getJobsHandlers();
  } catch (error) {
    return Promise.resolve(errorToResponse(error, jobsLogger, route));
  }
  return run(h);
}

export function handleGetJob(request: Request, context: IdRouteContext): Promise<Response> {
  return withHandlers('jobs:get', (h) => h.getJob(request, context));
}

export function handleApprove(request: Request, context: IdRouteContext): Promise<Response> {
  return withHandlers('jobs:approve', (h) => h.approve(request, context));
}

export function handleGetOwnerTransaction(
  request: Request,
  context: IdRouteContext,
): Promise<Response> {
  return withHandlers('jobs:owner-tx:get', (h) => h.getOwnerTransaction(request, context));
}

export function handleSubmitOwnerTransaction(
  request: Request,
  context: IdRouteContext,
): Promise<Response> {
  return withHandlers('jobs:owner-tx:post', (h) => h.submitOwnerTransaction(request, context));
}
