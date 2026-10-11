import type { Job, JobEvent, JobStatus } from '@forge/shared';
import { RouteError, NOT_FOUND_MESSAGES } from './http';
import { errorName, type RoutesLogger } from './log';
import type { OwnedJob, RoutesStore } from './store';
import { toJobEventView, toJobView } from './views';

/*
 * Job tracking and preview approval (docs/INTERFACES.md §4 and §6).
 *
 * - A job is only visible to the wallet that owns its launchpad: the store filters on the owner,
 *   so another wallet's job is answered exactly like an unknown one (404).
 * - Approval moves `preview_ready -> approved` with a conditional update. Retries and concurrent
 *   requests are idempotent: a job already approved (or further along) answers with its current
 *   status, nothing is written twice.
 */

/** Statuses reached only after the preview was approved. */
const APPROVED_OR_LATER: ReadonlySet<JobStatus> = new Set([
  'approved',
  'onchain_setup',
  'awaiting_owner_signature',
  'owner_signed',
  'deploying',
  'live',
]);

export interface JobsServiceDeps {
  store: RoutesStore;
  logger: RoutesLogger;
}

export interface JobsService {
  getJob(input: { wallet: string; jobId: string }): Promise<{ job: Job; events: JobEvent[] }>;
  approve(input: { wallet: string; jobId: string }): Promise<{ status: JobStatus }>;
}

export async function requireOwnedJob(
  store: RoutesStore,
  jobId: string,
  wallet: string,
): Promise<OwnedJob> {
  const owned = await store.getOwnedJob(jobId, wallet);
  if (!owned) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.job);
  return owned;
}

/** Writes a client-visible job event; a failure is logged, never fatal (the transition is). */
export async function addJobEventSafe(
  store: RoutesStore,
  logger: RoutesLogger,
  jobId: string,
  message: string,
): Promise<void> {
  try {
    await store.addJobEvent(jobId, message);
  } catch (error) {
    logger.log('warn', 'job_event.failed', { jobId, error: errorName(error) });
  }
}

export function createJobsService(deps: JobsServiceDeps): JobsService {
  const { store, logger } = deps;

  async function getJob(input: { wallet: string; jobId: string }) {
    const { job } = await requireOwnedJob(store, input.jobId, input.wallet);
    const [events, refunds] = await Promise.all([
      store.listJobEvents(job.id, input.wallet),
      job.status === 'refunded' ? store.listRefunds(input.wallet, [job.id]) : Promise.resolve([]),
    ]);
    return {
      job: toJobView(job, refunds[0] ?? null),
      events: events.map(toJobEventView),
    };
  }

  async function approve(input: { wallet: string; jobId: string }) {
    const { job, launchpad } = await requireOwnedJob(store, input.jobId, input.wallet);
    if (APPROVED_OR_LATER.has(job.status)) return { status: job.status };
    if (launchpad.status === 'disabled') {
      throw new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
    }
    if (job.status !== 'preview_ready') {
      throw new RouteError(409, 'INVALID_STATUS', 'There is no preview to approve for this job.', {
        status: job.status,
      });
    }
    if (await store.transitionJob(job.id, launchpad.id, 'preview_ready', 'approved')) {
      logger.log('info', 'job.approved', { jobId: job.id, launchpadId: launchpad.id });
      await addJobEventSafe(store, logger, job.id, 'Preview approved.');
      return { status: 'approved' as const };
    }
    // Lost a race: another request (or the builder) moved the job first.
    const fresh = await requireOwnedJob(store, input.jobId, input.wallet);
    if (APPROVED_OR_LATER.has(fresh.job.status)) return { status: fresh.job.status };
    throw new RouteError(409, 'INVALID_STATUS', 'There is no preview to approve for this job.', {
      status: fresh.job.status,
    });
  }

  return { getJob, approve };
}
