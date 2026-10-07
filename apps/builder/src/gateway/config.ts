import type { PricingTable } from './pricing.js';

/**
 * Default pricing table, USD per million tokens (Anthropic first-party API rates).
 *
 * WARNING: these values MUST be checked against the official pricing page
 * (https://www.anthropic.com/pricing / https://platform.claude.com/docs/en/about-claude/pricing)
 * before every deployment and whenever a model is added. A wrong price makes
 * the per-job budget and the daily alert wrong.
 *
 * Its keys are also the default model allowlist of the gateway.
 */
export const DEFAULT_PRICING: PricingTable = {
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    cacheWrite1hPerMTok: 8,
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheWrite1hPerMTok: 4,
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheWrite1hPerMTok: 2,
  },
};

/** Default limits. */
export const GATEWAY_DEFAULTS = {
  /** Claude Code requests carry the whole conversation; 16 MiB leaves room for images. */
  maxBodyBytes: 16 * 1024 * 1024,
  /** Max size of a buffered non-streaming upstream response. */
  maxResponseBytes: 32 * 1024 * 1024,
  /** Whole upstream request, streaming included. */
  upstreamTimeoutMs: 10 * 60 * 1000,
  /**
   * Max `max_tokens` accepted per request. It bounds the worst-case cost of one
   * request, which is reserved before forwarding and charged if the request is cut.
   */
  maxOutputTokens: 64_000,
  /** Fraction of the daily budget at which `onAlert` fires (once per UTC day). */
  dailyAlertRatio: 0.8,
} as const;
