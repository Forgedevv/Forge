import { afterEach, describe, expect, it, vi } from 'vitest';

const record = {
  jobId: '33333333-3333-4333-8333-333333333333',
  signedTransaction: 'AQID',
  signature: '4'.repeat(88),
};

afterEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

// Re-importing the module (a simulated reload) can be slow on a busy machine.
describe('kept signed launches', { timeout: 30_000 }, () => {
  it('survive a page reload until the server settles them', async () => {
    const first = await import('../launches');
    first.keepLaunch(record);
    vi.resetModules();
    const reloaded = await import('../launches');
    expect(reloaded.getKeptLaunch(record.jobId)).toEqual(record);
    reloaded.forgetLaunch(record.jobId);
    expect(sessionStorage.getItem('forge.launch.signed')).toBeNull();
  });
});
