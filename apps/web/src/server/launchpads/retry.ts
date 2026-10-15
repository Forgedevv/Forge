import { PRICING, type StartAgainBlockedReason } from '@forge/shared';
import { validateConfirmedSpec } from '../chat/spec-draft';
import { DRAFT_POLICY } from '../chat/store';
import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import { addJobEventSafe } from '../jobs/service';
import {
  StoreError,
  type JobPaymentRecord,
  type JobRecord,
  type LaunchpadRecord,
  type RoutesStore,
} from '../jobs/store';
import type { GatingResult } from './modifications';
import { byNewest } from './quotas';

/*
 * POST /api/launchpads/:id/retry -> `{ jobId }` ("start again", docs/INTERFACES.md §6).
 *
 * When both build attempts of a creation fail, the signer refunds the payment and the job ends
 * `refunded`; the launchpad stays a `draft` and keeps its slug. This route gives the owner a NEW
 * `create_launchpad` job in `spec_ready` for that same launchpad, so the same blueprint (name,
 * subdomain, settings: the stored `launchpads.spec`, which the builder reads) can be paid for and
 * built again. The refunded job is left untouched. The request has no body (400 otherwise).
 *
 * Rules (same gates as POST /api/spec/confirm, which creates the first creation job):
 * - session = owner (another wallet gets 404), origin check, rate limits (handlers.ts), private
 *   beta (in the session check), `signups_paused` (fails closed), the $FORGE gate (fails closed);
 * - the launchpad is a `draft`: never a live, sleeping or disabled one;
 * - every creation job of the launchpad is `refunded`, and no on-chain setup was recorded for it
 *   (configs or coin: only a failure after approval gets there, left to the team, D18) ->
 *   NEEDS_SUPPORT otherwise. A creation job that is still open decides instead:
 *   awaiting payment (`spec_ready`) -> its id is returned (idempotent: a retried request, or a
 *   draft that was simply never paid); paid, building ... deploying -> CREATION_IN_PROGRESS;
 *   `failed` at the build step with an automatic retry left -> CREATION_IN_PROGRESS; `failed` at
 *   the build step with no attempt left (the refund is pending) -> REFUND_PENDING; `failed` after
 *   approval (D18: neither retried nor refunded automatically, configs may exist) ->
 *   NEEDS_SUPPORT, for the team to handle;
 * - fewer than START_AGAIN_POLICY.maxRefundedCreations creation jobs were refunded: every attempt
 *   is a full build paid back to the owner, so a blueprint that keeps failing is looked at by the
 *   team first -> NEEDS_SUPPORT;
 * - the stored spec still passes the confirmation checks, for this owner and this slug ->
 *   INVALID_SPEC otherwise;
 * - no money of the refunded attempts is still in flight: a payment still `confirmed` (refund not
 *   recorded) or a payment anomaly not resolved (manual refund, D25) -> REFUND_PENDING; a quote
 *   carrying a signature but not settled, or still inside its window plus DRAFT_POLICY.quoteGraceMs
 *   -> PAYMENT_PENDING. A second payment is never asked for while one may still be owed back.
 *
 * The dashboard decides with the same function (decideStartAgain, summary.ts): `canStartAgain` is
 * true exactly when this route would create a job (the kill switch, the gate and the session
 * apart), and `startAgainBlocked` tells a refunded draft why it cannot be started again yet.
 *
 * Draft policy (DRAFT_POLICY, chat/store.ts): a refunded draft counts as paid there (its job left
 * `spec_ready` and its payment carries a signature), so its slug is never released to someone
 * else and it does not count against the unpaid drafts of the wallet. Starting it again changes
 * neither: no new slug is reserved.
 *
 * The database holds at most one creation job that is not refunded per launchpad (partial unique
 * index of migration 0010): a concurrent request fails its insert with 23505 and gets the winner.
 */

export const START_AGAIN_POLICY = {
  /**
   * Refunded creation jobs after which the owner can no longer start a draft again alone: the
   * team looks at a blueprint that failed that many times (NEEDS_SUPPORT).
   */
  maxRefundedCreations: 3,
} as const;

