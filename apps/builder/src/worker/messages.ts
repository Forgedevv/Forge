import type { ActiveJobStatus, FailedStage } from '@forge/shared';

/**
 * Client-visible `job_events` messages. They are shown in the chat in real time, so they stay
 * short, friendly and free of internal detail (the detail goes to `jobs.error` after redaction).
 */
export const EVENT_MESSAGES = {
  started: {
    building: 'Starting your build',
    onchain_setup: 'Preparing the on-chain side of your launchpad',
    deploying: 'Deploying your launchpad',
  } satisfies Record<ActiveJobStatus, string>,
  restarted: (attempt: number, max: number) =>
    `Restarting your build (attempt ${attempt} of ${max})`,
  completed: {
    building: 'Preview ready',
    onchain_setup: 'Your transaction is ready to sign',
    deploying: 'Your launchpad is live',
  } satisfies Record<ActiveJobStatus, string>,
  buildRetry: (attempt: number, max: number) =>
    `The build hit a problem, retrying automatically (attempt ${attempt} of ${max} done)`,
  buildFinalFailure: 'We could not build your launchpad. Your payment will be refunded.',
  manualFailure:
    'A step failed after your approval. The FORGE team has been notified and will handle it manually.',
  staleBuild: 'The build stopped unexpectedly',
  staleManual:
    'A step stopped unexpectedly after your approval. The FORGE team has been notified and will handle it manually.',
  interruptedBuild: 'The build was paused for maintenance and will restart shortly',
} as const;

export function failureEventMessage(
  stage: FailedStage,
  attempts: number,
  maxBuildAttempts: number,
): string {
  if (stage !== 'build') return EVENT_MESSAGES.manualFailure;
  return attempts < maxBuildAttempts
    ? EVENT_MESSAGES.buildRetry(attempts, maxBuildAttempts)
    : EVENT_MESSAGES.buildFinalFailure;
}

const MAX_ERROR_LENGTH = 500;

const REDACTIONS: [RegExp, string][] = [
  // Credentials embedded in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // key=value / key: value for sensitive names.
  [
    /\b([\w-]*(?:key|secret|token|password|passphrase|mnemonic|seed|authorization|credential)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2[redacted]',
  ],
  // Well-known token prefixes.
  [/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // Long opaque runs: private keys, signed blobs. Public addresses (<= 44 chars) are kept.
  [/[A-Za-z0-9+/_=-]{64,}/g, '[redacted]'],
];

/** Redacts likely secrets and truncates an error before it is stored in `jobs.error` or logged. */
export function sanitizeError(err: unknown): string {
  let text: string;
  if (err instanceof Error) text = err.message;
  else if (typeof err === 'string') text = err;
  else text = 'unknown error';
  for (const [re, replacement] of REDACTIONS) text = text.replace(re, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) text = 'unknown error';
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}
