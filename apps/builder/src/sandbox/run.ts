/**
 * Sandbox runner: one hardened, disposable container per command
 * (docs/SECURITY.md sections 2 and 4). The code it runs is written by an AI from
 * user input and is treated as hostile:
 *
 * - non-root, read-only root fs, all capabilities dropped, no-new-privileges, the
 *   daemon's default seccomp (and AppArmor) profile, pids/memory/cpu/file-size limits,
 *   no swap, tmpfs /tmp and $HOME (noexec), no docker socket, host mounts limited to
 *   the job folder at /workspace (optionally read-only) and, for a run that produces
 *   files, one separate output folder at /output;
 * - network `none`, or `allowlist` through a per-run egress proxy (network.ts);
 * - wall-clock timeout enforced twice: by the host (docker kill) and inside the
 *   container (`timeout` wrapper), so a crashed worker cannot leave it running;
 * - output capped and redacted; container, proxy and network removed after the run.
 */
import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  assertHardenedSandboxArgs,
  buildSandboxCreateArgs,
  PROXY_CONTAINER_PREFIX,
  SANDBOX_CONTAINER_PREFIX,
  SANDBOX_LABEL,
  SANDBOX_NETWORK_PREFIX,
  type SandboxPlan,
} from './args.js';
import {
  resolveSandboxConfig,
  SANDBOX_DEFAULTS,
  type ResolvedSandboxConfig,
  type SandboxConfig,
} from './config.js';
import { DockerCli, type SpawnFn } from './docker.js';
import { SandboxError } from './errors.js';
import { openEgress, type EgressReport, type EgressSession } from './network.js';
import {
  assertNoHostSecrets,
  assertSafeEnv,
  assertSafeSecrets,
  collectHostSecrets,
  SECRET_ENV,
} from './policy.js';
import { createRedactor, OutputCollector, type Redactor } from './redact.js';
import {
  SandboxRunOptionsSchema,
  type KillReason,
  type ParsedRunOptions,
  type SandboxRunOptions,
  type SandboxRunResult,
} from './types.js';

/** Minimal logger shape, compatible with pino. Never given secret values. */
export interface SandboxLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SandboxDeps {
  spawn?: SpawnFn;
  logger?: SandboxLogger;
  now?: () => number;
  /** Random suffix of the run names (tests). */
  randomSuffix?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides of the kill grace, poll delays and hard output limit (tests). */
  timings?: { killGraceMs?: number; proxyPollMs?: number; hardOutputLimitBytes?: number };
}

export interface SandboxRunner {
  readonly config: ResolvedSandboxConfig;
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Removes sandbox containers and networks whose deadline has passed (worker start-up). */
  cleanupStale(): Promise<{ containers: number; networks: number }>;
}

const NOOP_LOGGER: SandboxLogger = { info() {}, warn() {}, error() {} };

/**
 * Resolves the job folder: it must exist, be a real directory (not a symlink) and be
 * strictly inside the jobs root once every symlink is resolved.
 */
export async function resolveWorkdir(workdir: string, jobsRoot: string): Promise<string> {
  if (!path.isAbsolute(workdir))
    throw new SandboxError('unsafe_option', 'workdir must be absolute');
  let stat;
  try {
    stat = await lstat(workdir);
  } catch {
    throw new SandboxError('invalid_options', 'workdir does not exist');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SandboxError('unsafe_option', 'workdir must be a real directory, not a symlink');
  }
  const [real, root] = await Promise.all([realpath(workdir), realpath(jobsRoot)]);
  const rel = path.relative(root, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError('unsafe_option', 'workdir must be strictly inside the jobs root');
  }
  return real;
}

/**
 * Resolves the output folder like the workdir (real directory strictly inside the jobs root), and
 * checks it is a separate folder: not the workdir, not inside it, not around it.
 */
export async function resolveOutputDir(
  outputDir: string,
  hostWorkdir: string,
  jobsRoot: string,
): Promise<string> {
  const real = await resolveWorkdir(outputDir, jobsRoot);
  const inside = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(hostWorkdir, real) || inside(real, hostWorkdir)) {
    throw new SandboxError('unsafe_option', 'the output folder must be separate from the workdir');
  }
  return real;
}

