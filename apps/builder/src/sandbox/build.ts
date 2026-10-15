/**
 * Local build of the client site in the sandbox, before any push (tasks/04-BUILDER.md).
 *
 * Two runs, least privilege each:
 * 1. install: frozen lockfile, lifecycle scripts and pnpmfile disabled (no code from the
 *    repo runs), network limited to the public npm registry, no secret (`@forge/core` and
 *    `@forge/shared` are public npm aliases, decision D26);
 * 2. build: no network at all and no secret. This is where the agent's code runs.
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SandboxError } from './errors.js';
import { capText } from './redact.js';
import type { SandboxRunner } from './run.js';
import { RELATIVE_PATH_RE, type SandboxRunOptions, type SandboxRunResult } from './types.js';

export type PackageManager = 'pnpm' | 'npm';

export interface BuildStepLimits {
  timeoutMs?: number;
  memoryMb?: number;
  cpus?: number;
  /** Size of the $HOME tmpfs (package manager store and caches); counts against memory. */
  homeSizeMb?: number;
}

export interface BuildSiteOptions {
  jobId: string;
  /** Project folder relative to the workdir (default: the workdir itself). */
  projectDir?: string;
  /** Build output relative to the project folder (default: `.next`). */
  outputDir?: string;
  install?: BuildStepLimits;
  build?: BuildStepLimits;
  /** Max chars of the combined `logs`. */
  maxLogChars?: number;
  signal?: AbortSignal;
}

export type BuildFailedStep = 'prepare' | 'install' | 'build' | 'artifacts';

export interface BuildSiteResult {
  ok: boolean;
  failedStep: BuildFailedStep | null;
  /** Exit code of the last step that ran. */
  exitCode: number | null;
  /** Combined, redacted, truncated logs of the steps. */
  logs: string;
  packageManager: PackageManager | null;
  steps: { install?: SandboxRunResult; build?: SandboxRunResult };
  /** Host path of the build output (a real directory inside the workdir), when ok. */
  artifactsPath: string | null;
}

/**
 * Step timeout in minutes from the environment (1 to 60), else `fallback`. For hosts whose bind
 * mounts are slow (Docker Desktop on Windows writes node_modules through a shared folder: an
 * install of the template took 6 to over 10 minutes there, against about 1 on Linux).
 */
export function stepMinutesFromEnv(
  name: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error(`${name} must be a whole number of minutes from 1 to 60`);
  }
  return minutes;
}

export const BUILD_DEFAULTS = {
  install: {
    timeoutMs: stepMinutesFromEnv('FORGE_SANDBOX_INSTALL_TIMEOUT_MINUTES', 10) * 60 * 1000,
    memoryMb: 4096,
    cpus: 2,
    homeSizeMb: 3072,
  },
  build: {
    timeoutMs: stepMinutesFromEnv('FORGE_SANDBOX_BUILD_TIMEOUT_MINUTES', 15) * 60 * 1000,
    memoryMb: 4096,
    cpus: 2,
    homeSizeMb: 512,
  },
  outputDir: '.next',
  maxLogChars: 256 * 1024,
} as const;

/**
 * Refuses step timeouts that cannot fit in one job: the worker aborts any job past its cap
 * (worker.ts `maxJobMs`), and a building step runs the agent, then the install and the build,
 * and may run both again (the visual review's second pass; otherwise the room left covers the
 * preview deployment wait). So 2 x (install + build) + the agent's timeout must stay within the
 * cap. The review's own agent run is not counted: it is bounded at run time by the time left in
 * the job (review/run-review.ts). Checked at builder startup.
 */
export function assertStepTimeoutsFitJob(input: {
  maxJobMs: number;
  agentTimeoutMs: number;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
}): void {
  const install = input.installTimeoutMs ?? BUILD_DEFAULTS.install.timeoutMs;
  const build = input.buildTimeoutMs ?? BUILD_DEFAULTS.build.timeoutMs;
  const needed = 2 * (install + build) + input.agentTimeoutMs;
  if (needed > input.maxJobMs) {
    const minutes = (ms: number) => Math.ceil(ms / 60_000);
    throw new Error(
      `the sandbox step timeouts do not fit in one job: 2 x (install ${minutes(install)} + build ${minutes(build)}) + agent ${minutes(input.agentTimeoutMs)} = ${minutes(needed)} minutes, above the ${minutes(input.maxJobMs)}-minute limit of a job; lower FORGE_SANDBOX_INSTALL_TIMEOUT_MINUTES or FORGE_SANDBOX_BUILD_TIMEOUT_MINUTES`,
    );
  }
}

