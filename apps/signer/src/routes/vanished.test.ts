import { describe, expect, it, vi } from 'vitest';
import { ok, refused, setup, useTestKeystore, type Harness } from './harness.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

/** A load-balanced RPC whose confirmed reads come from a node that lags behind. */
function laggingConfirmedReads(h: Harness): string[] {
  const reads: string[] = [];
  const real = h.chain.getAccount.bind(h.chain);
  vi.spyOn(h.chain, 'getAccount').mockImplementation(async (address, commitment, minSlot) => {
    reads.push(`${commitment}:${minSlot ?? '-'}`);
    return commitment === 'confirmed' ? null : real(address, commitment, minSlot);
  });
  return reads;
}

describe('a created account that a read does not show', () => {
  it('re-reads at finalized from a node past the creation slot: a lagging node is no alert', async () => {
    const h = await setup(ks.keystore);
    const first = ok(await h.routes.configs({ jobId: h.jobId }));
    h.chain.advance(100); // both creations finalized
    const reads = laggingConfirmedReads(h);
    expect(ok(await h.routes.configs({ jobId: h.jobId }))).toEqual(first);
    expect(reads.some((r) => /^finalized:\d+$/.test(r))).toBe(true);
    expect(h.alerter.codes()).not.toContain('account_vanished');
    expect(h.chain.built.config).toBe(2); // nothing rebuilt
  });

  it('answers 503 retryable, without an alert, while the creation is not finalized', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    laggingConfirmedReads(h);
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'account_not_final',
    });
    expect(h.alerter.codes()).toEqual([]);
    expect(h.chain.built.config).toBe(2);
  });

  it('answers 503 when the node refuses to read from the required slot', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.chain.advance(100);
    vi.spyOn(h.chain, 'getAccount').mockImplementation(async (_address, commitment) => {
      if (commitment === 'confirmed') return null;
      throw new Error(
        'failed to get info about account: Minimum context slot has not been reached',
      );
    });
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'account_not_final',
    });
    expect(h.alerter.codes()).toEqual([]);
  });

  it('alerts immediately only once the account is proven absent at finalized', async () => {
    const h = await setup(ks.keystore);
    const body = ok(await h.routes.configs({ jobId: h.jobId }));
    h.chain.advance(100);
    h.chain.accounts.delete(body.launchpadConfig); // closed after its creation
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_config_missing_onchain',
    });
    const alert = h.alerter.alerts.find((a) => a.code === 'account_vanished');
    expect(alert?.level).toBe('immediate');
    expect(h.chain.built.config).toBe(2); // never a second config
  });

  it('alerts when the journal says created but the creation never landed', async () => {
    const h = await setup(ks.keystore);
    const body = ok(await h.routes.configs({ jobId: h.jobId }));
    const entry = (await h.journals.configs.get(h.launchpadId))!;
    h.chain.landed.delete(entry.launchpad!.current!.signature);
    h.chain.accounts.delete(body.launchpadConfig);
    h.chain.advance(1_000); // its blockhash is long expired
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_config_missing_onchain',
    });
    expect(h.alerter.codes()).toContain('account_vanished');
  });
});
