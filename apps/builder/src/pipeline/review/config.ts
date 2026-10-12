import { OPS } from '@forge/shared';

/**
 * Settings of the visual review (second agent pass). Present in `PipelineConfig.review` only when
 * the review is enabled (`BUILDER_VISUAL_REVIEW=on` and a pinned `FORGE_SANDBOX_REVIEW_IMAGE`).
 */
export interface VisualReviewConfig {
  /** Capture run (site server + headless browser, no network). */
  captureTimeoutMs: number;
  captureMemoryMb: number;
  captureCpus: number;
  /** Pass 2 agent: wall-clock cap (also bounded by the time left), turns cap. */
  agentTimeoutMs: number;
  maxTurns: number;
  /**
   * Pass 2 budget: at most this much more than what the job already spent, and never above the
   * job budget (`AgentConfig.budgetUsd`).
   */
  maxBudgetUsd: number;
  /** Below this much left in the job budget, the review is skipped. */
  minBudgetUsd: number;
  /** The worker's hard cap on one job (worker.ts `maxJobMs`, default twice the stale delay). */
  jobTimeoutMs: number;
  /** Kept free after the review for the commit and the preview deployment wait, on top of it. */
  publishMarginMs: number;
  /** Below this much time left after pass 1, the review is skipped. */
  minTimeLeftMs: number;
}

export const REVIEW_DEFAULTS: Readonly<VisualReviewConfig> = {
  captureTimeoutMs: 5 * 60_000,
  captureMemoryMb: 3072,
  captureCpus: 2,
  agentTimeoutMs: 15 * 60_000,
  maxTurns: 60,
  maxBudgetUsd: 5,
  minBudgetUsd: 1,
  jobTimeoutMs: OPS.jobLockStaleMinutes * 2 * 60_000,
  publishMarginMs: 5 * 60_000,
  minTimeLeftMs: 20 * 60_000,
};

/** Smallest agent time worth starting; below, the review is dropped. */
export const MIN_REVIEW_AGENT_MS = 3 * 60_000;
/** Time kept for the pass 2 install and build when the agent's timeout is computed. */
export const REVIEW_BUILD_RESERVE_MS = 10 * 60_000;

export type VisualReviewSetting =
  { enabled: true; config: VisualReviewConfig } | { enabled: false; reason: 'off' | 'no_image' };

/**
 * Reads `BUILDER_VISUAL_REVIEW` (`off` default, `on`). On without a review image: disabled, with
 * a reason the caller logs at startup. Any other value is an error.
 */
export function visualReviewFromEnv(
  env: Record<string, string | undefined>,
  reviewImage: string | null,
): VisualReviewSetting {
  const raw = (env.BUILDER_VISUAL_REVIEW ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return { enabled: false, reason: 'off' };
  if (raw !== 'on') throw new Error('BUILDER_VISUAL_REVIEW must be "on" or "off"');
  if (!reviewImage) return { enabled: false, reason: 'no_image' };
  return { enabled: true, config: { ...REVIEW_DEFAULTS } };
}
