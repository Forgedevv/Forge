import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMaxJobMs } from '../worker.js';
import {
  assertStepTimeoutsFitJob,
  buildCommands,
  buildSite,
  detectPackageManager,
  stepMemoryMbFromEnv,
  stepMinutesFromEnv,
} from './build.js';
import { resolveSandboxConfig } from './config.js';
import type { SandboxRunner } from './run.js';
import type { SandboxRunOptions, SandboxRunResult } from './types.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'forge-build-unit-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

function result(overrides: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return {
    runId: 'r',
    ok: true,
    exitCode: 0,
    timedOut: false,
    oomKilled: false,
    killedReason: null,
    durationMs: 1,
    stdout: 'out',
    stderr: '',
    truncated: { stdout: false, stderr: false },
    outputBytes: { stdout: 3, stderr: 0 },
    egress: null,
    ...overrides,
  };
}

function mockRunner(
  behave: (o: SandboxRunOptions, index: number) => Promise<SandboxRunResult> | SandboxRunResult,
) {
  const runs: SandboxRunOptions[] = [];
  const runner: SandboxRunner = {
    config: resolveSandboxConfig({
      image: `sha256:${'a'.repeat(64)}`,
      proxyImage: `sha256:${'b'.repeat(64)}`,
      jobsRoot: root,
    }),
    async run(o) {
      runs.push(o);
      return behave(o, runs.length - 1);
    },
    async cleanupStale() {
      return { containers: 0, networks: 0 };
    },
  };
  return { runner, runs };
}

describe('detectPackageManager', () => {
  it('needs a real lockfile', async () => {
    expect(await detectPackageManager(await project('pm-pnpm', { 'pnpm-lock.yaml': 'x' }))).toBe(
      'pnpm',
    );
    expect(await detectPackageManager(await project('pm-npm', { 'package-lock.json': '{}' }))).toBe(
      'npm',
    );
    expect(await detectPackageManager(await project('pm-none', { 'yarn.lock': '' }))).toBeNull();
  });
});

describe('buildCommands', () => {
  it('never runs repository code during the install', () => {
    const pnpm = buildCommands('pnpm');
    expect(pnpm.install).toEqual(
      expect.arrayContaining(['--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile']),
    );
    expect(pnpm.install).toContain('--config.manage-package-manager-versions=false');
    expect(buildCommands('npm').install).toEqual(
      expect.arrayContaining(['ci', '--ignore-scripts']),
    );
  });
});

