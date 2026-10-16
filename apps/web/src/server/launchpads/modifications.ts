import type { CoinImageRehoster } from '../coin-images';
import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import { addJobEventSafe } from '../jobs/service';
import { StoreError, type JobRecord, type LaunchpadRecord, type RoutesStore } from '../jobs/store';
import { requestWithStoredImages, storeChangedImages } from './modification-images';
import { LAUNCHPAD_QUOTAS, launchpadQuotas, openModificationJobs } from './quotas';

/*
 * POST /api/launchpads/:id/modifications `{ conversationId, request }` -> `{ jobId }`
 * (docs/INTERFACES.md §6). Creates the `modify_launchpad` job in `spec_ready`; payment then goes
 * through POST /api/payments/quote, which uses an included modification when one is left
 * (no payment, the job goes straight to `paid`) or quotes PRICING.modificationUsd.
 *
 * Rules: session = owner; launchpad `live` (a sleeping one is reactivated first); its creation
 * finished; the conversation is the owner's design chat attached to this launchpad; the $FORGE
 * gate passes (rechecked before each change, docs/PRODUCT.md); at most one modification in
 * progress. A modification still awaiting payment is rewritten instead of duplicated, so a retry
 * or a changed request never creates a second job.
 *
 * A logo (or coin image) changed in the modification chat is copied into FORGE's bucket before
 * anything is written, and the stored request carries the bucket URL instead of the owner's
 * (modification-images.ts); an image that cannot be copied answers 422 IMAGE_UNAVAILABLE.
 *
 * The database allows one open modification job per launchpad (partial unique index
 * `jobs_one_open_modification_idx`, migration 0007): a concurrent insert fails with a unique
 * violation (23505), answered as MODIFICATION_IN_PROGRESS (or with the winner's job id when it
 * still awaits payment, like an idempotent retry). The app-level checks stay as a second line:
 * after inserting, the job checks that it is the oldest open one; otherwise it deletes itself
 * (still `spec_ready`, never paid) and the older one wins.
 */

export interface GatingResult {
  enabled: boolean;
  ok: boolean;
}

export interface ModificationsServiceDeps {
  store: RoutesStore;
  logger: RoutesLogger;
  gating: (wallet: string) => Promise<GatingResult>;
  /** Image copy into the bucket (coin-images/), created only when an image changed. */
  images: () => CoinImageRehoster;
}

export interface ModificationResult {
  jobId: string;
  created: boolean;
  includedModificationsLeft: number;
  modificationPriceUsd: number;
}

export interface ModificationsService {
  request(input: {
    wallet: string;
    launchpadId: string;
    conversationId: string;
    request: string;
  }): Promise<ModificationResult>;
}

/** Postgres unique violation (the one-open-modification index of migration 0007). */
const UNIQUE_VIOLATION = '23505';

function inProgress(jobId?: string): RouteError {
  return new RouteError(
    409,
    'MODIFICATION_IN_PROGRESS',
    'A modification of this launchpad is already in progress.',
    jobId === undefined ? undefined : { jobId },
  );
}

