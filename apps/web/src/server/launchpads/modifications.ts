import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import { addJobEventSafe } from '../jobs/service';
import type { JobRecord, LaunchpadRecord, RoutesStore } from '../jobs/store';
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
 * There is no database constraint on open modification jobs: after inserting, the job checks
 * that it is the oldest open one; otherwise it deletes itself (still `spec_ready`, never paid)
 * and the older one wins. Every request applies the same ordering, so exactly one survives.
 */

export interface GatingResult {
  enabled: boolean;
  ok: boolean;
}

export interface ModificationsServiceDeps {
  store: RoutesStore;
  logger: RoutesLogger;
  gating: (wallet: string) => Promise<GatingResult>;
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

function inProgress(jobId: string): RouteError {
  return new RouteError(
    409,
    'MODIFICATION_IN_PROGRESS',
    'A modification of this launchpad is already in progress.',
    { jobId },
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
    const text = input.request.trim();
    if (text.length === 0 || text.length > LAUNCHPAD_QUOTAS.maxRequestLength) {
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

    const job = await store.insertModificationJob(launchpad.id, text);
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
