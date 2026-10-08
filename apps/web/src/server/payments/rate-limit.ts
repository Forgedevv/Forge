/*
 * Fixed-window rate limiter, in memory. On serverless or multi-instance deployments each instance
 * counts separately, so the effective limit is per instance; the database constraints, not this
 * limiter, are what guarantee that a payment is processed only once.
 */

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, rule: RateLimitRule): RateLimitResult;
}

export const MAX_RATE_LIMIT_KEYS = 20_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_RATE_LIMIT_KEYS,
  ) {}

  hit(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= rule.windowMs) {
      this.windows.delete(key);
      this.evict(now, rule.windowMs);
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.start + rule.windowMs - now) / 1000));
    return { ok: entry.count <= rule.limit, retryAfterSeconds };
  }

  get size(): number {
    return this.windows.size;
  }

  private evict(now: number, windowMs: number): void {
    if (this.windows.size < this.maxKeys) return;
    // Insertion order is window-start order: drop expired windows, then the oldest ones.
    for (const [key, entry] of this.windows) {
      if (this.windows.size < this.maxKeys && now - entry.start < windowMs) break;
      this.windows.delete(key);
    }
  }
}

/** Limits of the payment routes, per wallet and per client IP. */
export const PAYMENT_RATE_LIMITS = {
  quoteWallet: { limit: 10, windowMs: 60_000 },
  quoteIp: { limit: 30, windowMs: 60_000 },
  confirmWallet: { limit: 20, windowMs: 60_000 },
  confirmIp: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Client IP for rate limiting: first `x-forwarded-for` entry (set by Vercel), then `x-real-ip`.
 * Only used as a counter key, never trusted for anything else.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = request.headers.get('x-real-ip')?.trim();
  return real ? real.slice(0, 64) : 'unknown';
}
