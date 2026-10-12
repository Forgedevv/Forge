/**
 * Pure builders of the docker CLI arguments, and their safety checks. Every flag is
 * emitted as a single `--name=value` token so `assertHardened*` can verify the final
 * argument list exhaustively right before it is executed: any flag outside an
 * allow-list, or any missing hardening flag, aborts the run.
 */
import {
  PINNED_IMAGE_RE,
  SANDBOX_DEFAULTS,
  SANDBOX_LIMITS,
  type SandboxRuntime,
} from './config.js';
import { SandboxError } from './errors.js';
import { SECRET_ENV, SENSITIVE_NAME_RE } from './policy.js';

export const SANDBOX_LABEL = 'forge.sandbox';
export const SANDBOX_NETWORK_PREFIX = 'forge-sbx-net-';
export const SANDBOX_CONTAINER_PREFIX = 'forge-sbx-';
export const PROXY_CONTAINER_PREFIX = 'forge-egress-';
export const INNER_TIMEOUT_BIN = '/usr/bin/timeout';
/** `timeout` sends TERM at the deadline, then KILL 10 s later. */
const INNER_TIMEOUT_FLAGS = ['--kill-after=10', '--signal=TERM'] as const;

const LABEL_KEY_RE = /^forge\.sandbox(?:\.[a-z]+)?$/;
const LABEL_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CONTAINER_PATH_RE = /^\/[A-Za-z0-9._/-]{0,511}$/;

/** Characters that would break `--mount` parsing or the argument list. */
// eslint-disable-next-line no-control-regex
const UNSAFE_HOST_PATH_RE = /[,"'\n\r\u0000=]/;

export interface SandboxPlan {
  name: string;
  labels: Record<string, string>;
  image: string;
  uid: number;
  gid: number;
  runtime?: SandboxRuntime | undefined;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  network: { mode: 'none' } | { mode: 'allowlist'; networkName: string };
  /** Host folder mounted at /workspace (already validated and resolved). */
  hostWorkdir: string;
  /** Mounts /workspace read-only. */
  workspaceReadOnly?: boolean | undefined;
  /** Host folder mounted read-write at /output (already validated and resolved). */
  hostOutputDir?: string | undefined;
  /** Absolute container path of the working directory (inside /workspace). */
  workingDir: string;
  tmpSizeMb: number;
  homeSizeMb: number;
  /** Non-secret variables, passed as `--env=NAME=value`. */
  env: Record<string, string>;
  /** Secret variables, passed as bare `--env=NAME` (value given to the CLI process only). */
  secretEnvNames: readonly string[];
  /** Deadline of the in-container `timeout` wrapper, in seconds. */
  innerTimeoutSec: number;
  command: readonly string[];
}

function checkName(name: string, what: string): void {
  if (!NAME_RE.test(name)) throw new SandboxError('unsafe_option', `invalid ${what} name`);
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([key, value]) => {
    if (!LABEL_KEY_RE.test(key) || !LABEL_VALUE_RE.test(value)) {
      throw new SandboxError('unsafe_option', `invalid label ${key}`);
    }
    return `--label=${key}=${value}`;
  });
}

function mb(value: number): string {
  return `${Math.floor(value)}m`;
}

