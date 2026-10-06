import { z } from 'zod';

/** Job statuses (docs/INTERFACES.md §4). */
export const JobStatus = z.enum([
  /** Created by apps/web: spec confirmed (creation) or modification request recorded. */
  'spec_ready',
  /** Payment confirmed on-chain. */
  'paid',
  /** Builder: container running. */
  'building',
  /** Preview URL available. */
  'preview_ready',
  /** The client approved the preview. */
  'approved',
  /** Builder + signer: configs creation and launch transaction preparation. */
  'onchain_setup',
  /** Launch transaction ready in jobs.owner_tx; the client must sign the first buy. */
  'awaiting_owner_signature',
  /** apps/web: client transaction confirmed on-chain. */
  'owner_signed',
  /** Builder: merge to main, Vercel production deploy. */
  'deploying',
  'live',
  /** A stage failed (see failed_stage and attempts). */
  'failed',
  'refunded',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobType = z.enum(['create_launchpad', 'modify_launchpad']);
export type JobType = z.infer<typeof JobType>;

export const FailedStage = z.enum(['build', 'onchain', 'deploy']);
export type FailedStage = z.infer<typeof FailedStage>;

/** Statuses during which the builder holds the job lock (locked_by / locked_at). */
export const ACTIVE_JOB_STATUSES = ['building', 'onchain_setup', 'deploying'] as const satisfies readonly JobStatus[];
export type ActiveJobStatus = (typeof ACTIVE_JOB_STATUSES)[number];

/** Happy path of a `create_launchpad` job, in order. */
export const CREATE_FLOW = [
  'spec_ready',
  'paid',
  'building',
  'preview_ready',
  'approved',
  'onchain_setup',
  'awaiting_owner_signature',
  'owner_signed',
  'deploying',
  'live',
] as const satisfies readonly JobStatus[];

/** Happy path of a `modify_launchpad` job, in order. */
export const MODIFY_FLOW = [
  'spec_ready',
  'paid',
  'building',
  'preview_ready',
  'approved',
  'deploying',
  'live',
] as const satisfies readonly JobStatus[];

export function isActiveJobStatus(status: JobStatus): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/** Ordered happy path for a job type. */
export function flowForJobType(type: JobType): readonly JobStatus[] {
  return type === 'create_launchpad' ? CREATE_FLOW : MODIFY_FLOW;
}

/**
 * Stage recorded in failed_stage when a job fails (or is found stale) in the given status:
 * building -> build, onchain_setup -> onchain, deploying -> deploy. Null for non-active statuses.
 */
export function failedStageForStatus(status: ActiveJobStatus): FailedStage;
export function failedStageForStatus(status: JobStatus): FailedStage | null;
export function failedStageForStatus(status: JobStatus): FailedStage | null {
  switch (status) {
    case 'building':
      return 'build';
    case 'onchain_setup':
      return 'onchain';
    case 'deploying':
      return 'deploy';
    default:
      return null;
  }
}
