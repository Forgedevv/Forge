/**
 * Egress proxy of the sandbox (docs/SECURITY.md section 4).
 *
 * Runs in its own hardened container, attached to the sandbox's internal network
 * (no route out) and to an egress bridge. It is the only way out of the sandbox:
 *
 * - HTTP proxy port: only `CONNECT <allow-listed host>:<allowed port>` is accepted.
 *   The host is resolved here and every non-public address (private ranges, loopback,
 *   link-local / cloud metadata, CGNAT, multicast, reserved...) is refused, so DNS
 *   answers cannot redirect a tunnel to the host or the internal network. The proxy
 *   connects to the vetted IP itself (no second resolution). The first bytes of the
 *   tunnel must be a TLS ClientHello whose SNI is exactly the CONNECT host: a tunnel
 *   opened to an allowed host cannot reach another site served by the same CDN.
 *   Plain HTTP requests are refused.
 * - Gateway port (optional): a raw TCP forward to one fixed upstream, the FORGE AI
 *   gateway on the host. The sandbox cannot choose the destination.
 *
 * This file is self-contained (Node built-ins only, erasable TypeScript syntax only,
 * no relative imports) so the proxy image runs it directly with Node's type stripping.
 * Never log request contents: only hosts, ports and decisions are logged.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface EgressGatewayForward {
  /** Port the proxy listens on for the gateway forward. */
  listenPort: number;
  /** Fixed upstream (host name or IP), seen from the proxy container. */
  upstreamHost: string;
  upstreamPort: number;
}

export interface EgressProxyConfig {
  proxyPort: number;
  /** Exact host names, or `*.example.com` for strict subdomains only. */
  allowHosts: string[];
  allowPorts: number[];
  gateway: EgressGatewayForward | null;
  maxConnections: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
  /** Max wait for the TLS ClientHello after the tunnel is established. */
  helloTimeoutMs: number;
}

export type EgressLogEntry = {
  event: string;
  [key: string]: unknown;
};

export interface EgressProxyDeps {
  /** Resolves a host name to its addresses (default: OS resolver, all families). */
  lookup?: (host: string) => Promise<string[]>;
  /** Opens a TCP connection (tests). */
  connect?: (host: string, port: number) => net.Socket;
  log?: (entry: EgressLogEntry) => void;
}

export interface EgressProxy {
  listen(host?: string): Promise<{ proxyPort: number; gatewayPort: number | null }>;
  close(): Promise<void>;
}

export const EGRESS_DEFAULTS = {
  proxyPort: 3128,
  gatewayPort: 8788,
  allowPorts: [443],
  maxConnections: 256,
  idleTimeoutMs: 120_000,
  connectTimeoutMs: 10_000,
  helloTimeoutMs: 10_000,
} as const;

/** Max bytes buffered while waiting for a complete ClientHello. */
const MAX_HELLO_BYTES = 64 * 1024;
/** After this many denials, further denials are counted but not logged one by one. */
const MAX_DENY_LOGS = 500;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ALLOW_HOST_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);

/** Lower-cases a host name and strips one trailing dot; `null` if it is not a plain DNS name. */
export function normalizeHostName(host: string): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return null;
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!HOST_NAME_RE.test(h)) return null;
  // A name whose last label is numeric is an IP literal or nonsense, never an allowed host.
  const last = h.slice(h.lastIndexOf('.') + 1);
  if (/^[0-9]+$/.test(last)) return null;
  return h;
}

/** True if `host` (already normalized) matches an allow-list entry. */
export function isHostAllowed(host: string, allowHosts: readonly string[]): boolean {
  for (const entry of allowHosts) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (includes some cloud metadata endpoints)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private (Docker networks)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/** Special ranges inside 2000::/3 (global unicast); everything outside 2000::/3 is refused. */
const V6_DENY: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['2620:4f:8000::', 48], // AS112
  ['3fff::', 20], // documentation
];

const V6_GLOBAL = new net.BlockList();
V6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
const DENY = new net.BlockList();
for (const [address, prefix] of V4_DENY) DENY.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of V6_DENY) DENY.addSubnet(address, prefix, 'ipv6');

