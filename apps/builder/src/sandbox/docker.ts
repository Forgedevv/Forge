/**
 * Thin wrapper around the docker CLI. The CLI runs with a minimal environment built
 * from scratch: host secrets are never inherited by it (a bare `-e NAME` would
 * otherwise copy a host value into a container).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { SANDBOX_DEFAULTS } from './config.js';
import { SandboxError } from './errors.js';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Host variables the docker CLI needs to find its daemon, context and plugins. */
const CLI_ENV_PASSTHROUGH = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
]);

export interface DockerExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DockerExecOptions {
  timeoutMs?: number;
  /** Extra variables for the CLI process (values referenced by bare `--env=NAME`). */
  env?: Record<string, string>;
  /** Captured bytes per stream. */
  maxBytes?: number;
}

export class DockerCli {
  readonly binary: string;
  private readonly spawnFn: SpawnFn;
  private readonly hostEnv: NodeJS.ProcessEnv;

  constructor(options: { binary: string; spawn?: SpawnFn; hostEnv?: NodeJS.ProcessEnv }) {
    this.binary = options.binary;
    this.spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.hostEnv = options.hostEnv ?? process.env;
  }

  /** Minimal environment of the CLI process. */
  cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(this.hostEnv)) {
      if (typeof value === 'string' && CLI_ENV_PASSTHROUGH.has(name.toUpperCase())) {
        env[name] = value;
      }
    }
    for (const [name, value] of Object.entries(extra)) {
      if (CLI_ENV_PASSTHROUGH.has(name.toUpperCase())) {
        throw new SandboxError('unsafe_option', `cannot override ${name} of the docker CLI`);
      }
      env[name] = value;
    }
    return env;
  }

  /** Starts the CLI with piped stdout/stderr. */
  spawn(args: readonly string[], env: Record<string, string> = {}): ChildProcess {
    return this.spawnFn(this.binary, args, {
      env: this.cliEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  }

  /** Runs a short control command and captures its output. Never throws on exit code. */
  exec(args: readonly string[], options: DockerExecOptions = {}): Promise<DockerExecResult> {
    const timeoutMs = options.timeoutMs ?? SANDBOX_DEFAULTS.controlTimeoutMs;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(args, options.env);
      } catch (error) {
        reject(
          new SandboxError(
            'docker_failed',
            `cannot start docker: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        );
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (outBytes < maxBytes) out.push(chunk.subarray(0, maxBytes - outBytes));
        outBytes += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (errBytes < maxBytes) err.push(chunk.subarray(0, maxBytes - errBytes));
        errBytes += chunk.length;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SandboxError('docker_failed', `docker failed to start: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: timedOut ? null : code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
        });
      });
    });
  }
}
