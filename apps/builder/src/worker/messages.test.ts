import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './config.js';
import { failureEventMessage, sanitizeError } from './messages.js';

describe('sanitizeError', () => {
  it('redacts credentials, bearer tokens and long opaque blobs', () => {
    const blob = 'A'.repeat(90);
    const out = sanitizeError(
      new Error(
        `clone https://user:hunter2@github.com/x failed; Bearer abc.def-ghi; token=zzz; blob ${blob}`,
      ),
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abc.def');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain(blob);
    expect(out).toContain('failed');
  });

  it('keeps public addresses and truncates long messages', () => {
    const address = 'So11111111111111111111111111111111111111112';
    expect(sanitizeError(`bad mint ${address}`)).toContain(address);
    expect(sanitizeError('x '.repeat(1000)).length).toBeLessThanOrEqual(503);
  });

  it('handles non-errors', () => {
    expect(sanitizeError(undefined)).toBe('unknown error');
    expect(sanitizeError('plain')).toBe('plain');
  });
});

describe('failureEventMessage', () => {
  it('distinguishes retry, final build failure and manual handling', () => {
    expect(failureEventMessage('build', 1, 2)).toContain('retrying');
    expect(failureEventMessage('build', 2, 2)).toContain('refunded');
    expect(failureEventMessage('onchain', 1, 2)).toContain('manually');
    expect(failureEventMessage('deploy', 1, 2)).toContain('manually');
  });
});

describe('loadWorkerEnv', () => {
  const base = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };

  it('applies defaults', () => {
    const env = loadWorkerEnv(base);
    expect(env.BUILDER_CONCURRENCY).toBe(1);
    expect(env.BUILDER_POLL_INTERVAL_MS).toBe(5000);
  });

  it('reports only variable names on error', () => {
    expect(() =>
      loadWorkerEnv({ ...base, BUILDER_CONCURRENCY: '99', SUPABASE_URL: 'nope' }),
    ).toThrow(/SUPABASE_URL.*BUILDER_CONCURRENCY|BUILDER_CONCURRENCY.*SUPABASE_URL/);
    try {
      loadWorkerEnv({ ...base, SUPABASE_URL: 'secret-looking-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-looking-value');
    }
  });
});
