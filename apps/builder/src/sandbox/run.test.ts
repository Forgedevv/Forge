import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxError } from './errors.js';
import { REDACTED } from './redact.js';
import { createSandboxRunner, type SandboxDeps } from './run.js';
import { fakeDocker, type FakeScenario } from './test-helpers.js';
import type { SandboxRunOptions } from './types.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `ghcr.io/forgedevv/egress@sha256:${'b'.repeat(64)}`;
const GATEWAY_TOKEN = `forge_gw_${'T'.repeat(43)}`;
const GITHUB_PAT = `ghp_${'p'.repeat(36)}`;
const HOST_ENV = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/builder',
  DOCKER_HOST: 'unix:///run/docker.sock',
  ANTHROPIC_API_KEY: 'sk-ant-api03-REAL-HOST-KEY-000000',
  SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-host-value',
  VERCEL_TOKEN: 'vercelHostToken12345678',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
};

let jobsRoot: string;
let workdir: string;
let outside: string;

beforeAll(async () => {
  jobsRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-sbx-unit-'));
  workdir = path.join(jobsRoot, 'job-1');
  outside = await mkdtemp(path.join(os.tmpdir(), 'forge-sbx-outside-'));
  await mkdir(workdir);
});

afterAll(async () => {
  await rm(jobsRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function setup(scenario: FakeScenario = {}, deps: SandboxDeps = {}, gateway = true) {
  const docker = fakeDocker(scenario);
  const runner = createSandboxRunner(
    {
      image: IMAGE,
      proxyImage: PROXY_IMAGE,
      jobsRoot,
      hostEnv: HOST_ENV,
      gateway: gateway ? { host: 'host.docker.internal', port: 8787 } : null,
    },
    {
      spawn: docker.spawn,
      randomSuffix: () => 'abcd1234',
      sleep: async () => undefined,
      timings: { killGraceMs: 50, proxyPollMs: 1 },
      ...deps,
    },
  );
  return { docker, runner };
}

function options(overrides: Partial<SandboxRunOptions> = {}): SandboxRunOptions {
  return {
    jobId: 'job-1',
    workdir,
    command: ['node', '--version'],
    timeoutMs: 60_000,
    memoryMb: 1024,
    cpus: 1,
    network: 'none',
    ...overrides,
  };
}

async function expectError(promise: Promise<unknown>, code: SandboxError['code']): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SandboxError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('runInSandbox (network none)', () => {
  it('creates, attaches, inspects and removes one hardened container', async () => {
    const { docker, runner } = setup({ stdout: 'v22.0.0\n', exitCode: 0 });
    const result = await runner.run(options());
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      killedReason: null,
      stdout: 'v22.0.0\n',
      egress: null,
    });
    expect(docker.sequence()).toEqual(['create', 'start --attach', 'inspect', 'rm']);
    const create = docker.find('create')[0]!;
    expect(create.args).toContain('--network=none');
    expect(create.args).toContain('--read-only');
    expect(create.args).toContain('--cap-drop=ALL');
    expect(create.args).toContain(`--mount=type=bind,source=${workdir},target=/workspace`);
    expect(create.args).toContain('--env=HOME=/home/node');
    expect(create.args.some((a) => a.includes('PROXY'))).toBe(false);
    expect(docker.find('rm', '--force', '--volumes', 'forge-sbx-job-1-abcd1234')).toHaveLength(1);
  });

  it('gives the docker CLI a minimal environment without host secrets', async () => {
    const { docker, runner } = setup();
    await runner.run(options());
    for (const call of docker.calls) {
      expect(call.env.PATH).toBe(HOST_ENV.PATH);
      expect(call.env.DOCKER_HOST).toBe(HOST_ENV.DOCKER_HOST);
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(call.env.VERCEL_TOKEN).toBeUndefined();
      expect(call.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      const joined = call.args.join(' ');
      for (const value of Object.values(HOST_ENV).slice(3)) expect(joined).not.toContain(value);
    }
  });

  it('reports a failing exit code and OOM kills', async () => {
    const failing = setup({ exitCode: 2, stderr: 'boom' });
    expect(await failing.runner.run(options())).toMatchObject({
      ok: false,
      exitCode: 2,
      stderr: 'boom',
    });
    const oom = setup({ exitCode: 137, oomKilled: true });
    expect(await oom.runner.run(options())).toMatchObject({ ok: false, oomKilled: true });
  });

  it('treats exit 124 of the in-container deadline as a timeout', async () => {
    const { runner } = setup({ exitCode: 124 });
    expect(await runner.run(options())).toMatchObject({
      ok: false,
      timedOut: true,
      killedReason: 'timeout',
    });
  });

  it('kills the container at the wall-clock timeout and still cleans up', async () => {
    const { docker, runner } = setup({ hang: true });
    const started = Date.now();
    const result = await runner.run(options({ timeoutMs: 1000 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      killedReason: 'timeout',
      exitCode: 137,
    });
    expect(docker.find('kill', '--signal=KILL', 'forge-sbx-job-1-abcd1234')).toHaveLength(1);
    expect(docker.find('rm')).toHaveLength(1);
    expect(docker.containers.size).toBe(0);
  });

  it('kills the attached CLI too if it does not exit after docker kill', async () => {
    const { docker, runner } = setup({ hang: true, stuckCli: true });
    const result = await runner.run(options({ timeoutMs: 1000 }));
    expect(result.killedReason).toBe('timeout');
    expect(docker.attached.get('forge-sbx-job-1-abcd1234')?.killedWith).toBe('SIGKILL');
  });

  it('kills a container that floods its output', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const { docker, runner } = setup(
      { hang: true, stdout: Array.from({ length: 40 }, () => chunk) },
      { timings: { killGraceMs: 50, proxyPollMs: 1, hardOutputLimitBytes: 1024 * 1024 } },
    );
    const result = await runner.run(options({ maxOutputBytes: 4096 }));
    expect(result.killedReason).toBe('output_limit');
    expect(result.truncated.stdout).toBe(true);
    expect(result.outputBytes.stdout).toBeGreaterThan(1024 * 1024);
    expect(result.stdout.length).toBeLessThan(4096 + 200);
    expect(docker.find('kill')).toHaveLength(1);
  });

  it('kills the container when the run is aborted', async () => {
    const { runner } = setup({ hang: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runner.run(options({ signal: controller.signal }));
    expect(result.killedReason).toBe('aborted');
  });

  it('redacts secrets from the output', async () => {
    const { runner } = setup({
      stdout: `token=${GATEWAY_TOKEN} key=${HOST_ENV.VERCEL_TOKEN}\n`,
      stderr: `${HOST_ENV.ANTHROPIC_API_KEY}`,
    });
    const result = await runner.run(
      options({
        network: 'allowlist',
        allow: ['gateway'],
        secrets: { gatewayToken: GATEWAY_TOKEN },
      }),
    );
    expect(result.stdout).toBe(`token=${REDACTED} key=${REDACTED}\n`);
    expect(result.stderr).toBe(REDACTED);
  });

  it('turns a docker create failure into an error, redacted', async () => {
    const { docker, runner } = setup({
      createCode: 125,
      createStderr: `bad ${HOST_ENV.VERCEL_TOKEN}`,
    });
    const promise = runner.run(options());
    await expectError(promise, 'docker_failed');
    await expect(promise).rejects.toThrow(/bad \[REDACTED\]/);
    expect(docker.find('start')).toHaveLength(0);
  });
});

describe('runInSandbox (network allowlist)', () => {
  it('sets up the internal network and the egress proxy, then tears everything down', async () => {
    const { docker, runner } = setup({ stdout: 'ok' });
    const result = await runner.run(
      options({
        network: 'allowlist',
        allow: ['npm', 'gateway'],
        secrets: { gatewayToken: GATEWAY_TOKEN },
      }),
    );
    expect(result.ok).toBe(true);
    expect(docker.sequence()).toEqual([
      'network inspect',
      'network create',
      'create',
      'network connect',
      'start',
      'logs',
      'create',
      'start --attach',
      'inspect',
      'rm',
      'logs',
      'rm',
      'network rm',
    ]);
    const internal = docker.find('network', 'create')[0]!;
    expect(internal.args).toContain('--internal');
    expect(internal.args).toContain('--opt=com.docker.network.bridge.inhibit_ipv4=true');
    expect(internal.args[internal.args.length - 1]).toBe('forge-sbx-net-job-1-abcd1234');

    const [proxyCreate, sandboxCreate] = docker.find('create');
    const configFlag = proxyCreate!.args.find((a) => a.startsWith('--env=FORGE_EGRESS_CONFIG='))!;
    const proxyConfig = JSON.parse(configFlag.slice('--env=FORGE_EGRESS_CONFIG='.length));
    // The public npm registry is the only registry (decision D26).
    expect(proxyConfig.allowHosts).toEqual(['registry.npmjs.org']);
    expect(proxyConfig.allowPorts).toEqual([443]);
    expect(proxyConfig.gateway).toEqual({
      listenPort: 8788,
      upstreamHost: 'host.docker.internal',
      upstreamPort: 8787,
    });
    expect(proxyCreate!.args).toContain('--add-host=host.docker.internal:host-gateway');
    expect(proxyCreate!.args).toContain('--network=forge-egress-out');
    expect(docker.find('network', 'connect')[0]!.args).toEqual([
      'network',
      'connect',
      '--alias=forge-egress',
      'forge-sbx-net-job-1-abcd1234',
      'forge-egress-job-1-abcd1234',
    ]);

    const s = sandboxCreate!.args;
    expect(s).toContain('--network=forge-sbx-net-job-1-abcd1234');
    expect(s).not.toContain('--add-host=host.docker.internal:host-gateway');
    expect(s).toContain('--env=HTTPS_PROXY=http://forge-egress:3128');
    expect(s).toContain('--env=NO_PROXY=localhost,127.0.0.1,forge-egress');
    expect(s).toContain('--env=ANTHROPIC_BASE_URL=http://forge-egress:8788');
    // Secrets: names on the command line, values only in the CLI process env.
    expect(s).toContain('--env=ANTHROPIC_AUTH_TOKEN');
    // No registry token exists anymore: nothing maps to NODE_AUTH_TOKEN.
    expect(s.filter((a) => a.startsWith('--env=NODE_AUTH_TOKEN'))).toEqual([]);
    for (const call of docker.calls) {
      expect(call.args.join(' ')).not.toContain(GATEWAY_TOKEN);
    }
    expect(sandboxCreate!.env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_TOKEN);
    expect(sandboxCreate!.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(proxyCreate!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(docker.calls.filter((c) => c.env.ANTHROPIC_AUTH_TOKEN)).toHaveLength(1);

    expect(result.egress).toEqual({
      allowed: ['registry.npmjs.org:443'],
      denied: [{ reason: 'host_not_allowed', host: 'example.com', port: 443 }],
      gatewayConnections: 0,
    });
  });

  it('only allows the hosts of the requested presets', async () => {
    const { docker, runner } = setup();
    await runner.run(options({ network: 'allowlist', allow: ['npm'] }));
    const proxyCreate = docker.find('create')[0]!;
    const json = proxyCreate.args.find((a) => a.startsWith('--env=FORGE_EGRESS_CONFIG='))!;
    const config = JSON.parse(json.slice('--env=FORGE_EGRESS_CONFIG='.length));
    expect(config.allowHosts).toEqual(['registry.npmjs.org']);
    expect(config.gateway).toBeNull();
    expect(proxyCreate.args).not.toContain('--add-host=host.docker.internal:host-gateway');
    expect(
      docker.find('create')[1]!.args.some((a) => a.startsWith('--env=ANTHROPIC_BASE_URL')),
    ).toBe(false);
  });

  it('creates the shared egress bridge with inter-container traffic disabled', async () => {
    const { docker, runner } = setup({ egressNetworkExists: false });
    await runner.run(options({ network: 'allowlist', allow: ['npm'] }));
    const creates = docker.find('network', 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.args).toContain('--opt=com.docker.network.bridge.enable_icc=false');
    expect(creates[0]!.args).not.toContain('--internal');
    expect(creates[0]!.args[creates[0]!.args.length - 1]).toBe('forge-egress-out');
  });

  it('refuses an egress bridge that allows inter-container traffic', async () => {
    const { docker, runner } = setup({ egressIcc: 'true' });
    await expectError(
      runner.run(options({ network: 'allowlist', allow: ['npm'] })),
      'egress_failed',
    );
    expect(docker.find('create')).toHaveLength(0);
  });

  it('cleans up when the proxy does not start, and never starts the sandbox', async () => {
    const { docker, runner } = setup({ proxyLogs: '{"event":"fatal","message":"bad config"}\n' });
    await expectError(
      runner.run(options({ network: 'allowlist', allow: ['npm'] })),
      'egress_failed',
    );
    expect(docker.find('start', '--attach')).toHaveLength(0);
    expect(docker.find('rm', '--force', 'forge-egress-job-1-abcd1234')).toHaveLength(1);
    expect(docker.find('network', 'rm', 'forge-sbx-net-job-1-abcd1234')).toHaveLength(1);
  });

  it('tears the egress down when the sandbox cannot be created', async () => {
    const { docker, runner } = setup({ createCode: 125 });
    await expectError(
      runner.run(options({ network: 'allowlist', allow: ['npm'] })),
      'docker_failed',
    );
    expect(docker.find('rm', '--force', 'forge-egress-job-1-abcd1234')).toHaveLength(1);
    expect(docker.find('network', 'rm')).toHaveLength(1);
  });

  it('refuses the gateway preset when no gateway is configured', async () => {
    const { docker, runner } = setup({}, {}, false);
    await expectError(
      runner.run(options({ network: 'allowlist', allow: ['gateway'] })),
      'unsafe_option',
    );
    expect(docker.find('create')).toHaveLength(0);
  });
});

describe('runInSandbox option checks (no docker call)', () => {
  const cases: Array<[string, Partial<SandboxRunOptions>, SandboxError['code']]> = [
    ['relative workdir', { workdir: 'job-1' }, 'unsafe_option'],
    [
      'missing workdir',
      { workdir: path.join(os.tmpdir(), 'forge-sbx-missing-xyz', 'job') },
      'invalid_options',
    ],
    ['presets with network none', { allow: ['npm'] }, 'unsafe_option'],
    ['allowlist without preset', { network: 'allowlist' }, 'unsafe_option'],
    ['duplicate preset', { network: 'allowlist', allow: ['npm', 'npm'] }, 'invalid_options'],
    ['credential env name', { env: { VERCEL_TOKEN: 'x' } }, 'unsafe_option'],
    ['reserved env name', { env: { HTTPS_PROXY: 'http://evil:1' } }, 'unsafe_option'],
    [
      'host secret in command',
      { command: ['echo', HOST_ENV.SUPABASE_SERVICE_ROLE_KEY] },
      'unsafe_option',
    ],
    ['anthropic key in env value', { env: { NOTE: 'sk-ant-api03-zzzzzzzzzzzz' } }, 'unsafe_option'],
    ['gateway token without preset', { secrets: { gatewayToken: GATEWAY_TOKEN } }, 'unsafe_option'],
    [
      'bad gateway token',
      { network: 'allowlist', allow: ['gateway'], secrets: { gatewayToken: 'x' } },
      'unsafe_option',
    ],
    ['unknown secret', { secrets: { anthropicKey: 'x' } as never }, 'invalid_options'],
    [
      'the removed packages token secret',
      { network: 'allowlist', allow: ['npm'], secrets: { packagesToken: GITHUB_PAT } as never },
      'invalid_options',
    ],
    [
      'the removed github-packages preset',
      { network: 'allowlist', allow: ['npm', 'github-packages'] as never },
      'invalid_options',
    ],
    ['a GitHub token in an env value', { env: { NOTE: GITHUB_PAT } }, 'unsafe_option'],
    [
      'an npm token in the command',
      { command: ['echo', `npm_${'n'.repeat(36)}`] },
      'unsafe_option',
    ],
    ['too much memory', { memoryMb: 1_000_000 }, 'invalid_options'],
    ['too many cpus', { cpus: 64 }, 'invalid_options'],
    ['timeout too long', { timeoutMs: 10 * 60 * 60 * 1000 }, 'invalid_options'],
    ['empty command', { command: [] }, 'invalid_options'],
    ['bad job id', { jobId: '../x' }, 'invalid_options'],
    ['working dir escape', { workingDir: '../etc' }, 'invalid_options'],
    ['unknown option', { privileged: true } as never, 'invalid_options'],
  ];
  for (const [label, overrides, code] of cases) {
    it(`refuses ${label}`, async () => {
      const { docker, runner } = setup();
      await expectError(runner.run(options(overrides)), code);
      expect(docker.calls).toHaveLength(0);
    });
  }

  it('refuses a workdir outside the jobs root, or the root itself', async () => {
    const { docker, runner } = setup();
    await expectError(runner.run(options({ workdir: outside })), 'unsafe_option');
    await expectError(runner.run(options({ workdir: jobsRoot })), 'unsafe_option');
    await expectError(
      runner.run(options({ workdir: path.join(workdir, '..', '..') })),
      'unsafe_option',
    );
    expect(docker.calls).toHaveLength(0);
  });

  it('refuses a symlinked workdir pointing outside the jobs root', async () => {
    const link = path.join(jobsRoot, 'link-job');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // symlinks not permitted on this machine
    }
    const { docker, runner } = setup();
    await expectError(runner.run(options({ workdir: link })), 'unsafe_option');
    expect(docker.calls).toHaveLength(0);
  });

  it('refuses an unpinned image in the configuration', () => {
    expect(() =>
      createSandboxRunner({ image: 'node:22', proxyImage: PROXY_IMAGE, jobsRoot }),
    ).toThrow(/pinned/);
    expect(() =>
      createSandboxRunner({ image: IMAGE, proxyImage: PROXY_IMAGE, jobsRoot, uid: 0 }),
    ).toThrow();
  });
});

describe('cleanupStale', () => {
  it('removes only expired sandbox containers and networks', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const id = (c: string) => c.repeat(64);
    const { docker, runner } = setup({
      psOutput: `${id('a')} ${nowSec - 10}\n${id('b')} ${nowSec + 600}\n${id('c')} \n`,
      networkLsOutput: `${id('d')} ${nowSec - 1}\n${id('e')} ${nowSec + 5}\n`,
    });
    expect(await runner.cleanupStale()).toEqual({ containers: 1, networks: 1 });
    expect(docker.find('rm', '--force', '--volumes', id('a'))).toHaveLength(1);
    expect(docker.find('network', 'rm', id('d'))).toHaveLength(1);
    expect(docker.find('rm').length + docker.find('network', 'rm').length).toBe(2);
  });
});
