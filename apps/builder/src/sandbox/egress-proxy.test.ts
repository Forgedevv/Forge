import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEgressProxy,
  isHostAllowed,
  isPublicAddress,
  normalizeHostName,
  parseClientHello,
  parseConnectTarget,
  parseEgressProxyConfig,
  type EgressLogEntry,
  type EgressProxy,
  type EgressProxyConfig,
} from './egress-proxy.js';

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u24(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntBE(n, 0, 3);
  return b;
}

function ext(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(data.length), data]);
}

function record(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(payload.length), payload]);
}

/** Synthetic TLS ClientHello handshake message (without the record layer). */
function helloHandshake(opts: { sni?: string[]; ech?: boolean; duplicate?: boolean } = {}): Buffer {
  const exts: Buffer[] = [];
  if (opts.sni) {
    const entries = opts.sni.map((name) => {
      const nb = Buffer.from(name, 'latin1');
      return Buffer.concat([Buffer.from([0]), u16(nb.length), nb]);
    });
    const list = Buffer.concat(entries);
    const data = Buffer.concat([u16(list.length), list]);
    exts.push(ext(0, data));
    if (opts.duplicate) exts.push(ext(0, data));
  }
  if (opts.ech) exts.push(ext(0xfe0d, Buffer.from([0])));
  exts.push(ext(0x000a, Buffer.from([0, 2, 0, 0x1d])));
  const extBlock = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extBlock.length),
    extBlock,
  ]);
  return Buffer.concat([Buffer.from([1]), u24(body.length), body]);
}

function clientHello(opts: { sni?: string[]; ech?: boolean; duplicate?: boolean } = {}): Buffer {
  return record(helloHandshake(opts));
}

/** Captures the real ClientHello sent by Node's TLS stack. */
async function captureRealHello(servername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once('data', (data) => {
        resolve(Buffer.from(data));
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      const client = tls.connect({ host: '127.0.0.1', port, servername });
      client.on('error', () => undefined);
      setTimeout(() => reject(new Error('no hello')), 5000).unref();
    });
  });
}

describe('host and address policy', () => {
  it('normalizes host names and refuses IP literals and odd names', () => {
    expect(normalizeHostName('Registry.NPMJS.org.')).toBe('registry.npmjs.org');
    for (const bad of [
      '1.2.3.4',
      '[::1]',
      '::1',
      'localhost',
      'a..b.com',
      'exa_mple.com',
      '-a.com',
      'a.com:443',
      '',
      `${'a'.repeat(250)}.com`,
      '0x7f.0.0.1',
      '2130706433',
    ]) {
      expect(normalizeHostName(bad), bad).toBeNull();
    }
  });

  it('matches exact hosts and strict subdomains only', () => {
    const allow = ['registry.npmjs.org', '*.example.com'];
    expect(isHostAllowed('registry.npmjs.org', allow)).toBe(true);
    expect(isHostAllowed('a.example.com', allow)).toBe(true);
    expect(isHostAllowed('a.b.example.com', allow)).toBe(true);
    expect(isHostAllowed('example.com', allow)).toBe(false);
    expect(isHostAllowed('badexample.com', allow)).toBe(false);
    expect(isHostAllowed('registry.npmjs.org.evil.com', allow)).toBe(false);
    expect(isHostAllowed('evil-registry.npmjs.org', allow)).toBe(false);
  });

  it('only accepts public unicast addresses', () => {
    for (const ok of ['8.8.8.8', '104.16.0.1', '1.1.1.1', '2606:4700::6810:1', '2a01:4f8::1']) {
      expect(isPublicAddress(ok), ok).toBe(true);
    }
    for (const bad of [
      '10.0.0.1',
      '172.16.5.4',
      '172.17.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.100.100.200',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::7f00:1',
      'fd00:ec2::254',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2001::1',
      '2002:7f00:1::1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });

  it('parses CONNECT targets strictly', () => {
    expect(parseConnectTarget('registry.npmjs.org:443')).toEqual({
      host: 'registry.npmjs.org',
      port: 443,
    });
    for (const bad of [
      'registry.npmjs.org',
      'user@registry.npmjs.org:443',
      '1.2.3.4:443',
      '[::1]:443',
      'registry.npmjs.org:99999',
      'registry.npmjs.org:0',
      'http://registry.npmjs.org:443',
      'registry.npmjs.org:443/x',
    ]) {
      expect(parseConnectTarget(bad), bad).toBeNull();
    }
  });
});

describe('parseClientHello', () => {
  it('reads the SNI of a real ClientHello', async () => {
    const hello = await captureRealHello('registry.npmjs.org');
    expect(parseClientHello(hello)).toEqual({
      kind: 'ok',
      serverName: 'registry.npmjs.org',
      ech: false,
    });
    // Byte by byte, it stays incomplete until the last byte.
    for (const cut of [1, 4, 5, 20, hello.length - 1]) {
      expect(parseClientHello(hello.subarray(0, cut)).kind).toBe('incomplete');
    }
  });

  it('reassembles a ClientHello split across records', () => {
    const hs = helloHandshake({ sni: ['npm.pkg.github.com'] });
    const split = Buffer.concat([
      record(hs.subarray(0, 3)),
      record(hs.subarray(3, 50)),
      record(hs.subarray(50)),
    ]);
    expect(parseClientHello(split)).toEqual({
      kind: 'ok',
      serverName: 'npm.pkg.github.com',
      ech: false,
    });
  });

  it('reports a missing SNI, ECH and malformed hellos', () => {
    expect(parseClientHello(clientHello())).toEqual({ kind: 'ok', serverName: null, ech: false });
    expect(parseClientHello(clientHello({ sni: ['a.example.com'], ech: true }))).toMatchObject({
      kind: 'ok',
      ech: true,
    });
    expect(parseClientHello(clientHello({ sni: ['a.com', 'b.com'] })).kind).toBe('invalid');
    expect(parseClientHello(clientHello({ sni: ['a.com'], duplicate: true })).kind).toBe('invalid');
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')).kind).toBe('invalid');
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00])).kind).toBe('invalid');
    const notHello = record(Buffer.from([2, 0, 0, 1, 0]));
    expect(parseClientHello(notHello).kind).toBe('invalid');
  });
});

