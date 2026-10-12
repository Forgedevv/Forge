import { describe, expect, it } from 'vitest';
import {
  assertHardenedProxyArgs,
  assertHardenedSandboxArgs,
  buildProxyCreateArgs,
  buildSandboxCreateArgs,
  type ProxyPlan,
  type SandboxPlan,
} from './args.js';
import { SandboxError } from './errors.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function plan(overrides: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    name: 'forge-sbx-job-1-abcd',
    labels: { 'forge.sandbox': '1', 'forge.sandbox.job': 'job-1' },
    image: IMAGE,
    uid: 1000,
    gid: 1000,
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    network: { mode: 'none' },
    hostWorkdir: '/srv/forge/jobs/job-1',
    workingDir: '/workspace',
    tmpSizeMb: 512,
    homeSizeMb: 1024,
    env: { HOME: '/home/node', CI: 'true' },
    secretEnvNames: [],
    innerTimeoutSec: 75,
    command: ['pnpm', 'run', 'build'],
    ...overrides,
  };
}

function proxyPlan(overrides: Partial<ProxyPlan> = {}): ProxyPlan {
  return {
    name: 'forge-egress-job-1-abcd',
    labels: { 'forge.sandbox': '1' },
    image: IMAGE,
    uid: 1000,
    gid: 1000,
    egressNetwork: 'forge-egress-out',
    hostGateway: false,
    configJson: '{"allowHosts":["registry.npmjs.org"]}',
    ...overrides,
  };
}

function expectUnsafe(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe('unsafe_option');
    return;
  }
  throw new Error('expected an unsafe_option SandboxError');
}

describe('buildSandboxCreateArgs', () => {
  it('emits every hardening flag', () => {
    const args = buildSandboxCreateArgs(plan());
    for (const flag of [
      '--init',
      '--pull=never',
      '--user=1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true',
      '--pids-limit=512',
      '--memory=2048m',
      '--memory-swap=2048m',
      '--cpus=2',
      '--ulimit=nofile=4096:4096',
      '--ulimit=core=0',
      `--ulimit=fsize=${2 * 1024 * 1024 * 1024}`,
      '--oom-score-adj=500',
      '--ipc=private',
      '--cgroupns=private',
      '--network=none',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777',
      '--tmpfs=/home/node:rw,nosuid,nodev,noexec,size=1024m,uid=1000,gid=1000,mode=0700',
      '--mount=type=bind,source=/srv/forge/jobs/job-1,target=/workspace',
      '--workdir=/workspace',
      '--log-driver=none',
      '--entrypoint=/usr/bin/timeout',
    ]) {
      expect(args, flag).toContain(flag);
    }
    const imageIndex = args.indexOf(IMAGE);
    expect(args.slice(imageIndex + 1)).toEqual([
      '--kill-after=10',
      '--signal=TERM',
      '75',
      'pnpm',
      'run',
      'build',
    ]);
    expect(() => assertHardenedSandboxArgs(args)).not.toThrow();
  });

  it('never adds dangerous flags', () => {
    const args = buildSandboxCreateArgs(
      plan({ network: { mode: 'allowlist', networkName: 'forge-sbx-net-x' } }),
    );
    const flags = args.slice(0, args.indexOf(IMAGE));
    for (const f of flags) {
      expect(f.startsWith('--')).toBe(true);
      expect(f).not.toMatch(
        /^--(?:privileged|cap-add|device|volume|volumes-from|publish|add-host|pid|uts|userns|dns|link)\b/,
      );
      expect(f).not.toMatch(/=host$|unconfined|docker\.sock/);
    }
    expect(flags.filter((f) => f.startsWith('--mount=')).length).toBe(1);
    expect(flags).toContain('--network=forge-sbx-net-x');
  });

  it('passes secrets by name only', () => {
    const args = buildSandboxCreateArgs(plan({ secretEnvNames: ['ANTHROPIC_AUTH_TOKEN'] }));
    expect(args).toContain('--env=ANTHROPIC_AUTH_TOKEN');
    expect(() => assertHardenedSandboxArgs(args)).not.toThrow();
  });

  it('refuses a registry token passed by name: no install needs one (decision D26)', () => {
    const args = buildSandboxCreateArgs(
      plan({ secretEnvNames: ['ANTHROPIC_AUTH_TOKEN', 'NODE_AUTH_TOKEN'] }),
    );
    expectUnsafe(() => assertHardenedSandboxArgs(args));
  });

  it('refuses unpinned images, unsafe paths and names', () => {
    expectUnsafe(() => buildSandboxCreateArgs(plan({ image: 'node:22' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ image: '--privileged' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ hostWorkdir: '/srv/jobs/a,target=/etc' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ hostWorkdir: '/srv/jobs/"a' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ hostWorkdir: '/srv/jobs/a=b' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ workingDir: '/etc' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ workingDir: '/workspace/../etc' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ name: '--rm' })));
    expectUnsafe(() => buildSandboxCreateArgs(plan({ labels: { 'com.docker.x': '1' } })));
    expectUnsafe(() =>
      buildSandboxCreateArgs(
        plan({ network: { mode: 'allowlist', networkName: 'host --privileged' } }),
      ),
    );
  });
});

