/*
 * Sliding-window limiter in memory: a cheap per-instance first line in front of the durable
 * limits (counted from issued tickets in the database), which hold across serverless instances.
 */

export interface WindowRule {
  limit: number;
  windowMs: number;
}

export interface LimitDecision {
  allowed: boolean;
  /** Seconds until a slot frees up (0 when allowed). */
  retryAfterSeconds: number;
}

const MAX_KEYS = 20_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, rule: WindowRule): LimitDecision {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < rule.windowMs);
    if (recent.length >= rule.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: retryAfter(recent[0] ?? t, rule, t) };
    }
    recent.push(t);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Seconds until the oldest hit of a full window leaves it. */
export function retryAfter(oldestMs: number, rule: WindowRule, nowMs: number): number {
  return Math.max(1, Math.ceil((oldestMs + rule.windowMs - nowMs) / 1000));
}
