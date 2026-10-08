/**
 * Network of a sandbox run in `allowlist` mode (docs/SECURITY.md section 4):
 *
 *   sandbox ──(per-run --internal network, no host IP, no route)──► egress proxy ──► internet
 *                                                                     (shared egress bridge, ICC off)
 *
 * - The per-run network is `--internal` and its bridge has no IPv4 on the host
 *   (`inhibit_ipv4`): the sandbox can reach the proxy container and nothing else
 *   (not the host, not other jobs, not the metadata service). Its DNS only resolves
 *   container names, so DNS cannot be used to exfiltrate data either.
 * - The proxy (egress-proxy.ts, its own hardened container) allows CONNECT to the
 *   allow-listed hosts only, refuses non-public addresses and checks the TLS SNI.
 * - The `gateway` preset adds a fixed TCP forward from the proxy to the AI gateway.
 */
import { randomBytes } from 'node:crypto';
import {
  assertHardenedProxyArgs,
  buildProxyCreateArgs,
  PROXY_CONTAINER_PREFIX,
  SANDBOX_LABEL,
  SANDBOX_NETWORK_PREFIX,
} from './args.js';
import {
  SANDBOX_DEFAULTS,
  type EgressPreset,
  type HostPreset,
  type ResolvedSandboxConfig,
} from './config.js';
import type { DockerCli } from './docker.js';
import { EGRESS_DEFAULTS, type EgressProxyConfig } from './egress-proxy.js';
import { SandboxError } from './errors.js';
import type { Redactor } from './redact.js';

export interface EgressDecision {
  reason: string;
  host?: string;
  port?: number;
}

export interface EgressReport {
  /** `host:port` tunnels that were opened. */
  allowed: string[];
  /** Refused attempts (deduplicated, at most 50). */
  denied: EgressDecision[];
  gatewayConnections: number;
}

export interface EgressSession {
  networkName: string;
  proxyName: string;
  /** Proxy variables for the sandbox. */
  env: Record<string, string>;
  close(): Promise<EgressReport>;
}