describe('assertHardenedSandboxArgs', () => {
  const good = buildSandboxCreateArgs(plan());
  const imageIndex = good.indexOf(IMAGE);

  const without = (flag: string) => good.filter((a) => a !== flag);
  const withFlag = (...flags: string[]) => [
    ...good.slice(0, imageIndex),
    ...flags,
    ...good.slice(imageIndex),
  ];
  const replace = (prefix: string, value: string) =>
    good.map((a) => (a.startsWith(prefix) ? value : a));

  it('fails when any hardening flag is missing', () => {
    for (const flag of good.slice(0, imageIndex)) {
      if (flag.startsWith('--name=') || flag.startsWith('--label=') || flag.startsWith('--env=')) {
        continue;
      }
      if (['--oom-score-adj=500', '--hostname=sandbox', '--stop-timeout=5'].includes(flag))
        continue;
      if (flag.startsWith('--shm-size=') || flag.startsWith('--tmpfs=')) continue;
      expectUnsafe(() => assertHardenedSandboxArgs(without(flag)));
    }
  });

  it('fails on any dangerous or unknown flag', () => {
    for (const flag of [
      '--privileged',
      '--cap-add=SYS_ADMIN',
      '--device=/dev/kmsg',
      '--volume=/:/host',
      '--volumes-from=other',
      '--pid=host',
      '--userns=host',
      '--uts=host',
      '--publish=8080:80',
      '--add-host=metadata:169.254.169.254',
      '--security-opt=seccomp=unconfined',
      '--security-opt=apparmor=unconfined',
      '--group-add=0',
      '--mount=type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--tmpfs=/etc:rw,nosuid,nodev,noexec,size=1m',
      '--ulimit=nproc=-1',
      '--env=ANTHROPIC_API_KEY',
      '--env=VERCEL_TOKEN=abc',
      '--env=ANTHROPIC_AUTH_TOKEN=forge_gw_inline',
      '--runtime=nvidia',
      '--network=host',
      '--rm',
    ]) {
      expectUnsafe(() => assertHardenedSandboxArgs(withFlag(flag)));
    }
  });

  it('fails on weakened values', () => {
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--user=', '--user=0:0')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--user=', '--user=node')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--memory-swap=', '--memory-swap=-1')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--memory-swap=', '--memory-swap=4096m')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--memory=', '--memory=999999m')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--pids-limit=', '--pids-limit=-1')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--cpus=', '--cpus=64')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--network=', '--network=bridge')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--network=', '--network=container:x')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--workdir=', '--workdir=/')));
    expectUnsafe(() => assertHardenedSandboxArgs(replace('--cap-drop=', '--cap-drop=NET_RAW')));
    expectUnsafe(() =>
      assertHardenedSandboxArgs(replace('--oom-score-adj=', '--oom-score-adj=-1000')),
    );
    expectUnsafe(() =>
      assertHardenedSandboxArgs(
        replace(
          '--mount=',
          '--mount=type=bind,source=/,target=/workspace,bind-propagation=rshared',
        ),
      ),
    );
    expectUnsafe(() =>
      assertHardenedSandboxArgs(replace('--tmpfs=/tmp', '--tmpfs=/tmp:rw,size=512m')),
    );
    expectUnsafe(() =>
      assertHardenedSandboxArgs(good.map((a) => (a === IMAGE ? 'node:22-bookworm-slim' : a))),
    );
    // In-container timeout wrapper removed.
    expectUnsafe(() =>
      assertHardenedSandboxArgs([...good.slice(0, imageIndex + 1), 'sh', '-c', 'x']),
    );
  });
});

describe('proxy args', () => {
  it('builds hardened proxy arguments', () => {
    const args = buildProxyCreateArgs(proxyPlan({ hostGateway: true }));
    for (const flag of [
      '--init',
      '--pull=never',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true',
      '--user=1000:1000',
      '--network=forge-egress-out',
      '--add-host=host.docker.internal:host-gateway',
      '--log-opt=max-size=1m',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args[args.length - 1]).toBe(IMAGE);
    expect(() => assertHardenedProxyArgs(args)).not.toThrow();
  });

  it('refuses a weakened proxy', () => {
    const args = buildProxyCreateArgs(proxyPlan());
    const imageIndex = args.indexOf(IMAGE);
    const withFlag = (flag: string) => [...args.slice(0, imageIndex), flag, IMAGE];
    for (const flag of [
      '--privileged',
      '--network=host',
      '--add-host=evil:10.0.0.1',
      '--env=ANTHROPIC_API_KEY',
      '--mount=type=bind,source=/,target=/host',
      '--security-opt=seccomp=unconfined',
    ]) {
      expectUnsafe(() => assertHardenedProxyArgs(withFlag(flag)));
    }
    expectUnsafe(() => assertHardenedProxyArgs(args.filter((a) => a !== '--read-only')));
    expectUnsafe(() => assertHardenedProxyArgs([...args, 'sh']));
    expectUnsafe(() => buildProxyCreateArgs(proxyPlan({ egressNetwork: 'host x' })));
    expectUnsafe(() => buildProxyCreateArgs(proxyPlan({ image: 'node:22' })));
    expectUnsafe(() =>
      assertHardenedProxyArgs(buildProxyCreateArgs(proxyPlan({ egressNetwork: 'host' }))),
    );
  });
});
