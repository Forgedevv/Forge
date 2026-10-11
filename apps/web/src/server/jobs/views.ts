import type { Job, JobEvent } from '@forge/shared';
import type { JobEventRecord, JobRecord, RefundRecord } from './store';

/*
 * Browser-facing shapes of the shared contract (packages/shared/src/web-client.ts). `owner_tx`,
 * locks and costs never leave the server through these views.
 */

export function toJobView(job: JobRecord, refund?: RefundRecord | null): Job {
  const view: Job = {
    id: job.id,
    launchpadId: job.launchpadId,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    failedStage: job.failedStage,
    error: job.error,
    previewUrl: job.previewUrl,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'refunded') {
    view.refund = refund
      ? { lamports: refund.lamports.toString(), signature: refund.signature }
      : null;
  }
  return view;
}

export function toJobEventView(event: JobEventRecord): JobEvent {
  return { id: event.id, jobId: event.jobId, message: event.message, createdAt: event.createdAt };
}
