import { z } from 'zod';
import { EGRESS_PRESETS, SANDBOX_LIMITS } from './config.js';
import type { EgressReport } from './network.js';

/** Job IDs are UUIDs; any short slug is accepted for names and labels. */
export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Relative POSIX path without `..` segments. */
export const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,512}$/;

export const SandboxRunOptionsSchema = z.strictObject({
  jobId: z.string().regex(JOB_ID_RE, 'jobId must be a short slug or a UUID'),
  /** Host folder of the job, strictly inside the configured jobs root. Mounted at /workspace. */
  workdir: z.string().min(1).max(4096),
  /** Working directory relative to /workspace (default: /workspace itself). */
  workingDir: z.string().regex(RELATIVE_PATH_RE).optional(),
  /** argv of the command, executed without a shell. */
  command: z
    .array(
      z
        .string()
        .max(128 * 1024)
        .refine((a) => !a.includes('\u0000'), 'NUL byte'),
    )
    .min(1)
    .max(512),
  /** Non-secret variables. Credential-looking names are refused. */
  env: z.record(z.string(), z.string()).default({}),
  /** The only secrets a container may receive. */
  secrets: z
    .strictObject({
      /** Per-job AI gateway token (ANTHROPIC_AUTH_TOKEN). Needs the `gateway` preset. */
      gatewayToken: z.string().optional(),
      /** Read-only GitHub Packages token (NODE_AUTH_TOKEN). Needs `github-packages`. */
      packagesToken: z.string().optional(),
    })
    .default({}),
  timeoutMs: z.number().int().min(SANDBOX_LIMITS.minTimeoutMs).max(SANDBOX_LIMITS.maxTimeoutMs),
  memoryMb: z.number().int().min(SANDBOX_LIMITS.minMemoryMb).max(SANDBOX_LIMITS.maxMemoryMb),
  cpus: z.number().min(SANDBOX_LIMITS.minCpus).max(SANDBOX_LIMITS.maxCpus),
  pidsLimit: z.number().int().min(SANDBOX_LIMITS.minPids).max(SANDBOX_LIMITS.maxPids).optional(),
  network: z.enum(['none', 'allowlist']),
  /** Egress presets of `allowlist` mode. Required (non-empty) in that mode, refused otherwise. */
  allow: z.array(z.enum(EGRESS_PRESETS)).max(EGRESS_PRESETS.length).optional(),
  /** Kept per stream (head + tail). */
  maxOutputBytes: z.number().int().min(1024).max(SANDBOX_LIMITS.maxOutputBytes).optional(),
  tmpSizeMb: z.number().int().min(16).max(SANDBOX_LIMITS.maxTmpSizeMb).optional(),
  homeSizeMb: z.number().int().min(16).max(SANDBOX_LIMITS.maxHomeSizeMb).optional(),
});

export type SandboxRunOptions = z.input<typeof SandboxRunOptionsSchema> & {
  /** Cancels the run (the container is killed). */
  signal?: AbortSignal;
};
export type ParsedRunOptions = z.output<typeof SandboxRunOptionsSchema>;

export type KillReason = 'timeout' | 'output_limit' | 'aborted';

export interface SandboxRunResult {
  runId: string;
  /** True when the command exited 0 and was not killed. */
  ok: boolean;
  /** Exit code of the command; `null` if unknown. */
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  killedReason: KillReason | null;
  durationMs: number;
  /** Redacted, control characters stripped, head + tail kept. */
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  outputBytes: { stdout: number; stderr: number };
  /** Egress decisions of the proxy (`allowlist` mode only). */
  egress: EgressReport | null;
}