/** Arguments of `docker create` for the sandbox container (everything after `create`). */
export function buildSandboxCreateArgs(plan: SandboxPlan): string[] {
  checkName(plan.name, 'container');
  if (!PINNED_IMAGE_RE.test(plan.image)) {
    throw new SandboxError('unsafe_option', 'sandbox image must be pinned by digest');
  }
  if (UNSAFE_HOST_PATH_RE.test(plan.hostWorkdir)) {
    throw new SandboxError('unsafe_option', 'workdir path contains unsupported characters');
  }
  if (plan.hostOutputDir !== undefined && UNSAFE_HOST_PATH_RE.test(plan.hostOutputDir)) {
    throw new SandboxError('unsafe_option', 'output path contains unsupported characters');
  }
  if (
    !CONTAINER_PATH_RE.test(plan.workingDir) ||
    plan.workingDir.split('/').includes('..') ||
    !(
      plan.workingDir === SANDBOX_DEFAULTS.workspaceDir ||
      plan.workingDir.startsWith(`${SANDBOX_DEFAULTS.workspaceDir}/`)
    )
  ) {
    throw new SandboxError('unsafe_option', 'workingDir must be inside /workspace');
  }
  const home = SANDBOX_DEFAULTS.homeDir;
  let network = 'none';
  if (plan.network.mode === 'allowlist') {
    checkName(plan.network.networkName, 'network');
    network = plan.network.networkName;
  }
  const args = [
    `--name=${plan.name}`,
    ...labelArgs(plan.labels),
    '--init',
    '--pull=never',
    `--user=${plan.uid}:${plan.gid}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    `--pids-limit=${plan.pidsLimit}`,
    `--memory=${mb(plan.memoryMb)}`,
    `--memory-swap=${mb(plan.memoryMb)}`,
    `--cpus=${plan.cpus}`,
    `--ulimit=nofile=${SANDBOX_DEFAULTS.nofile}:${SANDBOX_DEFAULTS.nofile}`,
    '--ulimit=core=0',
    `--ulimit=fsize=${SANDBOX_DEFAULTS.maxFileBytes}`,
    '--oom-score-adj=500',
    '--ipc=private',
    '--cgroupns=private',
    `--shm-size=${mb(SANDBOX_DEFAULTS.shmSizeMb)}`,
    '--hostname=sandbox',
    `--network=${network}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${mb(plan.tmpSizeMb)},mode=1777`,
    `--tmpfs=${home}:rw,nosuid,nodev,noexec,size=${mb(plan.homeSizeMb)},uid=${plan.uid},gid=${plan.gid},mode=0700`,
    `--mount=type=bind,source=${plan.hostWorkdir},target=${SANDBOX_DEFAULTS.workspaceDir}${plan.workspaceReadOnly ? ',readonly' : ''}`,
    ...(plan.hostOutputDir !== undefined
      ? [`--mount=type=bind,source=${plan.hostOutputDir},target=${SANDBOX_DEFAULTS.outputDir}`]
      : []),
    `--workdir=${plan.workingDir}`,
    '--log-driver=none',
    '--stop-timeout=5',
    `--entrypoint=${INNER_TIMEOUT_BIN}`,
  ];
  if (plan.runtime) args.push(`--runtime=${plan.runtime}`);
  for (const [name, value] of Object.entries(plan.env)) args.push(`--env=${name}=${value}`);
  for (const name of plan.secretEnvNames) args.push(`--env=${name}`);
  args.push(plan.image);
  // In-container deadline: the container dies even if the host runner crashes.
  args.push(...INNER_TIMEOUT_FLAGS, String(plan.innerTimeoutSec), ...plan.command);
  return args;
}

/** Splits `--name=value` flags from the image and the command. */
function splitFlags(args: readonly string[]): { flags: string[]; image: string; rest: string[] } {
  const index = args.findIndex((a) => !a.startsWith('--'));
  if (index < 0) throw new SandboxError('unsafe_option', 'no image in docker arguments');
  return { flags: args.slice(0, index), image: args[index]!, rest: args.slice(index + 1) };
}

function flagName(flag: string): string {
  const eq = flag.indexOf('=');
  return eq < 0 ? flag : flag.slice(0, eq);
}

function flagValue(flag: string): string {
  const eq = flag.indexOf('=');
  return eq < 0 ? '' : flag.slice(eq + 1);
}

function fail(message: string): never {
  throw new SandboxError('unsafe_option', `hardening check failed: ${message}`);
}

const SANDBOX_ALLOWED_FLAGS = new Set([
  '--name',
  '--label',
  '--init',
  '--pull',
  '--user',
  '--read-only',
  '--cap-drop',
  '--security-opt',
  '--pids-limit',
  '--memory',
  '--memory-swap',
  '--cpus',
  '--ulimit',
  '--oom-score-adj',
  '--ipc',
  '--cgroupns',
  '--shm-size',
  '--hostname',
  '--network',
  '--tmpfs',
  '--mount',
  '--workdir',
  '--log-driver',
  '--stop-timeout',
  '--entrypoint',
  '--runtime',
  '--env',
]);

const SANDBOX_SINGLE_FLAGS = [
  '--name',
  '--user',
  '--pids-limit',
  '--memory',
  '--memory-swap',
  '--cpus',
  '--network',
  '--workdir',
  '--entrypoint',
  '--runtime',
  '--security-opt',
  '--cap-drop',
  '--ipc',
  '--cgroupns',
  '--log-driver',
  '--pull',
];

const REQUIRED_EXACT = [
  '--init',
  '--pull=never',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges=true',
  '--ipc=private',
  '--cgroupns=private',
  '--log-driver=none',
  `--entrypoint=${INNER_TIMEOUT_BIN}`,
  '--ulimit=core=0',
];

function parseUserFlag(value: string): void {
  const m = /^([0-9]+):([0-9]+)$/.exec(value);
  if (!m) fail('--user must be numeric uid:gid');
  if (Number(m[1]) === 0 || Number(m[2]) === 0) fail('the sandbox must not run as root');
}

function parseMb(value: string, name: string): number {
  const m = /^([0-9]+)m$/.exec(value);
  if (!m) fail(`${name} must be in megabytes`);
  return Number(m[1]);
}

function checkTmpfs(value: string, allowedTargets: readonly string[]): void {
  const colon = value.indexOf(':');
  if (colon < 0) fail('tmpfs without options');
  const target = value.slice(0, colon);
  const options = value.slice(colon + 1).split(',');
  if (!allowedTargets.includes(target)) fail(`tmpfs on ${target} is not allowed`);
  for (const required of ['nosuid', 'nodev', 'noexec']) {
    if (!options.includes(required)) fail(`tmpfs ${target} must be ${required}`);
  }
  if (!options.some((o) => /^size=[0-9]+m$/.test(o))) fail(`tmpfs ${target} needs a size`);
  for (const o of options) {
    if (
      !/^(?:rw|nosuid|nodev|noexec|size=[0-9]+m|mode=[0-7]{3,4}|uid=[0-9]+|gid=[0-9]+)$/.test(o)
    ) {
      fail(`tmpfs option ${o} is not allowed`);
    }
  }
}

/** Common checks on every argument token. */
function checkTokens(args: readonly string[]): void {
  for (const a of args) {
    if (a.includes('\u0000')) fail('NUL byte in arguments');
    if (/docker\.sock|containerd\.sock|\/var\/run\/docker|\\\\\.\\pipe\\docker/i.test(a)) {
      fail('the docker socket must never be exposed');
    }
  }
}

/**
 * Verifies the sandbox `docker create` arguments: every hardening flag is present,
 * nothing outside the allow-list is there. Throws `unsafe_option` otherwise.
 */
export function assertHardenedSandboxArgs(args: readonly string[]): void {
  checkTokens(args);
  const { flags, image, rest } = splitFlags(args);
  if (!PINNED_IMAGE_RE.test(image)) fail('image is not pinned by digest');
  for (const flag of flags) {
    if (!SANDBOX_ALLOWED_FLAGS.has(flagName(flag))) fail(`flag ${flagName(flag)} is not allowed`);
  }
  for (const required of REQUIRED_EXACT) {
    if (!flags.includes(required)) fail(`missing ${required}`);
  }
  for (const single of SANDBOX_SINGLE_FLAGS) {
    if (flags.filter((f) => flagName(f) === single).length > 1) fail(`${single} given twice`);
  }
  const get = (name: string): string | undefined => {
    const flag = flags.find((f) => flagName(f) === name);
    return flag === undefined ? undefined : flagValue(flag);
  };
  const user = get('--user');
  if (user === undefined) fail('missing --user');
  parseUserFlag(user);

  const pids = Number(get('--pids-limit'));
  if (!Number.isInteger(pids) || pids < SANDBOX_LIMITS.minPids || pids > SANDBOX_LIMITS.maxPids) {
    fail('missing or invalid --pids-limit');
  }
  const memory = get('--memory');
  const swap = get('--memory-swap');
  if (memory === undefined || swap === undefined) fail('missing --memory / --memory-swap');
  const memoryMb = parseMb(memory, '--memory');
  if (memoryMb < SANDBOX_LIMITS.minMemoryMb || memoryMb > SANDBOX_LIMITS.maxMemoryMb) {
    fail('--memory out of bounds');
  }
  if (parseMb(swap, '--memory-swap') !== memoryMb)
    fail('swap must be disabled (memory-swap = memory)');
  const cpus = Number(get('--cpus'));
  if (!Number.isFinite(cpus) || cpus < SANDBOX_LIMITS.minCpus || cpus > SANDBOX_LIMITS.maxCpus) {
    fail('missing or invalid --cpus');
  }
  const ulimits = flags.filter((f) => flagName(f) === '--ulimit').map(flagValue);
  if (!ulimits.some((u) => /^nofile=[0-9]+:[0-9]+$/.test(u))) fail('missing nofile ulimit');
  if (!ulimits.some((u) => /^fsize=[0-9]+$/.test(u))) fail('missing fsize ulimit');
  for (const u of ulimits) {
    if (!/^(?:nofile=[0-9]+:[0-9]+|core=0|fsize=[0-9]+)$/.test(u))
      fail(`ulimit ${u} is not allowed`);
  }
  const oom = flags.find((f) => flagName(f) === '--oom-score-adj');
  if (oom !== undefined && !(Number(flagValue(oom)) >= 0)) fail('negative --oom-score-adj');

  const network = get('--network');
  if (network === undefined) fail('missing --network');
  if (
    network !== 'none' &&
    !(network.startsWith(SANDBOX_NETWORK_PREFIX) && NAME_RE.test(network))
  ) {
    fail('network must be none or a per-run sandbox network');
  }

  // Mounts: the job workdir at /workspace (exactly one, optionally read-only), and at most one
  // output folder at /output. Nothing else, no other mount option.
  const mounts = flags.filter((f) => flagName(f) === '--mount').map(flagValue);
  const targets = mounts.map((mount) => {
    const parts = mount.split(',');
    const target = parts[2]?.slice('target='.length);
    if (
      (parts.length !== 3 && !(parts.length === 4 && parts[3] === 'readonly')) ||
      parts[0] !== 'type=bind' ||
      !parts[1]!.startsWith('source=') ||
      parts[1]!.length <= 'source='.length ||
      !parts[2]!.startsWith('target=') ||
      (target !== SANDBOX_DEFAULTS.workspaceDir && target !== SANDBOX_DEFAULTS.outputDir)
    ) {
      fail('mounts must be the job workdir at /workspace and an optional output folder at /output');
    }
    return target;
  });
  if (targets.filter((t) => t === SANDBOX_DEFAULTS.workspaceDir).length !== 1) {
    fail('exactly one mount of the job workdir at /workspace is required');
  }
  if (targets.filter((t) => t === SANDBOX_DEFAULTS.outputDir).length > 1) {
    fail('at most one output folder may be mounted');
  }
  const tmpfs = flags.filter((f) => flagName(f) === '--tmpfs').map(flagValue);
  for (const t of tmpfs) checkTmpfs(t, ['/tmp', SANDBOX_DEFAULTS.homeDir]);

  const workdir = get('--workdir');
  if (
    workdir === undefined ||
    workdir.split('/').includes('..') ||
    !(
      workdir === SANDBOX_DEFAULTS.workspaceDir ||
      workdir.startsWith(`${SANDBOX_DEFAULTS.workspaceDir}/`)
    )
  ) {
    fail('--workdir must be inside /workspace');
  }
  const runtime = get('--runtime');
  if (runtime !== undefined && runtime !== 'runc' && runtime !== 'runsc')
    fail('runtime not allowed');
  const secretNames = new Set<string>(Object.values(SECRET_ENV));
  for (const env of flags.filter((f) => flagName(f) === '--env').map(flagValue)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(=?)/.exec(env);
    if (!m) fail('invalid --env');
    const [, name, eq] = m;
    if (eq === '') {
      // Bare name: the value comes from the CLI process env. Only the designated secrets.
      if (!secretNames.has(name!)) fail(`bare --env=${name} is not allowed`);
    } else if (secretNames.has(name!) || SENSITIVE_NAME_RE.test(name!)) {
      fail(`--env=${name} must not carry a credential on the command line`);
    }
  }
  // In-container deadline wrapper.
  if (
    rest[0] !== INNER_TIMEOUT_FLAGS[0] ||
    rest[1] !== INNER_TIMEOUT_FLAGS[1] ||
    !/^[0-9]+$/.test(rest[2] ?? '')
  ) {
    fail('missing in-container timeout');
  }
  if (rest.length < 4) fail('missing command');
}

export interface ProxyPlan {
  name: string;
  labels: Record<string, string>;
  image: string;
  uid: number;
  gid: number;
  egressNetwork: string;
  /** Adds `host.docker.internal:host-gateway` (gateway forward to the Docker host). */
  hostGateway: boolean;
  configJson: string;
}

/** Arguments of `docker create` for the egress proxy container. */
export function buildProxyCreateArgs(plan: ProxyPlan): string[] {
  checkName(plan.name, 'container');
  checkName(plan.egressNetwork, 'network');
  if (!PINNED_IMAGE_RE.test(plan.image)) {
    throw new SandboxError('unsafe_option', 'proxy image must be pinned by digest');
  }
  const p = SANDBOX_DEFAULTS.proxy;
  const args = [
    `--name=${plan.name}`,
    ...labelArgs(plan.labels),
    '--init',
    '--pull=never',
    `--user=${plan.uid}:${plan.gid}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    `--pids-limit=${p.pidsLimit}`,
    `--memory=${mb(p.memoryMb)}`,
    `--memory-swap=${mb(p.memoryMb)}`,
    `--cpus=${p.cpus}`,
    `--ulimit=nofile=${p.nofile}:${p.nofile}`,
    '--ulimit=core=0',
    '--ipc=private',
    '--cgroupns=private',
    '--hostname=egress',
    `--network=${plan.egressNetwork}`,
    '--log-driver=local',
    '--log-opt=max-size=1m',
    '--log-opt=max-file=1',
    '--log-opt=compress=false',
    '--stop-timeout=2',
  ];
  if (plan.hostGateway) args.push('--add-host=host.docker.internal:host-gateway');
  args.push(`--env=FORGE_EGRESS_CONFIG=${plan.configJson}`);
  args.push(plan.image);
  return args;
}