export interface OpenEgressInput {
  runId: string;
  allow: readonly EgressPreset[];
  labels: Record<string, string>;
  redact: Redactor;
  /** Wait between `docker logs` polls while the proxy starts. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_DENIED = 50;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dockerError(what: string, stderr: string, redact: Redactor): SandboxError {
  return new SandboxError('egress_failed', `${what}: ${redact(stderr).trim().slice(0, 500)}`);
}

/** Hosts reachable for a set of presets. */
export function hostsFor(
  allow: readonly EgressPreset[],
  egressHosts: Record<HostPreset, readonly string[]>,
): string[] {
  const hosts = new Set<string>();
  for (const preset of allow) {
    if (preset === 'gateway') continue;
    for (const host of egressHosts[preset]) hosts.add(host);
  }
  return [...hosts];
}

/** Proxy configuration of one run. */
export function buildProxyConfig(
  allow: readonly EgressPreset[],
  config: Pick<ResolvedSandboxConfig, 'egressHosts' | 'gateway'>,
): EgressProxyConfig {
  let gateway: EgressProxyConfig['gateway'] = null;
  if (allow.includes('gateway')) {
    if (!config.gateway) {
      throw new SandboxError(
        'unsafe_option',
        'the gateway preset needs a configured gateway upstream',
      );
    }
    gateway = {
      listenPort: SANDBOX_DEFAULTS.gatewayForwardPort,
      upstreamHost: config.gateway.host,
      upstreamPort: config.gateway.port,
    };
  }
  return {
    proxyPort: SANDBOX_DEFAULTS.proxyPort,
    allowHosts: hostsFor(allow, config.egressHosts),
    allowPorts: [...EGRESS_DEFAULTS.allowPorts],
    gateway,
    maxConnections: EGRESS_DEFAULTS.maxConnections,
    idleTimeoutMs: EGRESS_DEFAULTS.idleTimeoutMs,
    connectTimeoutMs: EGRESS_DEFAULTS.connectTimeoutMs,
    helloTimeoutMs: EGRESS_DEFAULTS.helloTimeoutMs,
  };
}

/** Variables pointing the sandbox's tools at the proxy (and at the gateway forward). */
export function sandboxProxyEnv(allow: readonly EgressPreset[]): Record<string, string> {
  const proxyUrl = `http://${SANDBOX_DEFAULTS.proxyAlias}:${SANDBOX_DEFAULTS.proxyPort}`;
  const noProxy = `localhost,127.0.0.1,${SANDBOX_DEFAULTS.proxyAlias}`;
  const env: Record<string, string> = {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node's built-in fetch honours the variables above only with this flag.
    NODE_USE_ENV_PROXY: '1',
  };
  if (allow.includes('gateway')) {
    env.ANTHROPIC_BASE_URL = `http://${SANDBOX_DEFAULTS.proxyAlias}:${SANDBOX_DEFAULTS.gatewayForwardPort}`;
  }
  return env;
}

/** Parses the proxy's JSON log lines into a bounded report. */
export function parseProxyLog(text: string): EgressReport {
  const allowed = new Set<string>();
  const denied = new Map<string, EgressDecision>();
  let gatewayConnections = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const host = typeof entry.host === 'string' ? entry.host.slice(0, 253) : undefined;
    const port = typeof entry.port === 'number' ? entry.port : undefined;
    if (entry.event === 'allow' && host) allowed.add(`${host}:${port ?? ''}`);
    else if (entry.event === 'gateway') gatewayConnections += 1;
    else if (entry.event === 'deny' && typeof entry.reason === 'string') {
      const key = `${entry.reason}|${host ?? ''}|${port ?? ''}`;
      if (!denied.has(key) && denied.size < MAX_DENIED) {
        const decision: EgressDecision = { reason: entry.reason.slice(0, 64) };
        if (host) decision.host = host;
        if (port !== undefined) decision.port = port;
        denied.set(key, decision);
      }
    }
  }
  return { allowed: [...allowed], denied: [...denied.values()], gatewayConnections };
}

/**
 * Makes sure the shared egress bridge exists and is a plain bridge with
 * inter-container communication disabled (egress proxies of different jobs cannot
 * talk to each other).
 */
export async function ensureEgressNetwork(
  docker: DockerCli,
  name: string,
  redact: Redactor,
  allowCreate = true,
): Promise<void> {
  const inspect = await docker.exec(['network', 'inspect', '--format={{json .}}', name]);
  if (inspect.code !== 0) {
    if (!allowCreate)
      throw dockerError('cannot inspect the egress network', inspect.stderr, redact);
    const create = await docker.exec([
      'network',
      'create',
      '--driver=bridge',
      '--ipv6=false',
      `--label=${SANDBOX_LABEL}.egress=1`,
      '--opt=com.docker.network.bridge.enable_icc=false',
      `--opt=com.docker.network.bridge.name=${SANDBOX_DEFAULTS.egressBridgeName}`,
      name,
    ]);
    // Another worker may have created it meanwhile.
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw dockerError('cannot create the egress network', create.stderr, redact);
    }
    return ensureEgressNetwork(docker, name, redact, false);
  }
  let info: { Driver?: string; Internal?: boolean; Options?: Record<string, string> };
  try {
    info = JSON.parse(inspect.stdout) as typeof info;
  } catch {
    throw new SandboxError('egress_failed', 'cannot read the egress network');
  }
  if (info.Driver !== 'bridge' || info.Internal === true) {
    throw new SandboxError('egress_failed', `network ${name} must be a non-internal bridge`);
  }
  if (info.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
    throw new SandboxError(
      'egress_failed',
      `network ${name} must disable inter-container communication (enable_icc=false)`,
    );
  }
}

