import { describe, expect, it, vi } from 'vitest';
import { creatorRole } from '../keystore.js';
import { ok, refused, setup, useTestKeystore, type Harness } from './harness.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

/**
 * From the second read on, the job points at another (valid, draft, same owner) launchpad: what
 * a database write between the read outside the lock and the one inside it would look like.
 */
function repointJobAfterFirstRead(h: Harness): string {
  const other = h.addJob();
  const realGetJob = h.store.getJob.bind(h.store);
  let reads = 0;
  vi.spyOn(h.store, 'getJob').mockImplementation(async (id) => {
    const job = await realGetJob(id);
    if (job && id === h.jobId && ++reads >= 2) job.launchpadId = other.launchpadId;
    return job;
  });
  return other.launchpadId;
}

describe('per-launchpad lock', () => {
  it('configs: refuses a job that points at another launchpad inside the lock', async () => {
    const h = await setup(ks.keystore);
    const other = repointJobAfterFirstRead(h);
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_changed',
    });
    expect(h.alerter.codes()).toContain('job_launchpad_changed');
    expect(h.chain.built.config).toBe(0);
    expect(h.chain.calls).not.toContain('verifyPayment');
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();
    expect(await ks.keystore.findRef(creatorRole(other))).toBeUndefined();
    expect(h.store.updates).toHaveLength(0);
  });

  it('prepare: refuses a job that points at another launchpad inside the lock', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    repointJobAfterFirstRead(h);
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_changed',
    });
    expect(h.chain.built.nonce).toBe(0);
    expect(h.chain.built.launch).toBe(0);
    expect(await h.journals.launches.get(h.jobId)).toBeUndefined();
  });
});
