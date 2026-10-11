import { afterEach, describe, expect, it, vi } from 'vitest';

const record = {
  jobId: '11111111-1111-4111-8111-111111111111',
  paymentId: '22222222-2222-4222-8222-222222222222',
  signature: '5'.repeat(88),
  outcome: 'confirming' as const,
  message: null,
};

afterEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

// Re-importing the module (a simulated reload) can be slow on a busy machine.
describe('sent payment records', { timeout: 30_000 }, () => {
  it('are kept in sessionStorage and survive a page reload', async () => {
    const first = await import('../payments');
    first.saveSentPayment(record);
    expect(JSON.parse(sessionStorage.getItem('forge.payments.sent') ?? '{}')).toEqual({
      [record.jobId]: record,
    });

    vi.resetModules();
    const reloaded = await import('../payments');
    expect(reloaded.getSentPayment(record.jobId)).toEqual(record);
    reloaded.clearSentPayment(record.jobId);
    expect(sessionStorage.getItem('forge.payments.sent')).toBeNull();
  });

  it('ignore a malformed stored value', async () => {
    sessionStorage.setItem('forge.payments.sent', '{"x":{"jobId":1}}');
    const payments = await import('../payments');
    expect(payments.getSentPayment('x')).toBeNull();
  });
});
