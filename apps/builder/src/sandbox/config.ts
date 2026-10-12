/**
 * Operator-level configuration of the sandbox (VPS 1). Nothing here comes from a job:
 * per-run options only pick among these settings.
 */
import path from 'node:path';
import { z } from 'zod';

/** Content-addressed image reference: a registry digest or a local image ID. */
export const PINNED_IMAGE_RE =
  /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[0-9]{1,5}\/[a-z0-9._/-]+)?(?::[A-Za-z0-9_.-]{1,128})?@sha256:[a-f0-9]{64})$/;

export const SANDBOX_DEFAULTS = {
  dockerBinary: 'docker',
  /** `node` user of the official Node image. Never 0. */
  uid: 1000,
  gid: 1000,
  homeDir: '/home/node',
  workspaceDir: '/workspace',
  /** Shared bridge the egress proxies use to reach the internet (ICC disabled). */
  egressNetwork: 'forge-egress-out',
  /** Host interface name of the egress bridge (used by docker/host-firewall.sh). */
  egressBridgeName: 'forge-egress0',
  /** Prefix of the host interface names of the per-run internal networks. */
  sandboxBridgePrefix: 'fsbx',
  /** DNS alias of the proxy on the per-run internal network. */
  proxyAlias: 'forge-egress',
  proxyPort: 3128,
  gatewayForwardPort: 8788,
  pidsLimit: 512,
  tmpSizeMb: 512,
  homeSizeMb: 1024,
  shmSizeMb: 64,
  nofile: 4096,
  /** RLIMIT_FSIZE: largest single file a sandboxed process may write. */
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  /** Kept per stream (head + tail), after redaction. */
  maxOutputBytes: 1024 * 1024,
  /** Total stdout + stderr after which the container is killed. */
  hardOutputLimitBytes: 64 * 1024 * 1024,
  /** Timeout of docker control commands (create, inspect, rm...). */
  controlTimeoutMs: 60_000,
  /** Wait after `docker kill` before the attached CLI is killed too. */
  killGraceMs: 10_000,
  proxyReadyTimeoutMs: 20_000,
  /** The in-container `timeout` fires this long after the host-side timeout. */
  innerTimeoutSlackSec: 15,
  proxy: { memoryMb: 128, cpus: 0.5, pidsLimit: 64, nofile: 4096 },
} as const;

export const SANDBOX_LIMITS = {
  minTimeoutMs: 1_000,
  maxTimeoutMs: 2 * 60 * 60 * 1000,
  minMemoryMb: 128,
  maxMemoryMb: 16_384,
  minCpus: 0.1,
  maxCpus: 8,
  minPids: 16,
  maxPids: 4096,
  maxTmpSizeMb: 8192,
  maxHomeSizeMb: 8192,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;

/**
 * Hosts reachable in `allowlist` mode, per preset. `gateway` is not a host: it is a
 * fixed TCP forward to the AI gateway (see SandboxConfig.gateway).
 *
 * `@forge/core` and `@forge/shared` install from the public npm registry (`npm:@forgedevv/...`
 * aliases, decision D26), so `npm` is the only registry. The `github-packages` preset is kept as
 * a name only, with no host and no operator override: asking for it opens nothing.
 */
export const DEFAULT_EGRESS_HOSTS: Readonly<Record<HostPreset, readonly string[]>> = {
  npm: ['registry.npmjs.org'],
  'github-packages': [],
};

export const EGRESS_PRESETS = ['npm', 'github-packages', 'gateway'] as const;
export type EgressPreset = (typeof EGRESS_PRESETS)[number];
export type HostPreset = Exclude<EgressPreset, 'gateway'>;

export const SANDBOX_RUNTIMES = ['runc', 'runsc'] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export interface GatewayUpstream {
  /**
   * Host of the AI gateway as seen from the proxy container. `host.docker.internal`
   * is mapped to the Docker host (`--add-host ...:host-gateway`).
   */
  host: string;
  port: number;
}

export interface SandboxConfig {
  /** Sandbox image, pinned (`name@sha256:...` or local image ID `sha256:...`). */
  image: string;
  /** Egress proxy image, pinned the same way. */
  proxyImage: string;
  /** Only folders strictly inside this directory can be mounted. */
  jobsRoot: string;
  dockerBinary?: string;
  uid?: number;
  gid?: number;
  /** OCI runtime. `runsc` (gVisor) is recommended in production when installed. */
  runtime?: SandboxRuntime;
  /** AI gateway upstream for the `gateway` preset. Absent: the preset is refused. */
  gateway?: GatewayUpstream | null;
  /** Overrides the hosts of the `npm` preset (operator only); `github-packages` must stay empty. */
  egressHosts?: Partial<Record<HostPreset, readonly string[]>>;
  /** Shared egress bridge name. */
  egressNetwork?: string;
  /**
   * Environment scanned for host secrets (default: process.env). Their values may
   * never enter a container and are redacted from every log.
   */
  hostEnv?: NodeJS.ProcessEnv;
  /** Extra values treated as host secrets. */
  extraHostSecrets?: readonly string[];
}

const HOST_RE =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

const GatewayUpstreamSchema = z.strictObject({
  host: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, 'gateway host must be a host name or an IPv4'),
  port: z.number().int().min(1).max(65535),
});