/** True only for a public unicast address the sandbox may reach through the proxy. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !DENY.check(ip, 'ipv4');
  if (family === 6) {
    // IPv4-mapped/compatible, ULA (fc00::/7, incl. fd00:ec2::254), link-local and
    // multicast are all outside 2000::/3.
    if (!V6_GLOBAL.check(ip, 'ipv6')) return false;
    return !DENY.check(ip, 'ipv6');
  }
  return false;
}

/** Parses a CONNECT authority (`host:port`). IP literals and user info are refused. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  if (typeof target !== 'string' || target.length > 300) return null;
  const match = /^([^:@/\s[\]]+):([0-9]{1,5})$/.exec(target);
  if (!match) return null;
  const host = normalizeHostName(match[1] ?? '');
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export type ClientHelloResult =
  | { kind: 'incomplete' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; serverName: string | null; ech: boolean };

function invalid(reason: string): ClientHelloResult {
  return { kind: 'invalid', reason };
}

/**
 * Extracts the SNI from the first bytes of a TLS connection. The ClientHello may be
 * split across several TLS records. Returns `incomplete` until enough bytes arrived.
 */
export function parseClientHello(buf: Uint8Array): ClientHelloResult {
  const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const fragments: Buffer[] = [];
  let collected = 0;
  let offset = 0;
  let helloLength = -1;
  for (;;) {
    if (data.length - offset < 5) return { kind: 'incomplete' };
    if (data[offset] !== 0x16) return invalid('not a TLS handshake');
    if (data[offset + 1] !== 0x03) return invalid('unsupported TLS record version');
    const recordLength = data.readUInt16BE(offset + 3);
    if (recordLength === 0 || recordLength > 16384) return invalid('bad TLS record length');
    if (data.length - offset - 5 < recordLength) return { kind: 'incomplete' };
    fragments.push(data.subarray(offset + 5, offset + 5 + recordLength));
    collected += recordLength;
    offset += 5 + recordLength;
    const handshake = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, collected);
    if (helloLength < 0 && handshake.length >= 4) {
      if (handshake[0] !== 0x01) return invalid('first handshake message is not a ClientHello');
      helloLength = handshake.readUIntBE(1, 3);
      if (helloLength > MAX_HELLO_BYTES) return invalid('ClientHello too large');
    }
    if (helloLength >= 0 && handshake.length >= 4 + helloLength) {
      return parseClientHelloBody(handshake.subarray(4, 4 + helloLength));
    }
    if (collected > MAX_HELLO_BYTES) return invalid('ClientHello too large');
  }
}

function parseClientHelloBody(body: Buffer): ClientHelloResult {
  let p = 0;
  const need = (n: number) => p + n <= body.length;
  if (!need(2 + 32 + 1)) return invalid('truncated ClientHello');
  p += 2 + 32; // legacy_version, random
  const sessionIdLength = body[p]!;
  p += 1;
  if (sessionIdLength > 32 || !need(sessionIdLength + 2)) return invalid('bad session id');
  p += sessionIdLength;
  const cipherSuitesLength = body.readUInt16BE(p);
  p += 2;
  if (cipherSuitesLength === 0 || cipherSuitesLength % 2 !== 0 || !need(cipherSuitesLength + 1)) {
    return invalid('bad cipher suites');
  }
  p += cipherSuitesLength;
  const compressionLength = body[p]!;
  p += 1;
  if (compressionLength === 0 || !need(compressionLength)) return invalid('bad compression list');
  p += compressionLength;
  if (p === body.length) return { kind: 'ok', serverName: null, ech: false };
  if (!need(2)) return invalid('truncated extensions');
  const extensionsLength = body.readUInt16BE(p);
  p += 2;
  if (p + extensionsLength !== body.length) return invalid('bad extensions length');
  const seen = new Set<number>();
  let serverName: string | null = null;
  let ech = false;
  while (p < body.length) {
    if (!need(4)) return invalid('truncated extension');
    const type = body.readUInt16BE(p);
    const length = body.readUInt16BE(p + 2);
    p += 4;
    if (!need(length)) return invalid('truncated extension');
    if (seen.has(type)) return invalid('duplicate extension');
    seen.add(type);
    if (type === 0xfe0d) ech = true;
    if (type === 0x0000) {
      const ext = body.subarray(p, p + length);
      if (ext.length < 2 || ext.readUInt16BE(0) + 2 !== ext.length) {
        return invalid('bad server_name extension');
      }
      let q = 2;
      const names: string[] = [];
      while (q < ext.length) {
        if (q + 3 > ext.length) return invalid('bad server_name entry');
        const nameType = ext[q]!;
        const nameLength = ext.readUInt16BE(q + 1);
        q += 3;
        if (q + nameLength > ext.length) return invalid('bad server_name entry');
        if (nameType === 0) names.push(ext.subarray(q, q + nameLength).toString('latin1'));
        q += nameLength;
      }
      if (names.length !== 1) return invalid('expected exactly one host_name');
      serverName = names[0]!;
    }
    p += length;
  }
  return { kind: 'ok', serverName, ech };
}