/** Commands of each step. No shell; nothing from the repo runs during the install. */
export function buildCommands(pm: PackageManager): { install: string[]; build: string[] } {
  if (pm === 'pnpm') {
    return {
      install: [
        'pnpm',
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
        '--reporter=append-only',
      ],
      build: ['pnpm', 'run', 'build'],
    };
  }
  return {
    install: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    build: ['npm', 'run', 'build'],
  };
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Detects the package manager from the lockfile (a frozen install needs one). */
export async function detectPackageManager(projectPath: string): Promise<PackageManager | null> {
  if (await isRegularFile(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await isRegularFile(path.join(projectPath, 'package-lock.json'))) return 'npm';
  return null;
}

function section(title: string, run: SandboxRunResult): string {
  const status = run.killedReason
    ? `killed (${run.killedReason})`
    : run.oomKilled
      ? 'out of memory'
      : `exit ${run.exitCode}`;
  const denied = run.egress?.denied.length
    ? `\n[egress denied: ${run.egress.denied.map((d) => `${d.host ?? '?'}:${d.port ?? ''} ${d.reason}`).join(', ')}]`
    : '';
  return `== ${title}: ${status} ==\n${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}${denied}\n`;
}

function relativeOrThrow(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '.' || value === '') return undefined;
  if (!RELATIVE_PATH_RE.test(value)) throw new SandboxError('unsafe_option', `${name} is invalid`);
  return value.replace(/\/+$/, '');
}

/** Installs dependencies and builds the site at `workdir` inside the sandbox. */
export async function buildSite(
  runner: SandboxRunner,
  workdir: string,
  options: BuildSiteOptions,
): Promise<BuildSiteResult> {
  const projectDir = relativeOrThrow(options.projectDir, 'projectDir');
  const outputDir = relativeOrThrow(options.outputDir ?? BUILD_DEFAULTS.outputDir, 'outputDir');
  if (!outputDir) throw new SandboxError('unsafe_option', 'outputDir is required');
  const maxLogChars = options.maxLogChars ?? BUILD_DEFAULTS.maxLogChars;
  const projectPath = projectDir ? path.join(workdir, ...projectDir.split('/')) : workdir;
  const steps: BuildSiteResult['steps'] = {};
  const logs: string[] = [];
  const finish = (
    partial: Pick<BuildSiteResult, 'ok' | 'failedStep' | 'exitCode' | 'artifactsPath'> & {
      packageManager: PackageManager | null;
    },
  ): BuildSiteResult => ({ ...partial, steps, logs: capText(logs.join('\n'), maxLogChars) });

  if (!(await isRegularFile(path.join(projectPath, 'package.json')))) {
    logs.push('package.json is missing (or is not a regular file).');
    return finish({
      ok: false,
      failedStep: 'prepare',
      exitCode: null,
      artifactsPath: null,
      packageManager: null,
    });
  }
  const pm = await detectPackageManager(projectPath);
  if (!pm) {
    logs.push(
      'No lockfile (pnpm-lock.yaml or package-lock.json): refusing a non-reproducible install.',
    );
    return finish({
      ok: false,
      failedStep: 'prepare',
      exitCode: null,
      artifactsPath: null,
      packageManager: null,
    });
  }
  const commands = buildCommands(pm);
  const base = {
    jobId: options.jobId,
    workdir,
    ...(projectDir ? { workingDir: projectDir } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const install: SandboxRunOptions = {
    ...base,
    command: commands.install,
    timeoutMs: options.install?.timeoutMs ?? BUILD_DEFAULTS.install.timeoutMs,
    memoryMb: options.install?.memoryMb ?? BUILD_DEFAULTS.install.memoryMb,
    cpus: options.install?.cpus ?? BUILD_DEFAULTS.install.cpus,
    homeSizeMb: options.install?.homeSizeMb ?? BUILD_DEFAULTS.install.homeSizeMb,
    network: 'allowlist',
    allow: ['npm'],
  };
  const installRun = await runner.run(install);
  steps.install = installRun;
  logs.push(section('install', installRun));
  if (!installRun.ok) {
    return finish({
      ok: false,
      failedStep: 'install',
      exitCode: installRun.exitCode,
      artifactsPath: null,
      packageManager: pm,
    });
  }

  const buildMemory = options.build?.memoryMb ?? BUILD_DEFAULTS.build.memoryMb;
  const buildRun = await runner.run({
    ...base,
    command: commands.build,
    timeoutMs: options.build?.timeoutMs ?? BUILD_DEFAULTS.build.timeoutMs,
    memoryMb: buildMemory,
    cpus: options.build?.cpus ?? BUILD_DEFAULTS.build.cpus,
    homeSizeMb: options.build?.homeSizeMb ?? BUILD_DEFAULTS.build.homeSizeMb,
    network: 'none',
    env: {
      NODE_OPTIONS: `--max-old-space-size=${Math.floor(buildMemory * 0.75)}`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  steps.build = buildRun;
  logs.push(section('build', buildRun));
  if (!buildRun.ok) {
    return finish({
      ok: false,
      failedStep: 'build',
      exitCode: buildRun.exitCode,
      artifactsPath: null,
      packageManager: pm,
    });
  }

  // The output was written by hostile code: it must be a real directory inside the workdir.
  const outputPath = path.join(projectPath, ...outputDir.split('/'));
  let artifactsPath: string | null = null;
  try {
    const stat = await lstat(outputPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const [real, root] = await Promise.all([realpath(outputPath), realpath(workdir)]);
      const rel = path.relative(root, real);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) artifactsPath = real;
    }
  } catch {
    artifactsPath = null;
  }
  if (!artifactsPath) {
    logs.push(`Build output ${outputDir} is missing or is not a real directory.`);
    return finish({
      ok: false,
      failedStep: 'artifacts',
      exitCode: buildRun.exitCode,
      artifactsPath: null,
      packageManager: pm,
    });
  }
  return finish({
    ok: true,
    failedStep: null,
    exitCode: buildRun.exitCode,
    artifactsPath,
    packageManager: pm,
  });
}
