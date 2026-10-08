/*
 * Rate limiting for the design chat. `RateLimiter` is the seam for a shared store (Redis):
 * the in-memory implementation below is per server instance, which is acceptable for now but
 * does not hold across serverless instances.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until a slot frees up (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Records one hit for `key` if fewer than `limit` hits happened in the last `windowMs`. */
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** Takes the single in-flight slot of `key`; returns the release function or null if busy. */
  acquire(key: string): Promise<(() => void) | null>;
}

const MAX_KEYS = 50_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly inflight = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = this.now();
    const since = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= limit) {
      const oldest = list[0] ?? now;
      this.hits.set(key, list);
      return Promise.resolve({
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      });
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.evict(now);
    return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  }

  acquire(key: string): Promise<(() => void) | null> {
    if (this.inflight.has(key)) return Promise.resolve(null);
    this.inflight.add(key);
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      this.inflight.delete(key);
    });
  }

  /** Drops keys whose newest hit is older than a day. */
  private evict(now: number): void {
    const cutoff = now - 24 * 60 * 60_000;
    for (const [key, list] of this.hits) {
      const last = list[list.length - 1];
      if (last === undefined || last < cutoff) this.hits.delete(key);
    }
  }
}

const GLOBAL_KEY = Symbol.for('forge.web.chat.rate-limiter');

/** Process-wide limiter (survives dev hot reloads). */
export function getDefaultRateLimiter(): RateLimiter {
  const g = globalThis as unknown as Record<symbol, RateLimiter | undefined>;
  let limiter = g[GLOBAL_KEY];
  if (!limiter) {
    limiter = new MemoryRateLimiter();
    g[GLOBAL_KEY] = limiter;
  }
  return limiter;
}

/**
 * Client IP behind the hosting proxy. The platform overwrites these headers, so the first value
 * is the real client address. Falls back to "unknown" (one shared bucket).
 */
export function clientIp(request: Request): string {
  const direct = request.headers.get('x-real-ip');
  const forwarded = request.headers.get('x-forwarded-for');
  const value = (forwarded?.split(',')[0] ?? direct ?? '').trim();
  return value === '' ? 'unknown' : value.slice(0, 64);
}
