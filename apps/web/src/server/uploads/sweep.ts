import { COMPLETE_WINDOW_SECONDS, SWEEP_GRACE_SECONDS } from './contract';
import { StorageError, type ObjectStorage } from './storage';
import { UploadStoreError, type TicketRecord, type UploadStore } from './store';

/*
 * Cleanup of coin uploads, run from a cron (POST /api/internal/uploads/sweep, sweep-route.ts).
 *
 * A presigned PUT stays usable until it expires (TICKET_TTL_SECONDS), whatever happened to its
 * ticket, and each PUT stages bytes under `pending/`. Once a ticket's URL is dead (plus
 * SWEEP_GRACE_SECONDS), the sweep deletes:
 *   - completed tickets: the staged copy only (the public image and metadata stay);
 *   - rejected tickets: the staged copy (bytes staged again after the rejection) and, defensively,
 *     the public image and metadata keys (never written for a rejected ticket);
 *   - tickets never completed within COMPLETE_WINDOW_SECONDS (plus grace): marked `expired`, then
 *     the staged copy, the public image and the metadata (a `complete` that failed half-way).
 * Every key belongs to exactly one ticket (the mint is unique), deletes are idempotent, and a
 * ticket is marked swept only after all its deletes succeeded, so a failed run is retried.
 *
 * Second guard (configured on the bucket, outside the code): an R2 object lifecycle rule deleting
 * every object under the prefix `pending/` one day after upload (Cloudflare dashboard: R2 >
 * bucket > Settings > Object lifecycle rules > Add rule, prefix `pending/`, "Delete objects"
 * after 1 day; or the S3 PutBucketLifecycleConfiguration call with that rule). Public coin keys
 * (`launchpads/...`) must never be covered by a lifecycle rule.
 */

export interface SweepDeps {
  store: UploadStore;
  storage: ObjectStorage;
  now?: () => number;
  log?: (message: string) => void;
}

export interface SweepOptions {
  /** Tickets read per batch. Default 50. */
  batchSize?: number;
  /** Stop after this many tickets in one run. Default 500. */
  maxTickets?: number;
  /** Stop starting new batches after this long (ms). Default 20 s. */
  budgetMs?: number;
}

export interface SweepReport {
  /** Tickets looked at. */
  scanned: number;
  /** Tickets marked `expired` by this run. */
  expired: number;
  /** Tickets whose objects were all deleted (marked swept). */
  swept: number;
  /** Tickets left for the next run after a storage or database error. */
  failed: number;
  /** True when the run stopped on its ticket or time budget with work possibly left. */
  truncated: boolean;
}

/** Keys the sweep deletes for a ticket in its current status. */
export function sweepKeys(ticket: TicketRecord): string[] {
  if (ticket.status === 'completed') return [ticket.uploadKey];
  return [ticket.uploadKey, ticket.imageKey, ticket.metadataKey];
}

export async function sweepUploads(
  deps: SweepDeps,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(message));
  const batchSize = options.batchSize ?? 50;
  const maxTickets = options.maxTickets ?? 500;
  const budgetMs = options.budgetMs ?? 20_000;
  const startedAt = now();
  const report: SweepReport = { scanned: 0, expired: 0, swept: 0, failed: 0, truncated: false };
  // Tickets that failed in this run are not retried before the next run.
  const skip = new Set<string>();

  for (;;) {
    if (report.scanned >= maxTickets || now() - startedAt >= budgetMs) {
      report.truncated = true;
      break;
    }
    const t = now();
    const batch = (
      await deps.store.listSweepable({
        issuedBefore: new Date(t - (COMPLETE_WINDOW_SECONDS + SWEEP_GRACE_SECONDS) * 1000),
        urlExpiredBefore: new Date(t - SWEEP_GRACE_SECONDS * 1000),
        limit: batchSize + skip.size,
      })
    ).filter((ticket) => !skip.has(ticket.id));
    if (batch.length === 0) break;

    for (const listed of batch.slice(0, Math.min(batchSize, maxTickets - report.scanned))) {
      report.scanned += 1;
      try {
        let ticket: TicketRecord | null = listed;
        if (listed.status === 'issued') {
          ticket = await deps.store.markExpired(listed.id);
          if (ticket === null) continue;
          if (ticket.status === 'expired') report.expired += 1;
        }
        for (const key of sweepKeys(ticket)) await deps.storage.delete(key);
        await deps.store.markSwept(ticket.id, new Date(now()));
        report.swept += 1;
      } catch (error) {
        if (!(error instanceof StorageError) && !(error instanceof UploadStoreError)) throw error;
        skip.add(listed.id);
        report.failed += 1;
        log(`uploads: sweep of upload ${listed.id} failed (${error.message}), retried next run`);
      }
    }
  }
  return report;
}
