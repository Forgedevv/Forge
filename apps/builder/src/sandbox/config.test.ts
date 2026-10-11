import { describe, expect, it } from 'vitest';
import { loadSandboxConfig, PINNED_IMAGE_RE, resolveSandboxConfig } from './config.js';
import { buildProxyConfig, parseProxyLog, sandboxProxyEnv } from './network.js';
import { SandboxError } from './errors.js';

const ID = `sha256:${'c'.repeat(64)}`;
const ROOT = process.platform === 'win32' ? 'C:\\forge\\jobs' : '/srv/forge/jobs';

describe('PINNED_IMAGE_RE', () => {
  it('accepts digests and image IDs only', () => {
    for (const ok of [
      ID,
      `node@${ID}`,
      `node:22-bookworm-slim@${ID}`,
      `ghcr.io/forgedevv/sandbox@${ID}`,
      `localhost:5000/forge/sandbox@${ID}`,
    ]) {
      expect(PINNED_IMAGE_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      'node:22',
      'node',
      'ghcr.io/forgedevv/sandbox:latest',
      `--privileged@${ID}`,
      `sha256:${'c'.repeat(63)}`,
      `node@sha256:${'C'.repeat(64)}`,
      `${ID} --privileged`,
    ]) {
      expect(PINNED_IMAGE_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('loadSandboxConfig', () => {
  const env = {
    FORGE_SANDBOX_IMAGE: ID,
    FORGE_SANDBOX_PROXY_IMAGE: ID,
    FORGE_SANDBOX_JOBS_ROOT: ROOT,
  };

  it('reads the required variables and applies defaults', () => {
    const c = loadSandboxConfig(env);
    expect(c).toMatchObject({
      image: ID,
      proxyImage: ID,
      uid: 1000,
      gid: 1000,
      dockerBinary: 'docker',
      gateway: null,
      egressNetwork: 'forge-egress-out',
      runtime: undefined,
    });
    expect(c.egressHosts.npm).toEqual(['registry.npmjs.org']);
  });

  it('parses the optional variables', () => {
    const c = loadSandboxConfig({
      ...env,
      FORGE_SANDBOX_GATEWAY_UPSTREAM: 'host.docker.internal:8787',
      FORGE_SANDBOX_RUNTIME: 'runsc',
      FORGE_SANDBOX_UID: '1001',
      FORGE_SANDBOX_GID: '1001',
    });
    expect(c.gateway).toEqual({ host: 'host.docker.internal', port: 8787 });
    expect(c.runtime).toBe('runsc');
    expect(c.uid).toBe(1001);
  });

  it('refuses missing, unpinned or unsafe values', () => {
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_IMAGE: '' })).toThrow(/required/);
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_IMAGE: 'node:22' })).toThrow(/pinned/);
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_JOBS_ROOT: 'jobs' })).toThrow(
      /absolute/,
    );
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_UID: '0' })).toThrow();
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_RUNTIME: 'kata' })).toThrow();
    expect(() => loadSandboxConfig({ ...env, FORGE_SANDBOX_GATEWAY_UPSTREAM: 'nope' })).toThrow();
    expect(() =>
      resolveSandboxConfig({
        image: ID,
        proxyImage: ID,
        jobsRoot: ROOT,
        egressHosts: { npm: ['10.0.0.1:80'] },
      }),
    ).toThrow();
  });
});

describe('egress helpers', () => {
  const config = resolveSandboxConfig({
    image: ID,
    proxyImage: ID,
    jobsRoot: ROOT,
    gateway: { host: 'host.docker.internal', port: 8787 },
  });

  it('builds the proxy config of the presets', () => {
    expect(buildProxyConfig(['npm'], config)).toMatchObject({
      allowHosts: ['registry.npmjs.org'],
      allowPorts: [443],
      gateway: null,
    });
    expect(buildProxyConfig(['gateway'], config)).toMatchObject({
      allowHosts: [],
      gateway: { listenPort: 8788, upstreamHost: 'host.docker.internal', upstreamPort: 8787 },
    });
    const noGateway = { ...config, gateway: null };
    expect(() => buildProxyConfig(['gateway'], noGateway)).toThrow(SandboxError);
  });

  it('points the tools at the proxy', () => {
    expect(sandboxProxyEnv(['npm'])).toMatchObject({
      HTTPS_PROXY: 'http://forge-egress:3128',
      https_proxy: 'http://forge-egress:3128',
      NO_PROXY: 'localhost,127.0.0.1,forge-egress',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(sandboxProxyEnv(['npm']).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(sandboxProxyEnv(['gateway']).ANTHROPIC_BASE_URL).toBe('http://forge-egress:8788');
  });

  it('parses and bounds the proxy log', () => {
    const lines = [
      '{"event":"ready"}',
      'not json',
      '{"event":"allow","host":"registry.npmjs.org","port":443}',
      '{"event":"allow","host":"registry.npmjs.org","port":443}',
      '{"event":"gateway"}',
      '{"event":"gateway"}',
      ...Array.from(
        { length: 80 },
        (_, i) =>
          `{"event":"deny","reason":"host_not_allowed","host":"h${i}.example.com","port":443}`,
      ),
      '{"event":"deny","reason":"plain_http","host":null}',
    ];
    const report = parseProxyLog(lines.join('\n'));
    expect(report.allowed).toEqual(['registry.npmjs.org:443']);
    expect(report.gatewayConnections).toBe(2);
    expect(report.denied).toHaveLength(50);
    expect(report.denied[0]).toEqual({
      reason: 'host_not_allowed',
      host: 'h0.example.com',
      port: 443,
    });
  });
});
