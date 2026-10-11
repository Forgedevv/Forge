// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readLimits } from '../config';
import {
  DEFAULT_LIMITS,
  MAX_REQUEST_COST,
  MAX_SENDS_PER_REQUEST,
  MemoryRateLimitStore,
  type BucketRule,
} from '../limits';

const rule = (capacity: number, refillPerSecond: number): BucketRule => ({
  capacity,
  refillPerSecond,
});

describe('MemoryRateLimitStore', () => {
  it('draws weighted costs and refills over time', async () => {
    let t = 0;
    const store = new MemoryRateLimitStore(() => t);
    const r = rule(10, 1);
    expect((await store.take([{ key: 'a', cost: 7, rule: r }])).allowed).toBe(true);
    const refused = await store.take([{ key: 'a', cost: 5, rule: r }]);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 2, refusedBy: 'a' });
    t = 2000;
    expect((await store.take([{ key: 'a', cost: 5, rule: r }])).allowed).toBe(true);
    // Never above capacity, however long the wait.
    t = 10_000_000;
    expect((await store.take([{ key: 'a', cost: 10, rule: r }])).allowed).toBe(true);
    expect((await store.take([{ key: 'a', cost: 1, rule: r }])).allowed).toBe(false);
  });

  it('is all-or-nothing across buckets', async () => {
    const store = new MemoryRateLimitStore(() => 0);
    const big = rule(100, 1);
    const small = rule(3, 1);
    await store.take([{ key: 'small', cost: 3, rule: small }]);
    const refused = await store.take([
      { key: 'big', cost: 2, rule: big },
      { key: 'small', cost: 2, rule: small },
    ]);
    expect(refused.allowed).toBe(false);
    expect(refused.refusedBy).toBe('small');
    // `big` was not charged by the refused draw.
    expect((await store.take([{ key: 'big', cost: 100, rule: big }])).allowed).toBe(true);
  });

  it('refuses a cost above the capacity with a one-minute retry', async () => {
    const store = new MemoryRateLimitStore(() => 0);
    expect(await store.take([{ key: 'x', cost: 11, rule: rule(10, 1) }])).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      refusedBy: 'x',
    });
  });

  it('bounds its memory by dropping the least recently used buckets', async () => {
    let t = 0;
    const store = new MemoryRateLimitStore(() => t, 100);
    const r = rule(5, 1);
    await store.take([{ key: 'hot', cost: 5, rule: r }]);
    for (let i = 0; i < 300; i++) {
      t += 1;
      await store.take([{ key: `k${i}`, cost: 1, rule: r }]);
      if (i % 50 === 0) await store.take([{ key: 'hot', cost: 0, rule: r }]);
    }
    expect(store.size).toBeLessThanOrEqual(100);
  });
});

describe('limits configuration', () => {
  it('has defaults that let one maximal request through every bucket', () => {
    for (const [name, r] of Object.entries(DEFAULT_LIMITS)) {
      const floor = name.startsWith('send') ? MAX_SENDS_PER_REQUEST : MAX_REQUEST_COST;
      expect(r.capacity, name).toBeGreaterThanOrEqual(floor);
      expect(r.refillPerSecond, name).toBeGreaterThan(0);
    }
    // sendTransaction is far stricter than reads.
    expect(DEFAULT_LIMITS.sendPerCaller.refillPerSecond).toBeLessThan(
      DEFAULT_LIMITS.ip.refillPerSecond / 50,
    );
    // Anonymous callers are stricter than browsers.
    expect(DEFAULT_LIMITS.anonymousIp.refillPerSecond).toBeLessThan(
      DEFAULT_LIMITS.ip.refillPerSecond,
    );
  });

  it('reads per-minute overrides and scales the burst, never below one request', () => {
    const limits = readLimits({
      RPC_RELAY_IP_UNITS_PER_MINUTE: '1200',
      RPC_RELAY_ANONYMOUS_IP_UNITS_PER_MINUTE: '1',
      RPC_RELAY_SENDS_PER_MINUTE: '0.5',
    });
    expect(limits.ip.refillPerSecond).toBeCloseTo(20);
    expect(limits.ip.capacity).toBe(DEFAULT_LIMITS.ip.capacity * 2);
    expect(limits.anonymousIp.capacity).toBe(MAX_REQUEST_COST);
    expect(limits.sendPerCaller.capacity).toBe(MAX_SENDS_PER_REQUEST);
    expect(limits.origin).toEqual(DEFAULT_LIMITS.origin);
  });

  it('refuses invalid overrides', () => {
    expect(() => readLimits({ RPC_RELAY_IP_UNITS_PER_MINUTE: '0' })).toThrow(
      'RPC_RELAY_IP_UNITS_PER_MINUTE must be a positive number',
    );
    expect(() => readLimits({ RPC_RELAY_GLOBAL_UNITS_PER_MINUTE: 'lots' })).toThrow();
  });
});
