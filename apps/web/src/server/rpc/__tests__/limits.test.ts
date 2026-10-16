// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readLimits } from '../config';
import {
  CALLER_CLASSES,
  CLASS_SHARES,
  classCeiling,
  DEFAULT_GLOBAL_UNITS_PER_MINUTE,
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
    // No separate (and larger) per-IP budget for callers sending an Origin header.
    expect(Object.keys(DEFAULT_LIMITS)).not.toContain('anonymousIp');
  });

  it('reads per-minute overrides and scales the burst, never below one request', () => {
    const limits = readLimits({
      RPC_RELAY_IP_UNITS_PER_MINUTE: '1200',
      RPC_RELAY_ANONYMOUS_UNITS_PER_MINUTE: '1',
      RPC_RELAY_SENDS_PER_MINUTE: '0.5',
    });
    expect(limits.ip.refillPerSecond).toBeCloseTo(20);
    expect(limits.ip.capacity).toBe(DEFAULT_LIMITS.ip.capacity * 2);
    expect(limits.anonymousGlobal.capacity).toBe(MAX_REQUEST_COST);
    expect(limits.sendPerCaller.capacity).toBe(MAX_SENDS_PER_REQUEST);
    expect(limits.origin).toEqual(DEFAULT_LIMITS.origin);
  });

  it('refuses invalid overrides', () => {
    expect(() => readLimits({ RPC_RELAY_IP_UNITS_PER_MINUTE: '0' })).toThrow(
      'RPC_RELAY_IP_UNITS_PER_MINUTE must be a positive number',
    );
    expect(() => readLimits({ RPC_RELAY_GLOBAL_UNITS_PER_MINUTE: 'lots' })).toThrow();
    expect(() => readLimits({ RPC_RELAY_GLOBAL_SITES_UNITS_PER_MINUTE: '-1' })).toThrow(
      'RPC_RELAY_GLOBAL_SITES_UNITS_PER_MINUTE must be a positive number',
    );
  });

  it('splits the global ceiling between the caller classes', () => {
    const d = DEFAULT_LIMITS;
    const perMinute = (r: BucketRule) => r.refillPerSecond * 60;
    const classes = [d.globalForge, d.globalSites, d.globalServer, d.globalAnonymous];
    expect(classes.reduce((sum, r) => sum + perMinute(r), 0)).toBeCloseTo(
      DEFAULT_GLOBAL_UNITS_PER_MINUTE,
    );
    expect(Object.keys(d)).not.toContain('global');
    for (const callerClass of CALLER_CLASSES) {
      expect(perMinute(classCeiling(d, callerClass))).toBeCloseTo(
        DEFAULT_GLOBAL_UNITS_PER_MINUTE * CLASS_SHARES[callerClass],
      );
    }

    // The total is split by the same shares; one class can be set on its own.
    const limits = readLimits({
      RPC_RELAY_GLOBAL_UNITS_PER_MINUTE: '6000',
      RPC_RELAY_GLOBAL_ANONYMOUS_UNITS_PER_MINUTE: '60',
    });
    expect(perMinute(limits.globalForge)).toBeCloseTo(1_500);
    expect(perMinute(limits.globalSites)).toBeCloseTo(3_000);
    expect(perMinute(limits.globalServer)).toBeCloseTo(900);
    expect(perMinute(limits.globalAnonymous)).toBeCloseTo(60);
    expect(limits.globalAnonymous.capacity).toBe(MAX_REQUEST_COST);
    expect(readLimits({ RPC_RELAY_GLOBAL_FORGE_UNITS_PER_MINUTE: '30000' }).globalSites).toEqual(
      d.globalSites,
    );
  });
});
