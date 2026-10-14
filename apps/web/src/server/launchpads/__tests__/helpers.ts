import { harness as jobsHarness } from '../../jobs/__tests__/fakes';
import { createClaimsService } from '../claims';
import { createLaunchpadsHandlers } from '../handlers';
import { createModificationsService, type GatingResult } from '../modifications';
import { createReactivateService } from '../reactivate';
import { createRetryService } from '../retry';
import { createLaunchpadReads } from '../summary';
import { FakeClaimsChain } from './fake-chain';

export const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);

export function launchpadsHarness(opts: { clientsDomain?: string | null } = {}) {
  const base = jobsHarness();
  const chain = new FakeClaimsChain();
  const gate: { result: GatingResult | Error } = { result: { enabled: false, ok: true } };
  const gating = async (): Promise<GatingResult> => {
    if (gate.result instanceof Error) throw gate.result;
    return gate.result;
  };
  const handlers = createLaunchpadsHandlers({
    reads: createLaunchpadReads({
      store: base.store,
      chain,
      logger: base.logger,
      clientsDomain: opts.clientsDomain === undefined ? 'sites.example.com' : opts.clientsDomain,
    }),
    claims: createClaimsService({ store: base.store, chain, logger: base.logger }),
    modifications: createModificationsService({ store: base.store, logger: base.logger, gating }),
    reactivation: createReactivateService({
      store: base.store,
      logger: base.logger,
      now: () => NOW,
    }),
    retries: createRetryService({
      store: base.store,
      logger: base.logger,
      gating,
      now: () => NOW,
    }),
    rateLimiter: base.rateLimiter,
    logger: base.logger,
  });
  return { ...base, claimsChain: chain, gate, handlers };
}
