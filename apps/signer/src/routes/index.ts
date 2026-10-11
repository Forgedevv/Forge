/**
 * The signer's route handlers (mounted by server.ts, which has already checked the IP, the HMAC
 * signature, the timestamp, the replay cache and the strict `{ jobId }` body).
 *
 * Every handler answers `{ ok: true, body }` or `{ ok: false, status, error }` with a short code:
 * no detail of what failed leaves the signer. Unexpected failures are logged (scrubbed) and
 * alerted; plain refusals (wrong job status, unpaid job...) are only logged.
 */
import type { SignerRouteHandlers, SignerRouteResult } from '../server.js';
import { describeError } from '../jobs/shared.js';
import { handleCreateConfigs } from './configs.js';
import { createRouteRuntime, type RouteRuntime, type SignerRoutesDeps } from './context.js';
import { classifyError } from './errors.js';
import { handlePrepareLaunch } from './launch.js';
import type { SignerHealthReport } from './schemas.js';

export type { SignerRoutesDeps, SignerRoutesConfig, RouteKeystore } from './context.js';
export { createForgeRouteCore, type RouteCore } from './onchain.js';
export { createPostgrestRouteStore, type RouteStore } from './store.js';
export {
  createFileRouteJournals,
  createMemoryRouteJournals,
  type RouteJournals,
} from './journal.js';
export { SignerHealthReport, SignerLaunchPrepareResult } from './schemas.js';
export type { RoutePaymentVerifier } from './payment.js';

/**
 * Refusals that get no generic route alert: retryable states (the builder calls again) and
 * refusals the handler already alerted with a specific code.
 */
const QUIET_CODES = new Set([
  'confirmation_pending',
  'deploys_paused',
  'payment_not_final',
  'launchpad_daily_cap',
]);

async function run<T>(
  rt: RouteRuntime,
  route: string,
  jobId: string,
  fn: () => Promise<T>,
): Promise<SignerRouteResult<T>> {
  try {
    return { ok: true, body: await fn() };
  } catch (err) {
    const c = classifyError(err);
    const fields = { route, jobId, status: c.status, code: c.code, err: describeError(err) };
    if (c.status >= 500) rt.log.error(fields, 'signer route failed');
    else rt.log.warn(fields, 'signer route refused');
    if (c.alert && !QUIET_CODES.has(c.code)) {
      await rt.alert(
        c.status >= 500 ? 'high' : 'normal',
        `route_${c.code}`.slice(0, 64),
        `The signer route ${route} failed (${c.code})`,
        { route, jobId, code: c.code },
        `route:${route}:${jobId}:${c.code}`,
      );
    }
    return { ok: false, status: c.status, error: c.code };
  }
}

export interface SignerRoutesOptions {
  /** Health report (job states). Default: `{ ok: true }`. */
  health?: () => SignerHealthReport | Promise<SignerHealthReport>;
}

export function createSignerRoutes(
  deps: SignerRoutesDeps,
  options: SignerRoutesOptions = {},
): SignerRouteHandlers {
  const rt = createRouteRuntime(deps);
  return {
    configs: (input) => run(rt, 'configs', input.jobId, () => handleCreateConfigs(rt, input.jobId)),
    launchCoinPrepare: (input) =>
      run(rt, 'launch_coin_prepare', input.jobId, () => handlePrepareLaunch(rt, input.jobId)),
    health: async () => {
      try {
        return { ok: true, body: options.health ? await options.health() : { ok: true } };
      } catch (err) {
        rt.log.error({ err: describeError(err) }, 'health report failed');
        return { ok: true, body: { ok: false } };
      }
    },
  };
}