describe('buildSite', () => {
  it('installs with npm registry egress only and no secret, then builds with no network', async () => {
    const dir = await project('site-ok', {
      'package.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0',
    });
    const { runner, runs } = mockRunner(async (_o, i) => {
      if (i === 1) await mkdir(path.join(dir, '.next'), { recursive: true });
      return result({ stdout: i === 0 ? 'installed' : 'built' });
    });
    const res = await buildSite(runner, dir, { jobId: 'job-1' });
    expect(res.ok).toBe(true);
    expect(res.failedStep).toBeNull();
    expect(res.packageManager).toBe('pnpm');
    expect(res.artifactsPath).toBeTruthy();
    expect(res.logs).toContain('== install: exit 0 ==');
    expect(res.logs).toContain('built');

    const [install, build] = runs;
    expect(install).toMatchObject({
      jobId: 'job-1',
      workdir: dir,
      network: 'allowlist',
      allow: ['npm'],
    });
    expect(install!.secrets).toBeUndefined();
    expect(install!.command).toEqual(buildCommands('pnpm').install);
    expect(build).toMatchObject({ network: 'none', command: ['pnpm', 'run', 'build'] });
    expect(build!.secrets).toBeUndefined();
    expect(build!.allow).toBeUndefined();
    expect(build!.env?.NODE_OPTIONS).toMatch(/^--max-old-space-size=\d+$/);
  });

  it('installs an npm project from the npm registry only, with no secret', async () => {
    const dir = await project('site-npm', {
      'package.json': '{}',
      'package-lock.json': '{}',
      'out/x': '',
    });
    const { runner, runs } = mockRunner(() => result());
    const res = await buildSite(runner, dir, { jobId: 'job-2', outputDir: 'out' });
    expect(res.ok).toBe(true);
    expect(runs[0]).toMatchObject({ allow: ['npm'] });
    expect(runs[0]!.secrets).toBeUndefined();
    expect(runs[0]!.command).toEqual(buildCommands('npm').install);
  });

  it('refuses to build without a lockfile or package.json', async () => {
    const noLock = await project('site-nolock', { 'package.json': '{}' });
    const { runner, runs } = mockRunner(() => result());
    const a = await buildSite(runner, noLock, { jobId: 'job-3' });
    expect(a).toMatchObject({ ok: false, failedStep: 'prepare' });
    expect(a.logs).toMatch(/lockfile/);
    const noPkg = await project('site-nopkg', { 'pnpm-lock.yaml': '' });
    expect(await buildSite(runner, noPkg, { jobId: 'job-3' })).toMatchObject({
      ok: false,
      failedStep: 'prepare',
    });
    expect(runs).toHaveLength(0);
  });

  it('stops after a failed install', async () => {
    const dir = await project('site-install-fail', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const { runner, runs } = mockRunner(() =>
      result({ ok: false, exitCode: 1, stderr: 'ERR_PNPM' }),
    );
    const res = await buildSite(runner, dir, { jobId: 'job-4' });
    expect(res).toMatchObject({ ok: false, failedStep: 'install', exitCode: 1 });
    expect(res.logs).toContain('ERR_PNPM');
    expect(runs).toHaveLength(1);
  });

  it('reports a failed or killed build', async () => {
    const dir = await project('site-build-fail', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const { runner } = mockRunner((_o, i) =>
      i === 0
        ? result()
        : result({ ok: false, exitCode: 137, killedReason: 'timeout', timedOut: true }),
    );
    const res = await buildSite(runner, dir, { jobId: 'job-5' });
    expect(res).toMatchObject({ ok: false, failedStep: 'build', exitCode: 137 });
    expect(res.logs).toContain('== build: killed (timeout) ==');
  });

  it('rejects a missing or symlinked build output', async () => {
    const dir = await project('site-no-output', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const { runner } = mockRunner(() => result());
    expect(await buildSite(runner, dir, { jobId: 'job-6' })).toMatchObject({
      ok: false,
      failedStep: 'artifacts',
      artifactsPath: null,
    });
    const outsideDir = await project('elsewhere', { 'secret.txt': 'host file' });
    const linked = await project('site-linked-output', {
      'package.json': '{}',
      'pnpm-lock.yaml': '',
    });
    try {
      await symlink(
        outsideDir,
        path.join(linked, '.next'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    expect(await buildSite(runner, linked, { jobId: 'job-6' })).toMatchObject({
      ok: false,
      failedStep: 'artifacts',
    });
  });

  it('builds a sub-project and refuses escaping paths', async () => {
    const dir = await project('site-sub', {
      'repo/package.json': '{}',
      'repo/pnpm-lock.yaml': '',
      'repo/.next/BUILD_ID': 'x',
    });
    const { runner, runs } = mockRunner(() => result());
    const res = await buildSite(runner, dir, { jobId: 'job-7', projectDir: 'repo' });
    expect(res.ok).toBe(true);
    expect(runs[0]!.workingDir).toBe('repo');
    await expect(buildSite(runner, dir, { jobId: 'job-7', projectDir: '../x' })).rejects.toThrow();
    await expect(buildSite(runner, dir, { jobId: 'job-7', outputDir: '/etc' })).rejects.toThrow();
  });
});

describe('step timeouts against the cap on one job', () => {
  const MIN = 60_000;

  it('accepts the defaults within the worker default cap', () => {
    // 2 x (10 + 15) + 30 = 80 minutes, within the default 90.
    expect(() =>
      assertStepTimeoutsFitJob({
        maxJobMs: defaultMaxJobMs(),
        agentTimeoutMs: 30 * MIN,
        installTimeoutMs: 10 * MIN,
        buildTimeoutMs: 15 * MIN,
      }),
    ).not.toThrow();
    expect(defaultMaxJobMs()).toBe(90 * MIN);
    // Exactly at the cap still fits.
    expect(() =>
      assertStepTimeoutsFitJob({
        maxJobMs: 90 * MIN,
        agentTimeoutMs: 30 * MIN,
        installTimeoutMs: 10 * MIN,
        buildTimeoutMs: 20 * MIN,
      }),
    ).not.toThrow();
  });

  it('refuses step timeouts that a job cannot hold, with a clear error', () => {
    const error = (() => {
      try {
        assertStepTimeoutsFitJob({
          maxJobMs: 90 * MIN,
          agentTimeoutMs: 30 * MIN,
          installTimeoutMs: 20 * MIN,
          buildTimeoutMs: 15 * MIN,
        });
      } catch (err) {
        return err as Error;
      }
      throw new Error('expected an error');
    })();
    expect(error.message).toBe(
      'the sandbox step timeouts do not fit in one job: 2 x (install 20 + build 15) + agent 30 = 100 minutes, above the 90-minute limit of a job; lower FORGE_SANDBOX_INSTALL_TIMEOUT_MINUTES or FORGE_SANDBOX_BUILD_TIMEOUT_MINUTES',
    );
    expect(() =>
      assertStepTimeoutsFitJob({
        maxJobMs: 90 * MIN,
        agentTimeoutMs: 30 * MIN,
        installTimeoutMs: 60 * MIN,
        buildTimeoutMs: 60 * MIN,
      }),
    ).toThrow(/do not fit in one job/);
  });
});

describe('step timeouts from the environment', () => {
  it('reads whole minutes from 1 to 60 and falls back otherwise', () => {
    expect(stepMinutesFromEnv('X', 10, {})).toBe(10);
    expect(stepMinutesFromEnv('X', 10, { X: ' 25 ' })).toBe(25);
    for (const bad of ['0', '61', '2.5', 'ten', '-3']) {
      expect(() => stepMinutesFromEnv('X', 10, { X: bad }), bad).toThrow(/1 to 60/);
    }
  });
});

describe('step memory from the environment', () => {
  it('reads whole MiB from 2048 to 8192 and falls back otherwise', () => {
    expect(stepMemoryMbFromEnv('M', 4096, {})).toBe(4096);
    expect(stepMemoryMbFromEnv('M', 4096, { M: '3072' })).toBe(3072);
    for (const bad of ['1024', '9000', '3000.5', 'lots']) {
      expect(() => stepMemoryMbFromEnv('M', 4096, { M: bad }), bad).toThrow(/2048 to 8192/);
    }
  });
});