export interface RetryServiceDeps {
  store: RoutesStore;
  logger: RoutesLogger;
  gating: (wallet: string) => Promise<GatingResult>;
  now?: () => number;
}

export interface RetryResult {
  jobId: string;
  /** True when this call created the job (201), false when it already existed (200). */
  created: boolean;
}

export interface RetryService {
  retry(input: { wallet: string; launchpadId: string }): Promise<RetryResult>;
}

export type StartAgainBlock =
  | 'launchpad_disabled'
  | 'launchpad_not_draft'
  | 'no_creation'
  | 'creation_in_progress'
  | 'refund_pending'
  | 'needs_support'
  | 'attempts_exhausted';

/** Where the creation of a launchpad stands, from its jobs only (no payment read). */
export type CreationState =
  /** Every creation job was refunded: a new one may be created (spec and payments permitting). */
  | { kind: 'start_again' }
  /** A creation job awaits payment: that one is the answer. */
  | { kind: 'awaiting_payment'; job: JobRecord }
  | { kind: 'blocked'; reason: StartAgainBlock; job: JobRecord | null };

/** Every reason "start again" is refused for: the jobs, the stored spec, then the payments. */
export type StartAgainRefusal = StartAgainBlock | 'invalid_spec' | 'payment_pending';

/** The full decision: what the route answers, and what the dashboard offers. */
export type StartAgainDecision =
  | { kind: 'start_again' }
  | { kind: 'awaiting_payment'; job: JobRecord }
  | { kind: 'blocked'; reason: StartAgainRefusal; job: JobRecord | null };

/** Postgres unique violation (the open-creation index of migration 0010). */
const UNIQUE_VIOLATION = '23505';

function busyReason(job: JobRecord): StartAgainBlock {
  if (job.status !== 'failed') return 'creation_in_progress';
  if (job.failedStage !== 'build') return 'needs_support';
  return job.attempts < PRICING.maxAttemptsBeforeRefund ? 'creation_in_progress' : 'refund_pending';
}

type CreationLaunchpad = Pick<
  LaunchpadRecord,
  'id' | 'status' | 'launchpadConfig' | 'launchpadCoinConfig' | 'launchpadCoinMint'
>;

type DecisionLaunchpad = CreationLaunchpad & Pick<LaunchpadRecord, 'spec' | 'slug' | 'ownerWallet'>;

function creationJobs(launchpadId: string, jobs: readonly JobRecord[]): JobRecord[] {
  return jobs
    .filter((j) => j.launchpadId === launchpadId && j.type === 'create_launchpad')
    .sort(byNewest);
}

export function creationState(
  launchpad: CreationLaunchpad,
  jobs: readonly JobRecord[],
): CreationState {
  if (launchpad.status === 'disabled') {
    return { kind: 'blocked', reason: 'launchpad_disabled', job: null };
  }
  if (launchpad.status !== 'draft') {
    return { kind: 'blocked', reason: 'launchpad_not_draft', job: null };
  }
  const creations = creationJobs(launchpad.id, jobs);
  if (creations.length === 0) return { kind: 'blocked', reason: 'no_creation', job: null };
  const open = creations.filter((j) => j.status !== 'refunded');
  const busy = open.find((j) => j.status !== 'spec_ready');
  if (busy) return { kind: 'blocked', reason: busyReason(busy), job: busy };
  if (open[0]) return { kind: 'awaiting_payment', job: open[0] };
  // Configs or a coin from an earlier attempt: the on-chain setup started, so the creation is a
  // failure after approval (D18), refunded by hand at most. Never started again automatically.
  if (
    launchpad.launchpadConfig !== null ||
    launchpad.launchpadCoinConfig !== null ||
    launchpad.launchpadCoinMint !== null
  ) {
    return { kind: 'blocked', reason: 'needs_support', job: creations[0] ?? null };
  }
  if (creations.length >= START_AGAIN_POLICY.maxRefundedCreations) {
    return { kind: 'blocked', reason: 'attempts_exhausted', job: creations[0] ?? null };
  }
  return { kind: 'start_again' };
}