function int(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`egress config: ${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** Validates the proxy configuration (no schema library: the proxy image has no dependencies). */
export function parseEgressProxyConfig(raw: unknown): EgressProxyConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('egress config: must be an object');
  }
  const r = raw as Record<string, unknown>;
  const known = new Set([
    'proxyPort',
    'allowHosts',
    'allowPorts',
    'gateway',
    'maxConnections',
    'idleTimeoutMs',
    'connectTimeoutMs',
    'helloTimeoutMs',
  ]);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) throw new Error(`egress config: unknown field "${key}"`);
  }
  if (!Array.isArray(r.allowHosts) || r.allowHosts.length > 64) {
    throw new Error('egress config: allowHosts must be an array (max 64)');
  }
  const allowHosts = r.allowHosts.map((h) => {
    if (typeof h !== 'string' || !ALLOW_HOST_RE.test(h) || /\.[0-9]+$/.test(h)) {
      throw new Error(`egress config: invalid allow-listed host ${JSON.stringify(h)}`);
    }
    return h;
  });
  const allowPortsRaw = r.allowPorts ?? [...EGRESS_DEFAULTS.allowPorts];
  if (!Array.isArray(allowPortsRaw) || allowPortsRaw.length === 0 || allowPortsRaw.length > 8) {
    throw new Error('egress config: allowPorts must be a non-empty array');
  }
  const allowPorts = allowPortsRaw.map((p) => int(p, 'allowPorts[]', 1, 65535));
  let gateway: EgressGatewayForward | null = null;
  if (r.gateway !== undefined && r.gateway !== null) {
    const g = r.gateway as Record<string, unknown>;
    if (typeof g !== 'object' || Array.isArray(g)) {
      throw new Error('egress config: gateway must be an object');
    }
    const upstreamHost = g.upstreamHost;
    if (
      typeof upstreamHost !== 'string' ||
      (net.isIP(upstreamHost) === 0 && !HOST_NAME_RE.test(upstreamHost.toLowerCase()))
    ) {
      throw new Error('egress config: gateway.upstreamHost must be a host name or an IP');
    }
    gateway = {
      // 0 = ephemeral port (tests).
      listenPort: int(g.listenPort, 'gateway.listenPort', 0, 65535),
      upstreamHost,
      upstreamPort: int(g.upstreamPort, 'gateway.upstreamPort', 1, 65535),
    };
  }
  const proxyPort = int(r.proxyPort ?? EGRESS_DEFAULTS.proxyPort, 'proxyPort', 0, 65535);
  if (gateway && proxyPort !== 0 && gateway.listenPort === proxyPort) {
    throw new Error('egress config: gateway.listenPort must differ from proxyPort');
  }
  return {
    proxyPort,
    allowHosts,
    allowPorts,
    gateway,
    maxConnections: int(
      r.maxConnections ?? EGRESS_DEFAULTS.maxConnections,
      'maxConnections',
      1,
      4096,
    ),
    idleTimeoutMs: int(
      r.idleTimeoutMs ?? EGRESS_DEFAULTS.idleTimeoutMs,
      'idleTimeoutMs',
      1000,
      3_600_000,
    ),
    connectTimeoutMs: int(
      r.connectTimeoutMs ?? EGRESS_DEFAULTS.connectTimeoutMs,
      'connectTimeoutMs',
      100,
      120_000,
    ),
    helloTimeoutMs: int(
      r.helloTimeoutMs ?? EGRESS_DEFAULTS.helloTimeoutMs,
      'helloTimeoutMs',
      100,
      120_000,
    ),
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const records = await dns.lookup(host, { all: true, order: 'ipv4first' });
  return records.map((r) => r.address);
}

function defaultConnect(host: string, port: number): net.Socket {
  return net.connect({ host, port });
}

function defaultLog(entry: EgressLogEntry): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

/** Host of an absolute-form proxy request, for the log only. */
function requestHost(url: string | undefined): string | null {
  try {
    return new URL(url ?? '', 'http://invalid.invalid').hostname.slice(0, 100);
  } catch {
    return null;
  }
}

function writeStatus(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  const body = `${text}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** Connects to `host:port`, failing after `timeoutMs`. */
function connectWithTimeout(
  connect: (host: string, port: number) => net.Socket,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(host, port);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** Pipes two sockets both ways with an idle timeout; destroys both when either side ends badly. */
function splice(a: Duplex, b: net.Socket, idleTimeoutMs: number): void {
  const destroyBoth = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', destroyBoth);
  b.on('error', destroyBoth);
  a.on('close', destroyBoth);
  b.on('close', destroyBoth);
  b.setTimeout(idleTimeoutMs, destroyBoth);
  if (a instanceof net.Socket) a.setTimeout(idleTimeoutMs, destroyBoth);
  a.pipe(b);
  b.pipe(a);
}

export function createEgressProxy(
  configInput: EgressProxyConfig,
  deps: EgressProxyDeps = {},
): EgressProxy {
  const config = parseEgressProxyConfig(configInput);
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? defaultConnect;
  const log = deps.log ?? defaultLog;
  const allowPorts = new Set(config.allowPorts);
  let active = 0;
  let denyLogs = 0;
  let suppressedDenies = 0;
  const sockets = new Set<Duplex>();

  function deny(socket: Duplex, status: number, entry: Record<string, unknown>): void {
    if (denyLogs < MAX_DENY_LOGS) {
      denyLogs += 1;
      log({ event: 'deny', ...entry });
    } else {
      suppressedDenies += 1;
    }
    writeStatus(socket, status, status === 403 ? 'Forbidden' : 'Bad Gateway');
  }

  function track(socket: Duplex): boolean {
    if (active >= config.maxConnections) return false;
    active += 1;
    sockets.add(socket);
    socket.once('close', () => {
      active -= 1;
      sockets.delete(socket);
    });
    return true;
  }

  async function handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on('error', () => client.destroy());
    if (!track(client)) {
      writeStatus(client, 503, 'Service Unavailable');
      return;
    }
    const target = parseConnectTarget(req.url ?? '');
    if (!target) {
      deny(client, 403, { reason: 'invalid_target', target: String(req.url ?? '').slice(0, 100) });
      return;
    }
    const { host, port } = target;
    if (!allowPorts.has(port)) {
      deny(client, 403, { reason: 'port_not_allowed', host, port });
      return;
    }
    if (!isHostAllowed(host, config.allowHosts)) {
      deny(client, 403, { reason: 'host_not_allowed', host, port });
      return;
    }
    let addresses: string[];
    try {
      addresses = await lookup(host);
    } catch {
      deny(client, 502, { reason: 'dns_failed', host, port });
      return;
    }
    const publicAddresses = addresses.filter(isPublicAddress);
    if (publicAddresses.length === 0) {
      deny(client, 403, { reason: 'non_public_address', host, port, addresses });
      return;
    }
    let upstream: net.Socket | undefined;
    for (const ip of publicAddresses) {
      if (client.destroyed) return;
      try {
        upstream = await connectWithTimeout(connect, ip, port, config.connectTimeoutMs);
        break;
      } catch {
        // try the next address
      }
    }
    if (!upstream) {
      deny(client, 502, { reason: 'connect_failed', host, port });
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    const up = upstream;
    up.on('error', () => up.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // The first bytes must be a ClientHello for exactly this host.
    let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    const helloTimer = setTimeout(() => {
      fail('hello_timeout');
    }, config.helloTimeoutMs);
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(helloTimer);
      client.removeListener('data', onData);
      if (denyLogs < MAX_DENY_LOGS) {
        denyLogs += 1;
        log({ event: 'deny', reason, host, port });
      } else {
        suppressedDenies += 1;
      }
      client.destroy();
      up.destroy();
    };
    const check = () => {
      if (settled) return;
      const hello = parseClientHello(buffered);
      if (hello.kind === 'incomplete') {
        if (buffered.length > MAX_HELLO_BYTES) fail('hello_too_large');
        return;
      }
      if (hello.kind === 'invalid') {
        fail('not_tls');
        return;
      }
      if (hello.ech) {
        fail('ech_not_allowed');
        return;
      }
      const sni = hello.serverName === null ? null : normalizeHostName(hello.serverName);
      if (sni !== host) {
        fail('sni_mismatch');
        return;
      }
      settled = true;
      clearTimeout(helloTimer);
      client.removeListener('data', onData);
      client.pause();
      log({ event: 'allow', host, port });
      up.write(buffered);
      splice(client, up, config.idleTimeoutMs);
      client.resume();
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      check();
    };
    client.on('data', onData);
    client.once('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(helloTimer);
        up.destroy();
      }
    });
    if (buffered.length > 0) check();
  }

  const proxyServer = http.createServer({ maxHeaderSize: 8192 });
  proxyServer.headersTimeout = 10_000;
  proxyServer.requestTimeout = 15_000;
  proxyServer.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (denyLogs < MAX_DENY_LOGS) {
      denyLogs += 1;
      log({ event: 'deny', reason: 'plain_http', method: req.method, host: requestHost(req.url) });
    } else {
      suppressedDenies += 1;
    }
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
    res.end('Only CONNECT to allow-listed HTTPS hosts is permitted.\n');
  });
  proxyServer.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    handleConnect(req, socket, head).catch(() => socket.destroy());
  });
  proxyServer.on('clientError', (_error: Error, socket: Duplex) => {
    writeStatus(socket, 400, 'Bad Request');
  });

  let gatewayServer: net.Server | null = null;
  const gateway = config.gateway;
  if (gateway) {
    gatewayServer = net.createServer((client) => {
      client.on('error', () => client.destroy());
      if (!track(client)) {
        client.destroy();
        return;
      }
      connectWithTimeout(
        connect,
        gateway.upstreamHost,
        gateway.upstreamPort,
        config.connectTimeoutMs,
      )
        .then((upstream) => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          log({ event: 'gateway' });
          splice(client, upstream, config.idleTimeoutMs);
        })
        .catch(() => {
          log({ event: 'gateway_error', reason: 'connect_failed' });
          client.destroy();
        });
    });
  }

  function listenOn(server: net.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return {
    async listen(host = '0.0.0.0') {
      const proxyPort = await listenOn(proxyServer, config.proxyPort, host);
      const gatewayPort = gatewayServer
        ? await listenOn(gatewayServer, gateway!.listenPort, host)
        : null;
      return { proxyPort, gatewayPort };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      proxyServer.closeAllConnections();
      await closeServer(proxyServer);
      if (gatewayServer) await closeServer(gatewayServer);
      if (suppressedDenies > 0) log({ event: 'deny_suppressed', count: suppressedDenies });
    },
  };
}

async function main(): Promise<void> {
  const raw = process.env.FORGE_EGRESS_CONFIG;
  if (!raw) throw new Error('FORGE_EGRESS_CONFIG is required');
  const config = parseEgressProxyConfig(JSON.parse(raw));
  const proxy = createEgressProxy(config);
  const ports = await proxy.listen('0.0.0.0');
  defaultLog({ event: 'ready', ...ports, allowHosts: config.allowHosts });
  const stop = () => {
    proxy.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.env.FORGE_EGRESS_PROXY_MAIN === '1') {
  main().catch((error: unknown) => {
    defaultLog({ event: 'fatal', message: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  });
}
