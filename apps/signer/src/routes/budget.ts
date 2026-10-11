/**
 * Daily cap on the launchpads the signing routes create accounts for (SIGNER_MAX_LAUNCHPADS_PER_DAY).
 *
 * Every new launchpad costs the payer wallet two config rents and a nonce rent. A bug or a
 * compromise upstream (builder, database) could ask for many of them: past the cap, a launchpad
 * the routes never created anything for is refused (503, alerted) until the next UTC day.
 * Launchpads already admitted (any day) are never counted again, so a retry or the launch of an
 * admitted launchpad always goes through.
 *
 * The admissions of a day are journaled (`route-admission.<YYYY-MM-DD>`) BEFORE the first spend,
 * so a restart never resets the count; a corrupt or unreadable journal stops the route (fail
 * closed). Admissions are serialized by one lock.
 */
import type { RouteRuntime } from './context.js';
import { fail } from './errors.js';
import type { DailyAdmissionsEntry } from './journal.js';

export const DEFAULT_MAX_LAUNCHPADS_PER_DAY = 20;
/** Upper bound of SIGNER_MAX_LAUNCHPADS_PER_DAY (and of one day's journal entry). */
export const MAX_LAUNCHPADS_PER_DAY = 1_000;

/** UTC calendar day of a timestamp, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Admits `launchpadId` for account creations today, or throws 503 `launchpad_daily_cap` (alerted)
 * when the day's cap is reached. Idempotent for a launchpad already admitted today.
 */
export async function admitLaunchpad(rt: RouteRuntime, launchpadId: string): Promise<void> {
  await rt.admissionLock.runExclusive(async () => {
    const day = utcDay(rt.now());
    const current: DailyAdmissionsEntry = (await rt.journals.admissions.get(day)) ?? {
      v: 1,
      day,
      launchpads: [],
    };
    if (current.day !== day) fail(500, 'journal_error');
    if (current.launchpads.includes(launchpadId)) return;
    const cap = rt.maxLaunchpadsPerDay;
    if (current.launchpads.length >= cap) {
      await rt.alert(
        'high',
        'launchpad_daily_cap',
        'The signing routes reached the daily cap of new launchpads: new creations are refused until the next UTC day (raise SIGNER_MAX_LAUNCHPADS_PER_DAY if this volume is expected)',
        { day, cap, launchpadId },
        `launchpad_daily_cap:${day}`,
      );
      fail(503, 'launchpad_daily_cap');
    }
    await rt.journals.admissions.put(day, {
      ...current,
      launchpads: [...current.launchpads, launchpadId],
    });
    rt.log.info(
      { launchpadId, day, admitted: current.launchpads.length + 1, cap },
      'launchpad admitted for account creations',
    );
  });
}
