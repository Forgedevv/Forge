import type { BuildFailedStep } from '../sandbox/index.js';
import type { Violation } from '../scan/index.js';

/**
 * Errors thrown by the pipeline. The worker stores `message` in `jobs.error` after redaction
 * (worker/messages.ts `sanitizeError`), so messages carry no secret and stay short.
 */

/** A pipeline invariant does not hold (bad data, unexpected state). */
export class PipelineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

/** Short `rule file:line` list, most relevant first, for `jobs.error` and alerts. */
export function summarizeViolations(violations: readonly Violation[], max = 8): string {
  const parts = violations
    .slice(0, max)
    .map((v) => `${v.rule} ${v.file}${v.line !== null ? `:${v.line}` : ''}`);
  const more = violations.length > max ? ` (+${violations.length - max} more)` : '';
  return `${parts.join('; ')}${more}`;
}

/**
 * The agent's changes were refused by the blocking scan (docs/SECURITY.md §1) or by the
 * `forge.config.json` check. Nothing was installed, built, committed or deployed.
 *
 * Retry: the worker contract has no "do not retry" marker, so this fails the build like any other
 * build error and the SQL pickup retries it once (`attempts < 2`) from a clean checkout, scanned
 * again. See the change request in the task report.
 */
export class PolicyViolationError extends Error {
  readonly violations: readonly Violation[];
  constructor(violations: readonly Violation[]) {
    super(
      `scan blocked the changes (${violations.length} violation${violations.length === 1 ? '' : 's'}): ${summarizeViolations(violations)}`,
    );
    this.name = 'PolicyViolationError';
    this.violations = violations;
  }
}

/** The agent run failed (non-zero exit, timeout, error result). */
export class AgentFailedError extends Error {
  /**
   * Operator-only detail (the start of the CLI's own result text), for the builder log. Never part
   * of `message`, which reaches the job record and the client.
   */
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'AgentFailedError';
    this.detail = detail;
  }
}

/** The local install or build of the site failed in the sandbox. */
export class SiteBuildError extends Error {
  readonly step: BuildFailedStep | null;
  constructor(step: BuildFailedStep | null, detail: string) {
    super(`site build failed at the ${step ?? 'unknown'} step${detail ? `: ${detail}` : ''}`);
    this.name = 'SiteBuildError';
    this.step = step;
  }
}