export const SandboxConfigSchema = z.strictObject({
  image: z.string().regex(PINNED_IMAGE_RE, 'image must be pinned by digest or image ID'),
  proxyImage: z.string().regex(PINNED_IMAGE_RE, 'proxyImage must be pinned by digest or image ID'),
  jobsRoot: z.string().refine((p) => path.isAbsolute(p), 'jobsRoot must be absolute'),
  dockerBinary: z
    .string()
    .min(1)
    .refine((b) => !b.startsWith('-'), 'invalid docker binary')
    .optional(),
  uid: z.number().int().min(1).max(2_147_483_647).optional(),
  gid: z.number().int().min(1).max(2_147_483_647).optional(),
  runtime: z.enum(SANDBOX_RUNTIMES).optional(),
  gateway: GatewayUpstreamSchema.nullable().optional(),
  egressHosts: z
    .strictObject({
      npm: z.array(z.string().regex(HOST_RE)).max(16).optional(),
      // Accepted empty only (a resolved config is fed back in): GitHub Packages stays closed.
      'github-packages': z
        .array(z.string())
        .max(0, 'GitHub Packages is not a registry of FORGE anymore')
        .optional(),
    })
    .optional(),
  egressNetwork: z.string().regex(DOCKER_NAME_RE).optional(),
  hostEnv: z.record(z.string(), z.string().optional()).optional(),
  extraHostSecrets: z.array(z.string()).optional(),
});

export interface ResolvedSandboxConfig {
  image: string;
  proxyImage: string;
  jobsRoot: string;
  dockerBinary: string;
  uid: number;
  gid: number;
  runtime: SandboxRuntime | undefined;
  gateway: GatewayUpstream | null;
  egressHosts: Record<HostPreset, readonly string[]>;
  egressNetwork: string;
  hostEnv: NodeJS.ProcessEnv;
  extraHostSecrets: readonly string[];
}

/** Validates the operator configuration; throws with a readable message. */
export function resolveSandboxConfig(input: SandboxConfig): ResolvedSandboxConfig {
  const parsed = SandboxConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `sandbox config: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  const c = parsed.data;
  return {
    image: c.image,
    proxyImage: c.proxyImage,
    jobsRoot: path.resolve(c.jobsRoot),
    dockerBinary: c.dockerBinary ?? SANDBOX_DEFAULTS.dockerBinary,
    uid: c.uid ?? SANDBOX_DEFAULTS.uid,
    gid: c.gid ?? SANDBOX_DEFAULTS.gid,
    runtime: c.runtime,
    gateway: c.gateway ?? null,
    egressHosts: {
      npm: c.egressHosts?.npm ?? DEFAULT_EGRESS_HOSTS.npm,
      'github-packages': [],
    },
    egressNetwork: c.egressNetwork ?? SANDBOX_DEFAULTS.egressNetwork,
    hostEnv: input.hostEnv ?? process.env,
    extraHostSecrets: c.extraHostSecrets ?? [],
  };
}

function parseHostPort(value: string, name: string): GatewayUpstream {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9.-]*):([0-9]{1,5})$/.exec(value);
  if (!match) throw new Error(`${name} must be host:port`);
  return { host: match[1]!, port: Number(match[2]) };
}

/**
 * Reads the sandbox configuration from the environment:
 * FORGE_SANDBOX_IMAGE, FORGE_SANDBOX_PROXY_IMAGE, FORGE_SANDBOX_JOBS_ROOT (required);
 * FORGE_SANDBOX_GATEWAY_UPSTREAM (host:port), FORGE_SANDBOX_RUNTIME, FORGE_SANDBOX_UID,
 * FORGE_SANDBOX_GID, FORGE_DOCKER_BIN (optional).
 */
export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): ResolvedSandboxConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const optionalInt = (name: string): number | undefined => {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
    return Number(value);
  };
  const runtime = env.FORGE_SANDBOX_RUNTIME;
  const gateway = env.FORGE_SANDBOX_GATEWAY_UPSTREAM;
  return resolveSandboxConfig({
    image: required('FORGE_SANDBOX_IMAGE'),
    proxyImage: required('FORGE_SANDBOX_PROXY_IMAGE'),
    jobsRoot: required('FORGE_SANDBOX_JOBS_ROOT'),
    dockerBinary: env.FORGE_DOCKER_BIN || undefined,
    uid: optionalInt('FORGE_SANDBOX_UID'),
    gid: optionalInt('FORGE_SANDBOX_GID'),
    runtime: runtime ? (runtime as SandboxRuntime) : undefined,
    gateway: gateway ? parseHostPort(gateway, 'FORGE_SANDBOX_GATEWAY_UPSTREAM') : null,
    hostEnv: env,
  });
}
