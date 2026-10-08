/**
 * Opt-in integration test against a real Docker daemon (Linux or Docker Desktop).
 *
 *   FORGE_SANDBOX_INTEGRATION=1 pnpm --filter @forge/builder exec vitest run src/sandbox/sandbox.integration.test.ts
 *
 * Builds both images (unless FORGE_SANDBOX_IMAGE / FORGE_SANDBOX_PROXY_IMAGE are set),
 * then checks on a tiny sample project: registry egress works through the proxy,
 * every other destination is blocked, the build runs with no network, writes outside
 * the workdir fail, timeouts kill the container and secrets are redacted.
 * Network use: registry.npmjs.org only (plus the Docker Hub base image if not cached).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from './build.js';
import { REDACTED } from './redact.js';
import { createSandboxRunner, type SandboxRunner } from './run.js';

const enabled = process.env.FORGE_SANDBOX_INTEGRATION === '1';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const builderDir = path.resolve(here, '..', '..');
const dockerDir = path.join(builderDir, 'docker');

const SAMPLE_PACKAGE = {
  name: 'forge-sandbox-sample',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: { build: 'node build.mjs' },
  dependencies: { 'is-number': '7.0.0' },
};

const SAMPLE_BUILD = `import isNumber from 'is-number';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<p>' + isNumber(42) + '</p>');
console.log('built');
`;

/** Runs inside the sandbox and prints what it could and could not do. */
const PROBE = `import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';

const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const gwPort = Number(process.env.PROBE_GATEWAY_PORT || 9);

function connectDirect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(4000, () => done('timeout'));
    s.on('connect', () => done('connected'));
    s.on('error', (e) => done('error:' + e.code));
  });
}

function viaProxy(target, servername) {
  return new Promise((resolve) => {
    if (!proxy) return resolve({ connect: 'no-proxy' });
    const res = {};
    const s = net.connect(Number(proxy.port), proxy.hostname);
    const timer = setTimeout(() => { s.destroy(); resolve({ ...res, timeout: true }); }, 15000);
    const finish = (extra) => { clearTimeout(timer); s.destroy(); resolve({ ...res, ...extra }); };
    s.on('error', (e) => finish({ error: e.code }));
    s.on('connect', () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\\r\\n\\r\\n')) return;
      s.off('data', onData);
      res.connect = head.split('\\r\\n')[0];
      if (!res.connect.includes(' 200 ') || !servername) return finish({});
      const t = tls.connect({ socket: s, servername });
      t.on('secureConnect', () => t.write('GET /-/ping HTTP/1.1\\r\\nHost: ' + servername + '\\r\\nConnection: close\\r\\n\\r\\n'));
      t.once('data', (x) => finish({ http: x.toString('latin1').split('\\r\\n')[0] }));
      t.on('error', (e) => finish({ tls: 'error:' + (e.code || e.message) }));
      t.on('close', () => finish({ tls: res.tls || 'closed' }));
    };
    s.on('data', onData);
  });
}

async function lookup(host) {
  try { return 'resolved:' + (await dns.lookup(host)).address; } catch (e) { return 'error:' + e.code; }
}

function tryWrite(p) {
  try { fs.writeFileSync(p, 'x'); return 'ok'; } catch (e) { return e.code; }
}

const status = Object.fromEntries(
  fs.readFileSync('/proc/self/status', 'utf8').split('\\n')
    .filter((l) => /^(CapEff|CapBnd|NoNewPrivs|Seccomp):/.test(l))
    .map((l) => l.split(':').map((x) => x.trim())),
);

const out = {
  uid: process.getuid(),
  gid: process.getgid(),
  status,
  interfaces: Object.keys(os.networkInterfaces()),
  writes: {
    etc: tryWrite('/etc/forge-probe'),
    usr: tryWrite('/usr/local/forge-probe'),
    root: tryWrite('/forge-probe'),
    procSys: tryWrite('/proc/sys/kernel/hostname'),
    workspace: tryWrite('/workspace/forge-probe.txt'),
    tmp: tryWrite('/tmp/forge-probe'),
  },
  dockerSock: fs.existsSync('/var/run/docker.sock'),
  dns: {
    external: await lookup('example.com'),
    hostInternal: await lookup('host.docker.internal'),
    proxyAlias: await lookup('forge-egress'),
  },
  direct: {
    internet: await connectDirect('1.1.1.1', 443),
    metadata: await connectDirect('169.254.169.254', 80),
    dockerDesktopHost: await connectDirect('192.168.65.254', gwPort),
    dockerBridgeHost: await connectDirect('172.17.0.1', gwPort),
  },
  proxy: {
    registry: await viaProxy('registry.npmjs.org:443', 'registry.npmjs.org'),
    otherHost: await viaProxy('example.com:443', 'example.com'),
    metadata: await viaProxy('169.254.169.254:80'),
    ipLiteral: await viaProxy('104.16.0.1:443'),
    port80: await viaProxy('registry.npmjs.org:80'),
    sniMismatch: await viaProxy('registry.npmjs.org:443', 'example.com'),
    hostGateway: await viaProxy('host.docker.internal:' + gwPort),
  },
  fetch: {
    registry: await fetch('https://registry.npmjs.org/-/ping').then((r) => r.status, (e) => 'error:' + (e.cause?.code || e.message)),
    otherHost: await fetch('https://example.com/').then((r) => r.status, (e) => 'error:' + (e.cause?.code || e.message)),
  },
  gateway: process.env.ANTHROPIC_BASE_URL
    ? await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN || '' },
        body: '{}',
      }).then(async (r) => ({ status: r.status, body: await r.text() }), (e) => 'error:' + (e.cause?.code || e.message))
    : null,
};
console.log('PROBE ' + JSON.stringify(out));
console.log('TOKEN ' + (process.env.ANTHROPIC_AUTH_TOKEN || 'none'));
`;

