import { PRICING, type JobStatus } from '@forge/shared';
import type { JobRecord, LaunchpadRecord } from '../jobs/store';

/*
 * Quotas (docs/DECISIONS.md D3, docs/SECURITY.md §9): included modifications, one modification in
 * progress per launchpad, launchpads per wallet. The included-modification counter itself is
 * consumed by the payment quote (payments/service.ts, compare-and-set): a modification job
 * created here is free when one is left, otherwise quoted at PRICING.modificationUsd.
 */

export const LAUNCHPAD_QUOTAS = {
  /** Launchpads (any status but `disabled`) a wallet may hold. */
  maxLaunchpadsPerWallet: 10,
  /** Modification jobs not yet finished (live / refunded) per launchpad. */
  maxOpenModificationsPerLaunchpad: 1,
  /** Length of a modification request, in characters. */
  maxRequestLength: 4000,
} as const;

/** A job is finished once live or refunded; every other status is still in progress. */
const FINISHED: ReadonlySet<JobStatus> = new Set(['live', 'refunded']);

export function isOpenJob(job: Pick<JobRecord, 'status'>): boolean {
  return !FINISHED.has(job.status);
}

export type ModificationBlockedReason =
  'launchpad_not_live' | 'launchpad_disabled' | 'creation_in_progress' | 'modification_in_progress';

export interface LaunchpadQuotas {
  includedModificationsLeft: number;
  /** Price of a modification once the included ones are used. */
  modificationPriceUsd: number;
  /** The modification job in progress, if any. */
  openModificationJobId: string | null;
  canRequestModification: boolean;
  blockedReason: ModificationBlockedReason | null;
}

export interface WalletQuotas {
  launchpads: { count: number; max: number };
  canCreateLaunchpad: boolean;
}

/** Newest first, ties broken by id (deterministic). */
export function byNewest(a: JobRecord, b: JobRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Oldest first, ties broken by id (deterministic). */
export function byOldest(a: JobRecord, b: JobRecord): number {
  return -byNewest(a, b);
}

export function openModificationJobs(jobs: readonly JobRecord[], launchpadId: string): JobRecord[] {
  return jobs
    .filter((j) => j.launchpadId === launchpadId && j.type === 'modify_launchpad' && isOpenJob(j))
    .sort(byOldest);
}

export function launchpadQuotas(
  launchpad: LaunchpadRecord,
  jobs: readonly JobRecord[],
): LaunchpadQuotas {
  const open = openModificationJobs(jobs, launchpad.id);
  const creation = jobs.find(
    (j) => j.launchpadId === launchpad.id && j.type === 'create_launchpad',
  );
  let blockedReason: ModificationBlockedReason | null = null;
  if (launchpad.status === 'disabled') blockedReason = 'launchpad_disabled';
  else if (launchpad.status !== 'live') blockedReason = 'launchpad_not_live';
  else if (creation && creation.status !== 'live') blockedReason = 'creation_in_progress';
  // A modification still awaiting payment can be rewritten, so it does not block a new request.
  else if (open.some((j) => j.status !== 'spec_ready')) blockedReason = 'modification_in_progress';
  return {
    includedModificationsLeft: Math.max(0, launchpad.includedModificationsLeft),
    modificationPriceUsd: PRICING.modificationUsd,
    openModificationJobId: open[0]?.id ?? null,
    canRequestModification: blockedReason === null,
    blockedReason,
  };
}

/** Launchpads counted against the per-wallet limit (disabled ones are not). */
export function countedLaunchpads(launchpads: readonly LaunchpadRecord[]): number {
  return launchpads.filter((l) => l.status !== 'disabled').length;
}

export function walletQuotas(launchpads: readonly LaunchpadRecord[]): WalletQuotas {
  const count = countedLaunchpads(launchpads);
  const max = LAUNCHPAD_QUOTAS.maxLaunchpadsPerWallet;
  return { launchpads: { count, max }, canCreateLaunchpad: count < max };
}

/**
 * For the creation flow (spec confirmation): true when `wallet` may create one more launchpad.
 * Not yet called by /api/spec/confirm (chat module), which only bounds unpaid drafts.
 */
export function mayCreateLaunchpad(launchpads: readonly LaunchpadRecord[]): boolean {
  return walletQuotas(launchpads).canCreateLaunchpad;
}
