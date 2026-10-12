import { describe, expect, it } from 'vitest';
import { REVIEW_DEFAULTS, visualReviewFromEnv } from './config.js';

const IMAGE = `sha256:${'c'.repeat(64)}`;

describe('visualReviewFromEnv', () => {
  it('is off by default', () => {
    expect(visualReviewFromEnv({}, IMAGE)).toEqual({ enabled: false, reason: 'off' });
    expect(visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: 'off' }, IMAGE)).toEqual({
      enabled: false,
      reason: 'off',
    });
    expect(visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: '' }, IMAGE).enabled).toBe(false);
  });

  it('turns on with a review image only', () => {
    expect(visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: 'on' }, IMAGE)).toEqual({
      enabled: true,
      config: REVIEW_DEFAULTS,
    });
    expect(visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: 'ON' }, IMAGE).enabled).toBe(true);
    expect(visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: 'on' }, null)).toEqual({
      enabled: false,
      reason: 'no_image',
    });
  });

  it('refuses any other value', () => {
    for (const value of ['true', '1', 'yes', 'maybe']) {
      expect(() => visualReviewFromEnv({ BUILDER_VISUAL_REVIEW: value }, IMAGE)).toThrow(
        /BUILDER_VISUAL_REVIEW/,
      );
    }
  });

  it('fits in the job timeout with the preview deployment wait', () => {
    const d = REVIEW_DEFAULTS;
    // Worst case of the review itself: capture, agent, and the reserve for install + build.
    expect(d.captureTimeoutMs + d.agentTimeoutMs + d.buildReserveMs).toBeLessThan(
      d.jobTimeoutMs - 15 * 60_000 - d.publishMarginMs,
    );
    expect(d.minTimeLeftMs).toBeGreaterThan(d.minAgentMs + d.captureTimeoutMs);
    expect(d.maxBudgetUsd).toBeGreaterThan(d.minBudgetUsd);
  });
});