async function buildImage(dockerfile: string, context: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'forge-iid-'));
  const iidFile = path.join(dir, 'iid');
  await exec(
    'docker',
    ['build', '-f', path.join(dockerDir, dockerfile), '--iidfile', iidFile, context],
    {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  );
  const id = (await readFile(iidFile, 'utf8')).trim();
  await rm(dir, { recursive: true, force: true });
  return id;
}

// The probe output is free-form JSON, checked field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseProbe(stdout: string): Record<string, any> {
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE '));
  if (!line) throw new Error(`no probe output:\n${stdout}`);
  return JSON.parse(line.slice('PROBE '.length));
}

describe.skipIf(!enabled)('sandbox integration (real Docker)', () => {
  let runner: SandboxRunner;
  let jobsRoot: string;
  let workdir: string;
  let gateway: http.Server;
  let gatewayPort: number;
  const gatewayHits: Array<{ path: string | undefined; tokenMatches: boolean }> = [];
  const gatewayToken = `forge_gw_${randomBytes(32).toString('base64url')}`;

  beforeAll(
    async () => {
      const image =
        process.env.FORGE_SANDBOX_IMAGE || (await buildImage('sandbox.Dockerfile', dockerDir));
      const proxyImage =
        process.env.FORGE_SANDBOX_PROXY_IMAGE ||
        (await buildImage('egress-proxy.Dockerfile', builderDir));

      // Stand-in for the AI gateway on the host (loopback only).
      gateway = http.createServer((req, res) => {
        gatewayHits.push({
          path: req.url,
          tokenMatches: req.headers['x-api-key'] === gatewayToken,
        });
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, auth: req.headers['x-api-key'] === gatewayToken }));
      });
      await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
      gatewayPort = (gateway.address() as AddressInfo).port;

      jobsRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-sbx-it-'));
      workdir = path.join(jobsRoot, 'job-it');
      await mkdir(workdir);
      await writeFile(path.join(workdir, 'package.json'), JSON.stringify(SAMPLE_PACKAGE, null, 2));
      await writeFile(path.join(workdir, 'build.mjs'), SAMPLE_BUILD);
      await writeFile(path.join(workdir, 'probe.mjs'), PROBE);

      runner = createSandboxRunner({
        image,
        proxyImage,
        jobsRoot,
        gateway: { host: 'host.docker.internal', port: gatewayPort },
      });
      await runner.cleanupStale();
    },
    20 * 60 * 1000,
  );

  afterAll(async () => {
    await new Promise<void>((r) => (gateway ? gateway.close(() => r()) : r()));
    if (jobsRoot) await rm(jobsRoot, { recursive: true, force: true });
  });

  it(
    'resolves dependencies from the registry through the egress proxy',
    async () => {
      const res = await runner.run({
        jobId: 'it-lock',
        workdir,
        command: [
          'pnpm',
          'install',
          '--lockfile-only',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--reporter=append-only',
        ],
        timeoutMs: 5 * 60 * 1000,
        memoryMb: 1024,
        cpus: 1,
        network: 'allowlist',
        allow: ['npm'],
      });
      expect(res.ok, `${res.stdout}\n${res.stderr}`).toBe(true);
      expect(res.egress?.allowed).toContain('registry.npmjs.org:443');
      const lock = await readFile(path.join(workdir, 'pnpm-lock.yaml'), 'utf8');
      expect(lock).toContain('is-number');
    },
    6 * 60 * 1000,
  );

  it(
    'builds the sample site: install with registry egress, build with no network',
    async () => {
      const res = await buildSite(runner, workdir, {
        jobId: 'it-build',
        outputDir: 'dist',
        install: { memoryMb: 1024, homeSizeMb: 512 },
        build: { memoryMb: 512, homeSizeMb: 64 },
      });
      expect(res.ok, res.logs).toBe(true);
      expect(res.packageManager).toBe('pnpm');
      expect(res.artifactsPath).toBeTruthy();
      expect(await readFile(path.join(res.artifactsPath!, 'index.html'), 'utf8')).toBe(
        '<p>true</p>',
      );
      expect(res.steps.build?.egress).toBeNull();
    },
    10 * 60 * 1000,
  );

  it(
    'blocks every destination outside the allow-list and confines the filesystem',
    async () => {
      const res = await runner.run({
        jobId: 'it-probe',
        workdir,
        command: ['node', 'probe.mjs'],
        env: { PROBE_GATEWAY_PORT: String(gatewayPort) },
        secrets: { gatewayToken },
        timeoutMs: 3 * 60 * 1000,
        memoryMb: 512,
        cpus: 1,
        network: 'allowlist',
        allow: ['npm', 'gateway'],
      });
      expect(res.exitCode, res.stderr).toBe(0);
      const probe = parseProbe(res.stdout);
      console.log(JSON.stringify(probe, null, 2));

      // Identity and kernel-level hardening.
      expect(probe.uid).toBe(1000);
      expect(probe.status.CapEff).toBe('0000000000000000');
      expect(probe.status.CapBnd).toBe('0000000000000000');
      expect(probe.status.NoNewPrivs).toBe('1');
      expect(probe.status.Seccomp).toBe('2');
      expect(probe.dockerSock).toBe(false);

      // Filesystem: only the workdir and the tmpfs are writable.
      expect(probe.writes.etc).toMatch(/EROFS|EACCES/);
      expect(probe.writes.usr).toMatch(/EROFS|EACCES/);
      expect(probe.writes.root).toMatch(/EROFS|EACCES/);
      expect(probe.writes.procSys).toMatch(/EROFS|EACCES|ENOENT/);
      expect(probe.writes.workspace).toBe('ok');
      expect(probe.writes.tmp).toBe('ok');
      expect(await readFile(path.join(workdir, 'forge-probe.txt'), 'utf8')).toBe('x');

      // DNS only knows the proxy.
      expect(probe.dns.external).toMatch(/^error:/);
      expect(probe.dns.hostInternal).toMatch(/^error:/);
      expect(probe.dns.proxyAlias).toMatch(/^resolved:/);

      // No direct route anywhere: internet, metadata, Docker host.
      for (const [target, outcome] of Object.entries(probe.direct)) {
        expect(outcome, target).not.toBe('connected');
      }

      // Through the proxy: the registry only, with a matching SNI.
      expect(probe.proxy.registry.connect).toContain(' 200 ');
      expect(probe.proxy.registry.http).toMatch(/^HTTP\/1\.1 200/);
      expect(probe.proxy.otherHost.connect).toContain(' 403 ');
      expect(probe.proxy.metadata.connect).toContain(' 403 ');
      expect(probe.proxy.ipLiteral.connect).toContain(' 403 ');
      expect(probe.proxy.port80.connect).toContain(' 403 ');
      expect(probe.proxy.hostGateway.connect).toContain(' 403 ');
      expect(probe.proxy.sniMismatch.connect).toContain(' 200 ');
      expect(probe.proxy.sniMismatch.http).toBeUndefined();
      expect(probe.fetch.otherHost).not.toBe(200);

      // The gateway forward reaches the host gateway with the job token.
      expect(probe.gateway).toMatchObject({ status: 200 });
      expect(JSON.parse(probe.gateway.body)).toEqual({ ok: true, auth: true });
      expect(gatewayHits.some((h) => h.path === '/v1/messages' && h.tokenMatches)).toBe(true);

      // The token printed by the hostile process is redacted.
      expect(res.stdout).toContain(`TOKEN ${REDACTED}`);
      expect(res.stdout).not.toContain(gatewayToken);

      expect(res.egress?.allowed).toContain('registry.npmjs.org:443');
      const deniedReasons = res.egress?.denied.map((d) => d.reason) ?? [];
      expect(deniedReasons).toEqual(
        expect.arrayContaining([
          'host_not_allowed',
          'invalid_target',
          'port_not_allowed',
          'sni_mismatch',
        ]),
      );
    },
    5 * 60 * 1000,
  );

  it(
    'has no network at all in mode none',
    async () => {
      const res = await runner.run({
        jobId: 'it-none',
        workdir,
        command: ['node', 'probe.mjs'],
        timeoutMs: 2 * 60 * 1000,
        memoryMb: 256,
        cpus: 1,
        network: 'none',
      });
      expect(res.exitCode, res.stderr).toBe(0);
      const probe = parseProbe(res.stdout);
      expect(probe.interfaces).toEqual(['lo']);
      expect(probe.proxy.registry.connect).toBe('no-proxy');
      expect(probe.fetch.registry).toMatch(/^error:/);
      expect(probe.dns.external).toMatch(/^error:/);
      expect(probe.direct.internet).not.toBe('connected');
      expect(res.stdout).toContain('TOKEN none');
    },
    3 * 60 * 1000,
  );

  it(
    'kills a container at its wall-clock timeout and removes it',
    async () => {
      const started = Date.now();
      const res = await runner.run({
        jobId: 'it-timeout',
        workdir,
        command: ['sleep', '600'],
        timeoutMs: 3000,
        memoryMb: 128,
        cpus: 0.5,
        network: 'none',
      });
      expect(res.timedOut).toBe(true);
      expect(res.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(60_000);
      const ps = await exec('docker', [
        'ps',
        '--all',
        '--filter',
        `label=forge.sandbox.run=${res.runId}`,
        '--quiet',
      ]);
      expect(ps.stdout.trim()).toBe('');
    },
    2 * 60 * 1000,
  );

  it(
    'caps the captured output',
    async () => {
      const res = await runner.run({
        jobId: 'it-output',
        workdir,
        command: ['node', '-e', "process.stdout.write('y'.repeat(3 * 1024 * 1024))"],
        timeoutMs: 60_000,
        memoryMb: 256,
        cpus: 1,
        network: 'none',
        maxOutputBytes: 64 * 1024,
      });
      expect(res.ok).toBe(true);
      expect(res.truncated.stdout).toBe(true);
      expect(res.outputBytes.stdout).toBe(3 * 1024 * 1024);
      expect(res.stdout.length).toBeLessThan(64 * 1024 + 200);
    },
    2 * 60 * 1000,
  );

  it('leaves no sandbox network or proxy behind', async () => {
    const nets = await exec('docker', [
      'network',
      'ls',
      '--filter',
      'label=forge.sandbox=1',
      '--quiet',
    ]);
    expect(nets.stdout.trim()).toBe('');
    const ctrs = await exec('docker', [
      'ps',
      '--all',
      '--filter',
      'label=forge.sandbox=1',
      '--quiet',
    ]);
    expect(ctrs.stdout.trim()).toBe('');
  });
});