/** Parses and validates run options; throws `invalid_options` / `unsafe_option`. */
export function parseRunOptions(options: Omit<SandboxRunOptions, 'signal'>): ParsedRunOptions {
  const parsed = SandboxRunOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new SandboxError(
      'invalid_options',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const o = parsed.data;
  const allow = o.allow ?? [];
  if (o.network === 'none' && allow.length > 0) {
    throw new SandboxError('unsafe_option', 'egress presets require network "allowlist"');
  }
  if (o.network === 'allowlist' && allow.length === 0) {
    throw new SandboxError('unsafe_option', 'network "allowlist" requires at least one preset');
  }
  if (new Set(allow).size !== allow.length) {
    throw new SandboxError('invalid_options', 'duplicate egress preset');
  }
  // The review image runs the site and a browser on it: loopback only, never a secret.
  if (o.image === 'review' && (o.network !== 'none' || o.secrets.gatewayToken !== undefined)) {
    throw new SandboxError('unsafe_option', 'the review image runs with no network and no secret');
  }
  assertSafeEnv(o.env);
  assertSafeSecrets(o.secrets, o.network, allow);
  return o;
}

function makeRunId(jobId: string, suffix: string): string {
  return `${jobId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40)}-${suffix}`;
}

interface InspectedState {
  exitCode: number | null;
  oomKilled: boolean;
}

async function inspectState(docker: DockerCli, name: string): Promise<InspectedState | null> {
  const res = await docker.exec(['inspect', '--format={{json .State}}', name]);
  if (res.code !== 0) return null;
  try {
    const state = JSON.parse(res.stdout) as { ExitCode?: unknown; OOMKilled?: unknown };
    return {
      exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
      oomKilled: state.OOMKilled === true,
    };
  } catch {
    return null;
  }
}

export function createSandboxRunner(input: SandboxConfig, deps: SandboxDeps = {}): SandboxRunner {
  const config = resolveSandboxConfig(input);
  const docker = new DockerCli({
    binary: config.dockerBinary,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    hostEnv: config.hostEnv,
  });
  const log = deps.logger ?? NOOP_LOGGER;
  const now = deps.now ?? Date.now;
  const randomSuffix = deps.randomSuffix ?? (() => randomBytes(4).toString('hex'));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const killGraceMs = deps.timings?.killGraceMs ?? SANDBOX_DEFAULTS.killGraceMs;
  const hostSecrets = collectHostSecrets(config.hostEnv, config.extraHostSecrets);

  /** Runs `docker start --attach` and enforces the timeout, output limit and abort signal. */
  function attach(
    name: string,
    o: ParsedRunOptions,
    out: OutputCollector,
    err: OutputCollector,
    signal: AbortSignal | undefined,
  ): Promise<{ cliCode: number | null; killedReason: KillReason | null }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = docker.spawn(['start', '--attach', name]);
      } catch (error) {
        reject(
          new SandboxError(
            'docker_failed',
            `cannot start docker: ${error instanceof Error ? error.message : 'unknown'}`,
          ),
        );
        return;
      }
      let killedReason: KillReason | null = null;
      let graceTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const kill = (reason: KillReason) => {
        if (killedReason !== null || settled) return;
        killedReason = reason;
        log.warn({ container: name, reason }, 'killing sandbox container');
        docker
          .exec(['kill', '--signal=KILL', name])
          .catch(() => undefined)
          .finally(() => {
            // The CLI normally exits once the container is dead; force it otherwise.
            if (!settled) graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
          });
      };
      const hardLimit = deps.timings?.hardOutputLimitBytes ?? SANDBOX_DEFAULTS.hardOutputLimitBytes;
      const onChunk = (collector: OutputCollector) => (chunk: Buffer) => {
        collector.push(chunk);
        if (out.totalBytes + err.totalBytes > hardLimit) kill('output_limit');
      };
      child.stdout?.on('data', onChunk(out));
      child.stderr?.on('data', onChunk(err));
      const timer = setTimeout(() => kill('timeout'), o.timeoutMs);
      const onAbort = () => kill('aborted');
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const finish = () => {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(new SandboxError('docker_failed', `docker start failed: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        finish();
        resolve({ cliCode: code, killedReason });
      });
    });
  }

  async function run(options: SandboxRunOptions): Promise<SandboxRunResult> {
    const { signal, ...rest } = options;
    const o = parseRunOptions(rest);
    const allow = o.allow ?? [];
    assertNoHostSecrets({ env: o.env, command: o.command, secrets: o.secrets, hostSecrets });
    const image = o.image === 'review' ? config.reviewImage : config.image;
    if (!image) throw new SandboxError('invalid_options', 'no review image is configured');
    const hostWorkdir = await resolveWorkdir(o.workdir, config.jobsRoot);
    const hostOutputDir =
      o.outputDir !== undefined
        ? await resolveOutputDir(o.outputDir, hostWorkdir, config.jobsRoot)
        : undefined;
    const redact: Redactor = createRedactor([
      ...hostSecrets.never,
      ...hostSecrets.sensitive,
      o.secrets.gatewayToken,
    ]);

    const runId = makeRunId(o.jobId, randomSuffix());
    const name = `${SANDBOX_CONTAINER_PREFIX}${runId}`;
    const startedAt = now();
    const expiresSec = Math.ceil(
      (startedAt + o.timeoutMs) / 1000 + SANDBOX_DEFAULTS.innerTimeoutSlackSec + 60,
    );
    const labels = {
      [SANDBOX_LABEL]: '1',
      [`${SANDBOX_LABEL}.job`]: o.jobId,
      [`${SANDBOX_LABEL}.run`]: runId,
      [`${SANDBOX_LABEL}.expires`]: String(expiresSec),
    };

    const secretEnv: Record<string, string> = {};
    if (o.secrets.gatewayToken) secretEnv[SECRET_ENV.gatewayToken] = o.secrets.gatewayToken;

    const out = new OutputCollector(o.maxOutputBytes ?? SANDBOX_DEFAULTS.maxOutputBytes);
    const err = new OutputCollector(o.maxOutputBytes ?? SANDBOX_DEFAULTS.maxOutputBytes);
    let egress: EgressSession | null = null;
    let egressReport: EgressReport | null = null;
    let created = false;
    let result: SandboxRunResult;
    try {
      if (o.network === 'allowlist') {
        egress = await openEgress(docker, config, {
          runId,
          allow,
          labels,
          redact,
          sleep,
          ...(deps.timings?.proxyPollMs !== undefined ? { pollMs: deps.timings.proxyPollMs } : {}),
        });
      }
      const plan: SandboxPlan = {
        name,
        labels,
        image,
        uid: config.uid,
        gid: config.gid,
        runtime: config.runtime,
        memoryMb: o.memoryMb,
        cpus: o.cpus,
        pidsLimit: o.pidsLimit ?? SANDBOX_DEFAULTS.pidsLimit,
        network: egress ? { mode: 'allowlist', networkName: egress.networkName } : { mode: 'none' },
        hostWorkdir,
        workspaceReadOnly: o.workspaceReadOnly === true,
        hostOutputDir,
        workingDir: o.workingDir
          ? path.posix.join(SANDBOX_DEFAULTS.workspaceDir, o.workingDir)
          : SANDBOX_DEFAULTS.workspaceDir,
        tmpSizeMb: o.tmpSizeMb ?? SANDBOX_DEFAULTS.tmpSizeMb,
        homeSizeMb: o.homeSizeMb ?? SANDBOX_DEFAULTS.homeSizeMb,
        env: { HOME: SANDBOX_DEFAULTS.homeDir, ...(egress?.env ?? {}), ...o.env },
        secretEnvNames: Object.keys(secretEnv),
        innerTimeoutSec: Math.ceil(o.timeoutMs / 1000) + SANDBOX_DEFAULTS.innerTimeoutSlackSec,
        command: o.command,
      };
      const args = buildSandboxCreateArgs(plan);
      assertHardenedSandboxArgs(args);

      // Secret values only reach the CLI process env, referenced by bare `--env=NAME`.
      const create = await docker.exec(['create', ...args], { env: secretEnv });
      if (create.code !== 0) {
        throw new SandboxError(
          'docker_failed',
          `docker create failed: ${redact(create.stderr).trim().slice(0, 500)}`,
        );
      }
      created = true;
      log.info(
        { container: name, jobId: o.jobId, image: o.image ?? 'sandbox', network: o.network, allow },
        'sandbox started',
      );

      const { cliCode, killedReason: hostKill } = await attach(name, o, out, err, signal);
      const state = await inspectState(docker, name);
      const exitCode = state?.exitCode ?? cliCode;
      // 124: the in-container `timeout` fired.
      let killedReason = hostKill;
      if (killedReason === null && exitCode === 124) killedReason = 'timeout';
      const oomKilled = state?.oomKilled ?? false;
      result = {
        runId,
        ok: exitCode === 0 && killedReason === null && !oomKilled,
        exitCode,
        timedOut: killedReason === 'timeout',
        oomKilled,
        killedReason,
        durationMs: now() - startedAt,
        stdout: out.text(redact),
        stderr: err.text(redact),
        truncated: { stdout: out.truncated, stderr: err.truncated },
        outputBytes: { stdout: out.totalBytes, stderr: err.totalBytes },
        egress: null,
      };
    } finally {
      if (created) {
        const rm = await docker.exec(['rm', '--force', '--volumes', name]).catch(() => undefined);
        if (!rm || rm.code !== 0)
          log.error({ container: name }, 'failed to remove sandbox container');
      }
      if (egress) egressReport = await egress.close().catch(() => null);
    }
    result.egress = egressReport;
    log.info(
      {
        container: name,
        exitCode: result.exitCode,
        killedReason: result.killedReason,
        oomKilled: result.oomKilled,
        durationMs: result.durationMs,
        denied: egressReport?.denied.length ?? 0,
      },
      'sandbox finished',
    );
    return result;
  }

  async function cleanupStale(): Promise<{ containers: number; networks: number }> {
    const nowSec = Math.floor(now() / 1000);
    const expired = (line: string): string | null => {
      const [id, expires] = line.trim().split(/\s+/);
      if (!id || !/^[a-f0-9]{12,64}$/.test(id)) return null;
      const deadline = Number(expires);
      return Number.isFinite(deadline) && deadline > 0 && deadline < nowSec ? id : null;
    };
    const ps = await docker.exec([
      'ps',
      '--all',
      '--no-trunc',
      `--filter=label=${SANDBOX_LABEL}=1`,
      `--format={{.ID}} {{.Label "${SANDBOX_LABEL}.expires"}}`,
    ]);
    const containers = ps.code === 0 ? ps.stdout.split('\n').map(expired).filter(Boolean) : [];
    for (const id of containers) await docker.exec(['rm', '--force', '--volumes', id!]);
    const nets = await docker.exec([
      'network',
      'ls',
      '--no-trunc',
      `--filter=label=${SANDBOX_LABEL}=1`,
      `--format={{.ID}} {{.Label "${SANDBOX_LABEL}.expires"}}`,
    ]);
    const networks = nets.code === 0 ? nets.stdout.split('\n').map(expired).filter(Boolean) : [];
    for (const id of networks) await docker.exec(['network', 'rm', id!]);
    if (containers.length + networks.length > 0) {
      log.warn(
        { containers: containers.length, networks: networks.length },
        'removed stale sandbox resources',
      );
    }
    return { containers: containers.length, networks: networks.length };
  }

  return { config, run, cleanupStale };
}

export { PROXY_CONTAINER_PREFIX, SANDBOX_CONTAINER_PREFIX, SANDBOX_NETWORK_PREFIX };