const PROXY_ALLOWED_FLAGS = new Set([
  '--name',
  '--label',
  '--init',
  '--pull',
  '--user',
  '--read-only',
  '--cap-drop',
  '--security-opt',
  '--pids-limit',
  '--memory',
  '--memory-swap',
  '--cpus',
  '--ulimit',
  '--ipc',
  '--cgroupns',
  '--hostname',
  '--network',
  '--log-driver',
  '--log-opt',
  '--stop-timeout',
  '--add-host',
  '--env',
]);

/** Verifies the proxy `docker create` arguments. */
export function assertHardenedProxyArgs(args: readonly string[]): void {
  checkTokens(args);
  const { flags, image, rest } = splitFlags(args);
  if (!PINNED_IMAGE_RE.test(image)) fail('proxy image is not pinned by digest');
  if (rest.length > 0) fail('the proxy command cannot be overridden');
  for (const flag of flags) {
    if (!PROXY_ALLOWED_FLAGS.has(flagName(flag)))
      fail(`proxy flag ${flagName(flag)} is not allowed`);
  }
  for (const required of [
    '--init',
    '--pull=never',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
  ]) {
    if (!flags.includes(required)) fail(`proxy: missing ${required}`);
  }
  const users = flags.filter((f) => flagName(f) === '--user').map(flagValue);
  if (users.length !== 1) fail('proxy: exactly one --user');
  parseUserFlag(users[0]!);
  if (flags.filter((f) => f.startsWith('--security-opt=')).length !== 1) {
    fail('proxy: unexpected --security-opt');
  }
  for (const name of ['--pids-limit', '--memory', '--cpus', '--network']) {
    if (flags.filter((f) => flagName(f) === name).length !== 1) fail(`proxy: exactly one ${name}`);
  }
  const network = flagValue(flags.find((f) => flagName(f) === '--network')!);
  if (['host', 'bridge', 'none', 'default'].includes(network) || network.startsWith('container:')) {
    fail('proxy must use the dedicated egress network');
  }
  for (const h of flags.filter((f) => flagName(f) === '--add-host').map(flagValue)) {
    if (h !== 'host.docker.internal:host-gateway') fail(`proxy --add-host ${h} is not allowed`);
  }
  const envs = flags.filter((f) => flagName(f) === '--env').map(flagValue);
  if (envs.length !== 1 || !envs[0]!.startsWith('FORGE_EGRESS_CONFIG=')) {
    fail('proxy: only FORGE_EGRESS_CONFIG may be set');
  }
}