/** Creates the per-run internal network and starts the egress proxy on it. */
export async function openEgress(
  docker: DockerCli,
  config: ResolvedSandboxConfig,
  input: OpenEgressInput,
): Promise<EgressSession> {
  const { runId, redact } = input;
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = input.pollMs ?? 100;
  const networkName = `${SANDBOX_NETWORK_PREFIX}${runId}`;
  const proxyName = `${PROXY_CONTAINER_PREFIX}${runId}`;
  const bridgeName = `${SANDBOX_DEFAULTS.sandboxBridgePrefix}${randomBytes(5).toString('hex')}`;
  const proxyConfig = buildProxyConfig(input.allow, config);

  await ensureEgressNetwork(docker, config.egressNetwork, redact);

  let networkCreated = false;
  let proxyCreated = false;
  const cleanup = async () => {
    if (proxyCreated) await docker.exec(['rm', '--force', proxyName]).catch(() => undefined);
    if (networkCreated) {
      const rm = await docker.exec(['network', 'rm', networkName]).catch(() => undefined);
      if (rm && rm.code !== 0) {
        // An endpoint may still be detaching: retry once.
        await sleep(500);
        await docker.exec(['network', 'rm', networkName]).catch(() => undefined);
      }
    }
  };

  try {
    const net = await docker.exec([
      'network',
      'create',
      '--driver=bridge',
      '--internal',
      '--ipv6=false',
      ...Object.entries(input.labels).map(([k, v]) => `--label=${k}=${v}`),
      '--opt=com.docker.network.bridge.inhibit_ipv4=true',
      `--opt=com.docker.network.bridge.name=${bridgeName}`,
      networkName,
    ]);
    if (net.code !== 0) throw dockerError('cannot create the sandbox network', net.stderr, redact);
    networkCreated = true;

    const proxyArgs = buildProxyCreateArgs({
      name: proxyName,
      labels: input.labels,
      image: config.proxyImage,
      uid: config.uid,
      gid: config.gid,
      egressNetwork: config.egressNetwork,
      hostGateway:
        config.gateway?.host === 'host.docker.internal' && input.allow.includes('gateway'),
      configJson: JSON.stringify(proxyConfig),
    });
    assertHardenedProxyArgs(proxyArgs);
    const create = await docker.exec(['create', ...proxyArgs]);
    if (create.code !== 0)
      throw dockerError('cannot create the egress proxy', create.stderr, redact);
    proxyCreated = true;

    const connect = await docker.exec([
      'network',
      'connect',
      `--alias=${SANDBOX_DEFAULTS.proxyAlias}`,
      networkName,
      proxyName,
    ]);
    if (connect.code !== 0)
      throw dockerError('cannot attach the egress proxy', connect.stderr, redact);

    const start = await docker.exec(['start', proxyName]);
    if (start.code !== 0) throw dockerError('cannot start the egress proxy', start.stderr, redact);

    const deadline = Date.now() + SANDBOX_DEFAULTS.proxyReadyTimeoutMs;
    for (;;) {
      const logs = await docker.exec(['logs', proxyName], { maxBytes: 256 * 1024 });
      if (logs.stdout.split('\n').some((l) => l.includes('"event":"ready"'))) break;
      if (logs.stdout.includes('"event":"fatal"') || Date.now() > deadline) {
        throw new SandboxError(
          'egress_failed',
          `egress proxy did not start: ${redact(logs.stdout + logs.stderr).slice(-500)}`,
        );
      }
      await sleep(pollMs);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    networkName,
    proxyName,
    env: sandboxProxyEnv(input.allow),
    async close() {
      const logs = await docker
        .exec(['logs', proxyName], { maxBytes: 2 * 1024 * 1024 })
        .catch(() => null);
      await cleanup();
      const empty: EgressReport = { allowed: [], denied: [], gatewayConnections: 0 };
      return logs ? parseProxyLog(redact(logs.stdout)) : empty;
    },
  };
}
