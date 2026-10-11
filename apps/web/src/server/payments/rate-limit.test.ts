// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clientIp, MemoryRateLimiter } from './rate-limit';

describe('MemoryRateLimiter', () => {
  it('allows `limit` hits per window, then resets', () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const rule = { limit: 2, windowMs: 1000 };
    expect(limiter.hit('a', rule).ok).toBe(true);
    expect(limiter.hit('a', rule).ok).toBe(true);
    expect(limiter.hit('a', rule)).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.hit('b', rule).ok).toBe(true);
    now = 1000;
    expect(limiter.hit('a', rule).ok).toBe(true);
  });

  it('keeps a bounded number of keys', () => {
    const limiter = new MemoryRateLimiter(() => 0, 10);
    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`, { limit: 1, windowMs: 60_000 });
    expect(limiter.size).toBeLessThanOrEqual(10);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('http://x/', { headers });

  it('prefers the platform headers, then the last forwarded entry (added by the proxy)', () => {
    expect(
      clientIp(req({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '1.1.1.1' })),
    ).toBe('198.51.100.7');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1' }))).toBe(
      '198.51.100.2',
    );
    // The client controls the start of x-forwarded-for: a spoofed first entry is ignored.
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }))).toBe('10.0.0.1');
    expect(clientIp(req({}))).toBe('unknown');
  });
});
