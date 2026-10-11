/*
 * Rate limits of the RPC relay: weighted token buckets.
 *
 * Every HTTP request costs REQUEST_OVERHEAD unit, then each JSON-RPC call costs its method weight
 * (methods.ts). `sendTransaction` additionally draws from a dedicated, much smaller bucket.
 *
 * Buckets per caller tier (handler.ts). An Origin header is not an identity (any non-browser
 * client can send one), so it never buys a larger per-IP budget:
 * - browser (allowed Origin) and anonymous (no Origin, no token): the SAME per-client-IP bucket
 *   (`ip:<ip>`, IPv6 by /64) + global;
 * - server (valid X-Forge-Relay-Token): per launchpad slug + global (Vercel egress IPs are shared
 *   by every client project, so the client IP is not a meaningful key there).
 * Alert-only buckets (never refuse, only log when exceeded): per origin, and all anonymous
 * traffic. Enforcing them would let anyone drain a site's origin bucket (or the anonymous one)
 * by sending its Origin header, and deny service to its real visitors.
 *
 * `RelayRateLimitStore` is the seam for a shared store (Redis / Upstash with a Lua script doing the
 * same all-or-nothing draw). The in-memory store below is per server instance: on Vercel each
 * instance counts separately, so the effective limits are per instance until a shared store is
 * plugged in.
 */

export interface BucketRule {
  /** Burst size (units). */
  capacity: number;
  /** Sustained rate (units per second). */
  refillPerSecond: number;
}

export interface RelayLimits {
  /** Per client IP, browser and anonymous tiers alike. */
  ip: BucketRule;
  /** Alert-only: logged when one origin exceeds it, never refused. */
  origin: BucketRule;
  server: BucketRule;
  /** Alert-only: logged when all anonymous traffic together exceeds it, never refused. */
  anonymousGlobal: BucketRule;
  /** sendTransaction calls per browser / anonymous caller (client IP). */
  sendPerCaller: BucketRule;
  /** sendTransaction calls per launchpad on the server tier. */
  sendServer: BucketRule;
  global: BucketRule;
}

/** Units charged for every HTTP request, valid or not. */
export const REQUEST_OVERHEAD = 1;
/** Largest number of units one HTTP request may cost (checked before any upstream call). */
export const MAX_REQUEST_COST = 60;
/** Largest number of sendTransaction calls in one HTTP request. */
export const MAX_SENDS_PER_REQUEST = 2;

const perMinute = (units: number, burstSeconds: number): BucketRule => ({
  capacity: Math.max(MAX_REQUEST_COST, Math.round((units / 60) * burstSeconds)),
  refillPerSecond: units / 60,
});

const sendsPerMinute = (sends: number, burst: number): BucketRule => ({
  capacity: Math.max(MAX_SENDS_PER_REQUEST, burst),
  refillPerSecond: sends / 60,
});

/**
 * Defaults, per server instance. A trade on a client site costs about 40-80 units over a minute
 * (quote reads, simulation, send, then status polling); a page view with balance polling a few
 * units per poll. Several visitors can share one IP (mobile carriers), hence the per-IP headroom.
 */
export const DEFAULT_LIMITS: RelayLimits = {
  ip: perMinute(600, 30),
  origin: perMinute(12_000, 30),
  server: perMinute(1_200, 30),
  anonymousGlobal: perMinute(600, 30),
  sendPerCaller: sendsPerMinute(6, 6),
  sendServer: sendsPerMinute(30, 10),
  global: perMinute(60_000, 10),
};

export interface BucketDraw {
  /** Bucket key, e.g. `ip:203.0.113.7`. */
  key: string;
  cost: number;
  rule: BucketRule;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the request could pass (0 when allowed). */
  retryAfterSeconds: number;
  /** Key of the first bucket that refused (for logs; never shown to the caller). */
  refusedBy?: string;
}

export interface RelayRateLimitStore {
  /** All-or-nothing: draws `cost` from every bucket, or from none if one of them is short. */
  take(draws: readonly BucketDraw[]): Promise<RateDecision>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export const MAX_BUCKETS = 50_000;

export class MemoryRateLimitStore implements RelayRateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBuckets = MAX_BUCKETS,
  ) {}

  take(draws: readonly BucketDraw[]): Promise<RateDecision> {
    const now = this.now();
    let retryAfter = 0;
    let refusedBy: string | undefined;
    const current = draws.map((draw) => {
      const tokens = this.level(draw.key, draw.rule, now);
      if (tokens < draw.cost) {
        const missing = Math.min(draw.cost, draw.rule.capacity) - tokens;
        const wait =
          draw.cost > draw.rule.capacity
            ? 60
            : Math.max(1, Math.ceil(missing / draw.rule.refillPerSecond));
        if (wait > retryAfter) retryAfter = wait;
        refusedBy ??= draw.key;
      }
      return tokens;
    });
    if (refusedBy !== undefined) {
      return Promise.resolve({ allowed: false, retryAfterSeconds: retryAfter, refusedBy });
    }
    draws.forEach((draw, i) => {
      this.buckets.delete(draw.key);
      this.buckets.set(draw.key, { tokens: (current[i] ?? 0) - draw.cost, updatedAt: now });
    });
    if (this.buckets.size > this.maxBuckets) this.evict(draws);
    return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  }

  get size(): number {
    return this.buckets.size;
  }

  private level(key: string, rule: BucketRule, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return rule.capacity;
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    return Math.min(rule.capacity, bucket.tokens + elapsed * rule.refillPerSecond);
  }

  /**
   * Insertion order is last-use order (a bucket is re-inserted on every draw): drop the least
   * recently used buckets. A dropped bucket restarts full, which only ever favours the caller,
   * and the oldest ones are the most likely to be full already.
   */
  private evict(keep: readonly BucketDraw[]): void {
    const protectedKeys = new Set(keep.map((d) => d.key));
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxBuckets) break;
      if (!protectedKeys.has(key)) this.buckets.delete(key);
    }
  }
}