/** The stored spec still passes the confirmation checks, for this owner and this slug. */
export function storedSpecValid(
  launchpad: Pick<LaunchpadRecord, 'spec' | 'slug' | 'ownerWallet'>,
): boolean {
  const checked = validateConfirmedSpec(launchpad.spec);
  return (
    checked.ok &&
    checked.spec.slug === launchpad.slug &&
    checked.spec.ownerWallet === launchpad.ownerWallet
  );
}

/**
 * Money of the refunded attempts that is not settled yet, if any. `now` in ms.
 * - refund_pending: a payment still `confirmed` (or carrying a refund signature without being
 *   `refunded`), or a payment anomaly waiting for its manual refund;
 * - payment_pending: a quote with a signature but not settled, or a quote that may still be paid
 *   or confirmed (inside its window plus DRAFT_POLICY.quoteGraceMs).
 */
export function unsettledPayment(
  payments: readonly JobPaymentRecord[],
  openAnomalies: number,
  now: number,
): 'refund_pending' | 'payment_pending' | null {
  if (openAnomalies > 0) return 'refund_pending';
  const owedBack = payments.some(
    (p) => p.status === 'confirmed' || (p.refundSignature !== null && p.status !== 'refunded'),
  );
  if (owedBack) return 'refund_pending';
  const open = payments.some((p) => {
    if (p.status !== 'quoted') return false;
    if (p.txSignature !== null) return true;
    const expiresAt = Date.parse(p.quoteExpiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > now - DRAFT_POLICY.quoteGraceMs;
  });
  return open ? 'payment_pending' : null;
}

/**
 * Whether the owner may start this launchpad again now: its jobs, then its stored spec, then the
 * money of its creation jobs (read only when the rest allows it). The kill switch, the $FORGE
 * gate and the session are the route's alone. `now` in ms.
 */
export async function decideStartAgain(
  store: Pick<RoutesStore, 'listJobPayments' | 'countOpenPaymentAnomalies'>,
  wallet: string,
  launchpad: DecisionLaunchpad,
  jobs: readonly JobRecord[],
  now: number,
): Promise<StartAgainDecision> {
  const state = creationState(launchpad, jobs);
  if (state.kind !== 'start_again') return state;
  if (!storedSpecValid(launchpad)) return { kind: 'blocked', reason: 'invalid_spec', job: null };
  const creationIds = creationJobs(launchpad.id, jobs).map((j) => j.id);
  const [payments, anomalies] = await Promise.all([
    store.listJobPayments(wallet, creationIds),
    store.countOpenPaymentAnomalies(wallet, creationIds),
  ]);
  const unsettled = unsettledPayment(payments, anomalies, now);
  return unsettled ? { kind: 'blocked', reason: unsettled, job: null } : { kind: 'start_again' };
}

/**
 * Why a refunded draft cannot be started again yet, for the dashboard. Null when it can, when the
 * launchpad is not a refunded draft, or when a creation job is still open (its tracker explains).
 */
export function startAgainBlockedReason(
  decision: StartAgainDecision,
): StartAgainBlockedReason | null {
  if (decision.kind !== 'blocked') return null;
  if (decision.job !== null && decision.job.status !== 'refunded') return null;
  switch (decision.reason) {
    case 'refund_pending':
    case 'payment_pending':
    case 'needs_support':
    case 'invalid_spec':
      return decision.reason;
    case 'attempts_exhausted':
      return 'needs_support';
    default:
      return null;
  }
}

function blockedError(reason: StartAgainRefusal, job: JobRecord | null, status?: string) {
  const withJob = job ? { jobId: job.id } : {};
  switch (reason) {
    case 'launchpad_disabled':
      return new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
    case 'launchpad_not_draft':
      return new RouteError(
        409,
        'INVALID_STATUS',
        'Only a launchpad that never went live can be started again.',
        { status: status ?? null },
      );
    case 'no_creation':
      return new RouteError(
        409,
        'INVALID_STATUS',
        'There is no refunded creation to start again for this launchpad.',
        { status: status ?? null },
      );
    case 'creation_in_progress':
      return new RouteError(
        409,
        'CREATION_IN_PROGRESS',
        'This launchpad is already being created.',
        withJob,
      );
    case 'needs_support':
      return new RouteError(
        409,
        'NEEDS_SUPPORT',
        'The last attempt needs a check by our team. Please contact support before starting again.',
        withJob,
      );
    case 'attempts_exhausted':
      return new RouteError(
        409,
        'NEEDS_SUPPORT',
        `This launchpad was refunded ${START_AGAIN_POLICY.maxRefundedCreations} times. Please contact support before starting it again.`,
        withJob,
      );
    case 'invalid_spec':
      return new RouteError(
        409,
        'INVALID_SPEC',
        'This blueprint no longer passes our checks. Please design the launchpad again in a new conversation.',
      );
    case 'refund_pending':
      return new RouteError(
        409,
        'REFUND_PENDING',
        'The refund of the last attempt is not complete yet. You can start again once it is.',
        withJob,
      );
    case 'payment_pending':
      return new RouteError(
        409,
        'PAYMENT_PENDING',
        'A payment for this launchpad is still being processed. Please wait before starting again.',
      );
  }
}

export function createRetryService(deps: RetryServiceDeps): RetryService {
  const { store, logger } = deps;
  const now = deps.now ?? Date.now;

  async function retry(input: { wallet: string; launchpadId: string }): Promise<RetryResult> {
    const { wallet } = input;
    // Same order as the spec confirmation. An unreadable flag throws: answered 503 (fail closed).
    if (await store.getFlag('signups_paused')) {
      throw new RouteError(403, 'SIGNUPS_PAUSED', 'New signups are temporarily paused.');
    }
    const gate = await deps.gating(wallet);
    if (!gate.ok) {
      throw new RouteError(
        403,
        'GATING_REQUIRED',
        'You need to hold more $FORGE to start this launchpad again.',
      );
    }

    const launchpad = await store.getOwnedLaunchpad(input.launchpadId, wallet);
    if (!launchpad) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.launchpad);
    const jobs = await store.listOwnedJobs(wallet, [launchpad.id]);
    const decision = await decideStartAgain(store, wallet, launchpad, jobs, now());
    if (decision.kind === 'awaiting_payment') return { jobId: decision.job.id, created: false };
    if (decision.kind === 'blocked') {
      // The builder builds from the stored spec: one that no longer passes is worth a warning.
      if (decision.reason === 'invalid_spec') {
        logger.log('warn', 'retry.invalid_spec', { launchpadId: launchpad.id });
      } else {
        logger.log('info', 'retry.refused', { launchpadId: launchpad.id, reason: decision.reason });
      }
      throw blockedError(decision.reason, decision.job, launchpad.status);
    }

    let job: JobRecord;
    try {
      job = await store.insertCreationJob(launchpad.id);
    } catch (error) {
      if (!(error instanceof StoreError) || error.dbCode !== UNIQUE_VIOLATION) throw error;
      // A concurrent request created it first (database-enforced): answer like it did.
      const current = creationState(launchpad, await store.listOwnedJobs(wallet, [launchpad.id]));
      logger.log('info', 'retry.insert_conflict', {
        launchpadId: launchpad.id,
        state: current.kind,
      });
      if (current.kind === 'awaiting_payment') return { jobId: current.job.id, created: false };
      if (current.kind === 'blocked') {
        throw blockedError(current.reason, current.job, launchpad.status);
      }
      throw blockedError('creation_in_progress', null);
    }
    logger.log('info', 'retry.created', { jobId: job.id, launchpadId: launchpad.id });
    await addJobEventSafe(store, logger, job.id, 'Started again with the same blueprint.');
    return { jobId: job.id, created: true };
  }

  return { retry };
}