export function createModificationsService(deps: ModificationsServiceDeps): ModificationsService {
  const { store, logger } = deps;

  function result(
    launchpad: LaunchpadRecord,
    jobs: readonly JobRecord[],
    jobId: string,
    created: boolean,
  ): ModificationResult {
    const quotas = launchpadQuotas(launchpad, jobs);
    return {
      jobId,
      created,
      includedModificationsLeft: quotas.includedModificationsLeft,
      modificationPriceUsd: quotas.modificationPriceUsd,
    };
  }

  async function request(input: {
    wallet: string;
    launchpadId: string;
    conversationId: string;
    request: string;
  }): Promise<ModificationResult> {
    const typed = input.request.trim();
    if (typed.length === 0 || typed.length > LAUNCHPAD_QUOTAS.maxRequestLength) {
      throw new RouteError(
        400,
        'BAD_REQUEST',
        `Describe the change in 1 to ${LAUNCHPAD_QUOTAS.maxRequestLength} characters.`,
      );
    }
    const launchpad = await store.getOwnedLaunchpad(input.launchpadId, input.wallet);
    if (!launchpad) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.launchpad);

    const conversation = await store.getOwnedConversation(input.conversationId, input.wallet);
    if (!conversation) throw new RouteError(404, 'NOT_FOUND', 'Conversation not found.');
    if (conversation.launchpadId !== launchpad.id) {
      throw new RouteError(
        409,
        'CONVERSATION_MISMATCH',
        'This conversation is not about this launchpad.',
      );
    }

    let jobs = await store.listOwnedJobs(input.wallet, [launchpad.id]);
    const quotas = launchpadQuotas(launchpad, jobs);
    switch (quotas.blockedReason) {
      case 'launchpad_disabled':
        throw new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
      case 'launchpad_not_live':
        throw new RouteError(
          409,
          'LAUNCHPAD_NOT_LIVE',
          launchpad.status === 'sleeping'
            ? 'This launchpad is sleeping. Reactivate it before requesting a change.'
            : 'This launchpad is not live yet.',
          { status: launchpad.status },
        );
      case 'creation_in_progress':
        throw new RouteError(409, 'LAUNCHPAD_NOT_LIVE', 'This launchpad is not live yet.');
      case 'modification_in_progress':
        throw inProgress(quotas.openModificationJobId!);
      case null:
        break;
    }

    const gate = await deps.gating(input.wallet);
    if (!gate.ok) {
      throw new RouteError(
        403,
        'GATING_REQUIRED',
        'You need to hold more $FORGE to request a change.',
      );
    }

    // The request as the builder will read it: a changed image points at the bucket copy.
    const images = await storeChangedImages(
      { images: deps.images, logger },
      launchpad.spec,
      conversation.draft,
    );
    const text = requestWithStoredImages(typed, images);
    if (images.length > 0) {
      logger.log('info', 'modification.images_copied', {
        launchpadId: launchpad.id,
        fields: images.map((image) => image.field).join(','),
      });
    }

    // A modification awaiting payment: rewrite its request (idempotent retry or a new wording).
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = openModificationJobs(jobs, launchpad.id)[0];
      if (!pending) break;
      if (pending.status !== 'spec_ready') throw inProgress(pending.id);
      if (pending.request === text) return result(launchpad, jobs, pending.id, false);
      if (await store.updatePendingModificationRequest(pending.id, launchpad.id, text)) {
        logger.log('info', 'modification.updated', {
          jobId: pending.id,
          launchpadId: launchpad.id,
        });
        return result(launchpad, jobs, pending.id, false);
      }
      // It moved on (paid) meanwhile: re-read and decide again.
      jobs = await store.listOwnedJobs(input.wallet, [launchpad.id]);
    }
    const stillOpen = openModificationJobs(jobs, launchpad.id)[0];
    if (stillOpen) throw inProgress(stillOpen.id);

    let job: JobRecord;
    try {
      job = await store.insertModificationJob(launchpad.id, text);
    } catch (error) {
      if (!(error instanceof StoreError) || error.dbCode !== UNIQUE_VIOLATION) throw error;
      // Another request opened a modification first (database-enforced): same answer as the
      // app-level race below.
      const current = await store.listOwnedJobs(input.wallet, [launchpad.id]);
      const open = openModificationJobs(current, launchpad.id)[0];
      logger.log('info', 'modification.insert_conflict', {
        launchpadId: launchpad.id,
        keptJobId: open?.id,
      });
      if (!open || open.status !== 'spec_ready') throw inProgress(open?.id);
      return result(launchpad, current, open.id, false);
    }
    const after = await store.listOwnedJobs(input.wallet, [launchpad.id]);
    const winner = openModificationJobs(after, launchpad.id)[0];
    if (winner && winner.id !== job.id) {
      // A concurrent request inserted first: keep the older job.
      await store.deletePendingModificationJob(job.id, launchpad.id);
      logger.log('info', 'modification.duplicate_removed', {
        jobId: job.id,
        keptJobId: winner.id,
      });
      if (winner.status !== 'spec_ready') throw inProgress(winner.id);
      return result(launchpad, after, winner.id, false);
    }
    logger.log('info', 'modification.created', { jobId: job.id, launchpadId: launchpad.id });
    await addJobEventSafe(store, logger, job.id, 'Modification requested.');
    return result(launchpad, after, job.id, true);
  }

  return { request };
}