describe('parseEgressProxyConfig', () => {
  it('applies defaults', () => {
    const c = parseEgressProxyConfig({ allowHosts: ['registry.npmjs.org'] });
    expect(c.proxyPort).toBe(3128);
    expect(c.allowPorts).toEqual([443]);
    expect(c.gateway).toBeNull();
  });

  it('refuses unsafe or malformed settings', () => {
    const bad: unknown[] = [
      null,
      [],
      { allowHosts: 'registry.npmjs.org' },
      { allowHosts: ['10.0.0.1'] },
      { allowHosts: ['registry.npmjs.org:443'] },
      { allowHosts: ['*'] },
      { allowHosts: ['*.com.'] },
      { allowHosts: [], extra: true },
      { allowHosts: [], allowPorts: [] },
      { allowHosts: [], allowPorts: [70000] },
      {
        allowHosts: [],
        gateway: { listenPort: 3128, upstreamHost: 'h.internal', upstreamPort: 1 },
      },
      { allowHosts: [], gateway: { listenPort: 8788, upstreamHost: 'bad host', upstreamPort: 1 } },
    ];
    for (const raw of bad) expect(() => parseEgressProxyConfig(raw), JSON.stringify(raw)).toThrow();
  });
});

describe('egress proxy server', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  interface Upstream {
    port: number;
    received: Buffer[];
  }

  async function startUpstream(): Promise<Upstream> {
    const received: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (d) => {
        received.push(Buffer.from(d));
        socket.write('PONG');
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    });
    return { port: (server.address() as net.AddressInfo).port, received };
  }

  async function startProxy(
    upstream: Upstream,
    overrides: Partial<EgressProxyConfig> = {},
    addresses: Record<string, string[]> = {},
  ) {
    const logs: EgressLogEntry[] = [];
    const connects: Array<{ host: string; port: number }> = [];
    const config: EgressProxyConfig = {
      proxyPort: 0,
      allowHosts: ['registry.npmjs.org', 'npm.pkg.github.com'],
      allowPorts: [443],
      gateway: null,
      maxConnections: 16,
      idleTimeoutMs: 5000,
      connectTimeoutMs: 2000,
      helloTimeoutMs: 2000,
      ...overrides,
    };
    const proxy: EgressProxy = createEgressProxy(config, {
      lookup: async (host) => addresses[host] ?? ['104.16.0.1'],
      connect: (host, port) => {
        connects.push({ host, port });
        return net.connect(upstream.port, '127.0.0.1');
      },
      log: (entry) => logs.push(entry),
    });
    const ports = await proxy.listen('127.0.0.1');
    closers.push(() => proxy.close());
    return { ...ports, logs, connects };
  }

  /** Opens a CONNECT tunnel; resolves with the status line and the socket. */
  function connectVia(
    port: number,
    target: string,
  ): Promise<{ status: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end >= 0) {
          socket.off('data', onData);
          resolve({ status: buf.split('\r\n')[0]!, socket });
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
      closers.push(async () => {
        socket.destroy();
      });
    });
  }

  function waitClose(socket: net.Socket): Promise<void> {
    return new Promise((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once('close', () => resolve());
    });
  }

  function readSome(socket: net.Socket): Promise<string> {
    return new Promise((resolve) => socket.once('data', (d) => resolve(d.toString('latin1'))));
  }

  it('tunnels an allowed host once the SNI matches, to a vetted public IP', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(
      upstream,
      {},
      { 'registry.npmjs.org': ['10.0.0.5', '104.16.1.1'] },
    );
    const { status, socket } = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const hello = clientHello({ sni: ['registry.npmjs.org'] });
    socket.write(hello);
    expect(await readSome(socket)).toBe('PONG');
    expect(Buffer.concat(upstream.received).equals(hello)).toBe(true);
    expect(proxy.connects).toEqual([{ host: '104.16.1.1', port: 443 }]);
    expect(proxy.logs).toContainEqual({ event: 'allow', host: 'registry.npmjs.org', port: 443 });
  });

  it('accepts a ClientHello delivered in small pieces', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const { socket } = await connectVia(proxy.proxyPort, 'npm.pkg.github.com:443');
    const hello = clientHello({ sni: ['npm.pkg.github.com'] });
    for (let i = 0; i < hello.length; i += 7) socket.write(hello.subarray(i, i + 7));
    expect(await readSome(socket)).toBe('PONG');
  });

  it('closes the tunnel on an SNI mismatch (CDN fronting) without sending anything', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const { status, socket } = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
    expect(status).toContain('200');
    socket.write(clientHello({ sni: ['attacker.example.com'] }));
    await waitClose(socket);
    expect(upstream.received).toHaveLength(0);
    expect(proxy.logs).toContainEqual(
      expect.objectContaining({ event: 'deny', reason: 'sni_mismatch' }),
    );
  });

  it('closes the tunnel when the client does not speak TLS, uses ECH or omits the SNI', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    for (const payload of [
      Buffer.from('GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n'),
      clientHello({ sni: ['registry.npmjs.org'], ech: true }),
      clientHello(),
    ]) {
      const { socket } = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
      socket.write(payload);
      await waitClose(socket);
    }
    expect(upstream.received).toHaveLength(0);
    const reasons = proxy.logs.filter((l) => l.event === 'deny').map((l) => l.reason);
    expect(reasons).toEqual(['not_tls', 'ech_not_allowed', 'sni_mismatch']);
  });

  it('closes the tunnel when no ClientHello arrives in time', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream, { helloTimeoutMs: 150 });
    const { socket } = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
    await waitClose(socket);
    expect(proxy.logs).toContainEqual(expect.objectContaining({ reason: 'hello_timeout' }));
  });

  it('refuses hosts outside the allow-list, other ports and non-public answers', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(
      upstream,
      {},
      { 'npm.pkg.github.com': ['169.254.169.254', '10.1.2.3', '::ffff:127.0.0.1'] },
    );
    for (const target of [
      'example.com:443',
      'registry.npmjs.org:80',
      'registry.npmjs.org:22',
      'npm.pkg.github.com:443',
      '169.254.169.254:80',
      'localhost:443',
    ]) {
      const { status } = await connectVia(proxy.proxyPort, target);
      expect(status, target).toBe('HTTP/1.1 403 Forbidden');
    }
    expect(proxy.connects).toHaveLength(0);
    const reasons = proxy.logs.filter((l) => l.event === 'deny').map((l) => l.reason);
    expect(reasons).toEqual([
      'host_not_allowed',
      'port_not_allowed',
      'port_not_allowed',
      'non_public_address',
      'invalid_target',
      'invalid_target',
    ]);
  });

  it('refuses plain HTTP proxy requests', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const res = await fetch(`http://127.0.0.1:${proxy.proxyPort}/`, { method: 'GET' });
    expect(res.status).toBe(403);
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(proxy.proxyPort, '127.0.0.1', () => {
        s.write('GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
      });
      s.once('data', (d) => {
        resolve(d.toString('latin1'));
        s.destroy();
      });
    });
    expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
    expect(proxy.connects).toHaveLength(0);
    expect(proxy.logs).toContainEqual(
      expect.objectContaining({ event: 'deny', reason: 'plain_http', host: 'registry.npmjs.org' }),
    );
  });

  it('caps concurrent connections', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream, { maxConnections: 1 });
    const first = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
    expect(first.status).toContain('200');
    const second = await connectVia(proxy.proxyPort, 'registry.npmjs.org:443');
    expect(second.status).toBe('HTTP/1.1 503 Service Unavailable');
  });

  it('forwards the gateway port to its fixed upstream only', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream, {
      gateway: { listenPort: 0, upstreamHost: 'host.docker.internal', upstreamPort: 8787 },
    });
    expect(proxy.gatewayPort).not.toBeNull();
    const socket = net.connect(proxy.gatewayPort!, '127.0.0.1');
    closers.push(async () => {
      socket.destroy();
    });
    socket.write('POST /v1/messages HTTP/1.1\r\n\r\n');
    expect(await readSome(socket)).toBe('PONG');
    expect(proxy.connects).toEqual([{ host: 'host.docker.internal', port: 8787 }]);
    expect(proxy.logs).toContainEqual({ event: 'gateway' });
  });
});
