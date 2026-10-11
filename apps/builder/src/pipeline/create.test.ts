/// <reference types="node" />
import { readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRow } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../scan/index.js';
import { Worker } from '../worker.js';
import { FakeJobsDb } from '../worker/fake-db.js';
import { createPipelineHandler } from './index.js';
import { jobBranch, StepAbortedError } from './context.js';
import { AgentFailedError, PipelineError, PolicyViolationError, SiteBuildError } from './errors.js';
import {
  CREATE_JOB_ID,
  jobContext,
  jobFixture,
  LAUNCHPAD_COIN_CONFIG,
  LAUNCHPAD_COIN_MINT,
  LAUNCHPAD_CONFIG,
  LAUNCHPAD_ID,
  makeJobsRoot,
  OWNER,
  OWNER_TX,
  silentLogger,
} from './test-fakes.js';
import { agents, designAgent, makeHarness, type Harness } from './test-harness.js';

const REPO = 'lp-moonpad';
const BRANCH = jobBranch(CREATE_JOB_ID);

// Real file system work (job folders) on every step: slow on some CI and Windows hosts.
vi.setConfig({ testTimeout: 120_000 });

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ root, cleanup } = await makeJobsRoot());
});
afterEach(async () => {
  await cleanup();
});

const building = (over: Partial<JobRow> = {}) => jobFixture({ status: 'building', ...over });
const onchainJob = (over: Partial<JobRow> = {}) => jobFixture({ status: 'onchain_setup', ...over });
const deployingJob = (over: Partial<JobRow> = {}) => jobFixture({ status: 'deploying', ...over });

function harness(): Harness {
  const h = makeHarness(root);
  h.runner.agent = designAgent;
  return h;
}

async function runStep(h: Harness, job: JobRow, signal?: AbortSignal) {
  const { ctx, events } = jobContext(signal);
  const outcome = await createPipelineHandler(h.deps).handle(job, ctx);
  return { outcome, events };
}

const sideEffects = new Set([
  'github:ensureRepoFromTemplate',
  'github:protectDefaultBranch',
  'github:commitFiles',
  'github:mergeBranch',
  'vercel:ensureProject',
  'vercel:setEnv',
  'vercel:pruneEnv',
  'vercel:createDeployment',
  'vercel:promoteToProduction',
  'vercel:attachSubdomain',
  'store:updateLaunchpad',
  'signer:createConfigs',
  'signer:prepareLaunchCoin',
  'gateway:issueToken',
  'runner:run:agent',
  'runner:run:install',
  'runner:run:build',
]);

/** Records every fake call, in order, as `fake:op`. */
function trace(h: Harness, onCall?: (index: number, entry: string) => void): string[] {
  const log: string[] = [];
  const fakes = {
    github: h.github,
    vercel: h.vercel,
    runner: h.runner,
    gateway: h.gateway,
    signer: h.signer,
    store: h.store,
  } as const;
  for (const [name, fake] of Object.entries(fakes)) {
    fake.onCall = (op) => {
      const entry = `${name}:${op}`;
      log.push(entry);
      onCall?.(log.length - 1, entry);
    };
  }
  return log;
}

async function jobsRootEntries(): Promise<string[]> {
  return readdir(root);
}

describe('create: building', () => {
  it('builds a preview from the template, the spec and the agent', async () => {
    const h = harness();
    const { outcome, events } = await runStep(h, building());

    const repo = h.github.repos.get(REPO);
    expect(repo).toBeDefined();
    const project = h.vercel.projectBySlug('moonpad')!;
    const deployments = h.vercel.deploymentsOf(project.id);
    expect(deployments).toHaveLength(1);
    const preview = deployments[0]!;
    expect(outcome).toEqual({ patch: { preview_url: preview.url } });
    expect(preview).toMatchObject({ target: 'preview', ref: BRANCH, readyState: 'READY' });
    expect(preview.sha).toBe(repo!.branches.get(BRANCH));

    // forge.config.json: written from the spec, theme/content edited by the agent, no onchain.
    const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
    expect(config).toEqual({
      version: 1,
      name: 'MoonPad',
      slug: 'moonpad',
      mode: 'live',
      theme: { primaryColor: '#112233', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: 'Launch to the moon', about: 'MoonPad launches coins to the moon.' },
    });
    expect(h.github.text(REPO, BRANCH, 'src/components/Hero.tsx')).toContain('<h1>MoonPad</h1>');
    // The default branch is untouched until the release.
    expect(h.github.text(REPO, 'main', 'src/components/Hero.tsx')).toBeUndefined();
    // Build artefacts are never committed.
    expect(
      [...h.github.filesAt(REPO, BRANCH).keys()].some((p) => p.startsWith('node_modules')),
    ).toBe(false);

    // Agent: gateway only, job token with the budget, revoked afterwards.
    expect(h.runner.stepsRun()).toEqual(['agent', 'install', 'build']);
    const agentRun = h.runner.runs[0]!.options;
    expect(agentRun).toMatchObject({ network: 'allowlist', allow: ['gateway'] });
    expect(agentRun.secrets).toEqual({ gatewayToken: h.gateway.issued[0]!.token });
    expect(h.gateway.issued[0]).toMatchObject({ jobId: CREATE_JOB_ID, budgetUsd: 15 });
    expect(h.gateway.revoked).toEqual([h.gateway.issued[0]!.token]);
    // Build: no network, no secret.
    expect(h.runner.runs[2]!.options).toMatchObject({ network: 'none' });
    expect(h.runner.runs[2]!.options.secrets).toBeUndefined();

    // Rows and env.
    expect(h.store.get(LAUNCHPAD_ID)).toMatchObject({
      github_repo: REPO,
      vercel_project_id: project.id,
    });
    expect(project.env.get('FORGE_PLATFORM_FEE_WALLET')).toBeDefined();
    expect(project.env.has('POOL_CONFIG_KEY')).toBe(false);
    expect(events).toEqual([
      'Creating your repo',
      'Coding the design',
      'Checking the changes',
      'Building your site',
      'Publishing your preview',
    ]);
    expect(await jobsRootEntries()).toEqual([]);
  });

  it("gives the scan the agent's diff against the builder's baseline and obeys its verdict", async () => {
    const h = harness();
    const seen: ChangedFile[][] = [];
    h.deps.scan = (files) => {
      seen.push(files);
      return {
        ok: false,
        violations: [
          { rule: 'dynamic-code', file: 'src/components/Hero.tsx', line: 2, reason: 'x' },
        ],
      };
    };
    await expect(runStep(h, building())).rejects.toBeInstanceOf(PolicyViolationError);
    expect(seen).toHaveLength(1);
    const byPath = new Map(seen[0]!.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      'forge.config.json',
      'src/components/Hero.tsx',
      'src/pages/index.tsx',
      'src/theme/theme.css',
    ]);
    expect(byPath.get('src/components/Hero.tsx')).toMatchObject({
      status: 'added',
      oldContent: null,
    });
    const config = byPath.get('forge.config.json')!;
    expect(config.status).toBe('modified');
    // The baseline is the builder's config from the spec, not the template's sample.
    const before = JSON.parse(Buffer.from(config.oldContent as Uint8Array).toString('utf8'));
    expect(before).toMatchObject({ name: 'MoonPad', slug: 'moonpad', mode: 'live' });
    expect(before.onchain).toBeUndefined();
    expect(h.runner.stepsRun()).toEqual(['agent']);
    expect(h.github.count('commitFiles')).toBe(0);
  });

  it('creates the Vercel project (git deployments off) before anything is pushed', async () => {
    const h = harness();
    const log = trace(h);
    await runStep(h, building());
    const project = log.indexOf('vercel:ensureProject');
    const commit = log.indexOf('github:commitFiles');
    const scan = log.indexOf('runner:run:install');
    expect(project).toBeGreaterThan(-1);
    expect(project).toBeLessThan(commit);
    // Scan before install/build: install comes after the agent, commit after the build.
    expect(log.indexOf('runner:run:agent')).toBeLessThan(scan);
    expect(log.indexOf('runner:run:build')).toBeLessThan(commit);
    expect(log.indexOf('github:commitFiles')).toBeLessThan(log.indexOf('vercel:createDeployment'));
  });

  const blocked: Array<[string, keyof typeof agents, string]> = [
    ['an edit of src/forge', 'touchForgeZone', 'forge-locked-zone'],
    ['an external script', 'externalScript', 'external-script'],
    ['an added Solana address', 'addAddress', 'solana-address'],
    ['a change of the @forge/core version', 'bumpCore', 'forge-core-dependency'],
    ['a change of forge.config.json#mode', 'changeMode', 'forge-config-locked-field'],
    ['a forge.config.json that breaks the schema', 'breakTheme', 'forge-config-invalid'],
  ];
  for (const [what, behaviour, rule] of blocked) {
    it(`blocks ${what}: no install, no build, no push, no deployment`, async () => {
      const h = harness();
      h.runner.agent = agents[behaviour];
      const { ctx, events } = jobContext();
      const error = await createPipelineHandler(h.deps)
        .handle(building(), ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PolicyViolationError);
      expect((error as PolicyViolationError).violations.map((v) => v.rule)).toContain(rule);
      expect((error as Error).message).toContain(rule);
      expect(h.runner.stepsRun()).toEqual(['agent']);
      expect(h.github.count('commitFiles')).toBe(0);
      expect(h.vercel.count('createDeployment')).toBe(0);
      expect(h.github.repos.get(REPO)!.branches.has(BRANCH)).toBe(false);
      expect(h.alerts).toEqual([
        expect.objectContaining({ level: 'normal', code: `scan_blocked:${CREATE_JOB_ID}` }),
      ]);
      expect(events).toContain('The changes did not pass our safety checks');
      expect(h.gateway.revoked).toHaveLength(1);
      expect(await jobsRootEntries()).toEqual([]);
    });
  }

  it('blocks a symlink left in the job folder without following it', async (testCtx) => {
    const h = harness();
    let created = true;
    h.runner.agent = async (workdir) => {
      try {
        await symlink(path.join(root, '..'), path.join(workdir, 'src', 'content', 'link'), 'dir');
      } catch {
        created = false;
      }
    };
    const error = await runStep(h, building()).catch((e: unknown) => e);
    if (!created) {
      testCtx.skip();
      return;
    }
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect((error as PolicyViolationError).violations.map((v) => v.rule)).toContain('file-mode');
    expect(h.github.count('commitFiles')).toBe(0);
  });

  it('commits the scanned bytes, not what the build left in the folder', async () => {
    const h = harness();
    h.runner.duringBuild = async (workdir) => {
      await writeFile(
        path.join(workdir, 'src', 'components', 'Hero.tsx'),
        'export function Hero() { return <script src="https://evil.example/x.js" />; }\n',
      );
      await writeFile(path.join(workdir, 'src', 'forge', 'BuyButton.tsx'), 'export const x = 1;\n');
    };
    await runStep(h, building());
    expect(h.github.text(REPO, BRANCH, 'src/components/Hero.tsx')).toContain('<h1>MoonPad</h1>');
    expect(h.github.text(REPO, BRANCH, 'src/forge/BuyButton.tsx')).toContain('return null');
  });

  it('fails the build when the local build fails: nothing is pushed or deployed', async () => {
    const h = harness();
    h.runner.buildExitCode = 1;
    const error = await runStep(h, building()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiteBuildError);
    expect((error as SiteBuildError).step).toBe('build');
    expect((error as Error).message).toContain('Cannot find module');
    expect(h.github.count('commitFiles')).toBe(0);
    expect(h.vercel.count('createDeployment')).toBe(0);
    expect(await jobsRootEntries()).toEqual([]);
  });

  it('fails the build when the install fails', async () => {
    const h = harness();
    h.runner.installExitCode = 1;
    const error = await runStep(h, building()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiteBuildError);
    expect((error as SiteBuildError).step).toBe('install');
    expect(h.runner.stepsRun()).toEqual(['agent', 'install']);
    expect(h.github.count('commitFiles')).toBe(0);
  });

  it('fails when the agent fails, and still revokes its token', async () => {
    const h = harness();
    h.runner.agentExitCode = 1;
    h.runner.agentStdout = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
    });
    const error = await runStep(h, building()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentFailedError);
    expect(h.runner.stepsRun()).toEqual(['agent']);
    expect(h.gateway.revoked).toEqual([h.gateway.issued[0]!.token]);
    expect(h.github.count('commitFiles')).toBe(0);
  });

  it('fails when the agent times out', async () => {
    const h = harness();
    h.runner.agentTimedOut = true;
    await expect(runStep(h, building())).rejects.toThrow(/time limit/);
    expect(h.runner.stepsRun()).toEqual(['agent']);
  });

  it('fails when the preview deployment fails', async () => {
    const h = harness();
    h.vercel.nextState = 'ERROR';
    await expect(runStep(h, building())).rejects.toThrow(/ERROR/);
  });

  it('starts again when the default branch moved during the build', async () => {
    const h = harness();
    h.runner.agent = async (workdir, options) => {
      await designAgent(workdir, options);
      await h.github.commitFiles({
        repo: REPO,
        branch: 'main',
        message: 'concurrent change',
        files: [{ path: 'README.md', content: 'moved\n' }],
      });
    };
    await expect(runStep(h, building())).rejects.toBeInstanceOf(PipelineError);
    expect(h.github.repos.get(REPO)!.branches.has(BRANCH)).toBe(false);
  });

  it('scans the values written from the spec too, even when the agent leaves them', async () => {
    const h = harness();
    const spec = h.store.get(LAUNCHPAD_ID).spec as { theme: { tagline: string } };
    spec.theme.tagline = '<script>alert(1)</script>';
    h.runner.agent = async () => undefined;
    const error = await runStep(h, building()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect((error as PolicyViolationError).violations).toContainEqual(
      expect.objectContaining({ rule: 'forge-config-unsafe-value', file: 'forge.config.json' }),
    );
    expect(h.runner.stepsRun()).toEqual(['agent']);
  });

  it('protects the default branch on every attempt, not only when the repo was created', async () => {
    const h = harness();
    // First attempt: the repo is created, then the protection call fails.
    h.github.fail('protectDefaultBranch');
    await expect(runStep(h, building({ attempts: 1 }))).rejects.toThrow();
    expect(h.github.repos.has(REPO)).toBe(true);
    expect(h.github.protectedRepos.size).toBe(0);
    // Second attempt: the repo already exists and the protection is applied anyway.
    h.github.protection = { applied: true };
    await runStep(h, building({ attempts: 2 }));
    expect(h.github.count('ensureRepoFromTemplate')).toBe(2);
    expect(h.github.count('protectDefaultBranch')).toBe(2);
    expect(h.github.protectedRepos.has(REPO)).toBe(true);
  });

  it('refuses a disabled launchpad before doing anything', async () => {
    const h = harness();
    h.store.setStatus(LAUNCHPAD_ID, 'disabled');
    await expect(runStep(h, building())).rejects.toThrow(/disabled/);
    expect(h.github.calls).toEqual([]);
    expect(h.vercel.calls).toEqual([]);
  });

  it('refuses a spec whose owner differs from the launchpad owner', async () => {
    const h = harness();
    h.store.get(LAUNCHPAD_ID).owner_wallet = LAUNCHPAD_CONFIG;
    await expect(runStep(h, building())).rejects.toThrow(/owner/);
    expect(h.github.calls).toEqual([]);
  });

  it('honours the abort signal before every side effect', async () => {
    const reference = harness();
    const fullLog = trace(reference);
    await runStep(reference, building());
    for (let k = 0; k < fullLog.length; k++) {
      const h = harness();
      const controller = new AbortController();
      const log = trace(h, (index) => {
        if (index === k) controller.abort('timeout');
      });
      // Aborted on the last call, the step may still return: what matters is what follows.
      await runStep(h, building(), controller.signal).catch(() => undefined);
      const after = log.slice(k + 1).filter((entry) => sideEffects.has(entry));
      expect({ k, at: log[k], after }).toEqual({ k, at: log[k], after: [] });
      expect(await jobsRootEntries()).toEqual([]);
    }
  });

  it('throws a StepAbortedError when aborted between steps', async () => {
    const h = harness();
    const controller = new AbortController();
    trace(h, (_, entry) => {
      if (entry === 'github:snapshot') controller.abort('shutdown');
    });
    const error = await runStep(h, building(), controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepAbortedError);
    expect(h.runner.runs).toHaveLength(0);
  });

  describe('re-run after a crash at each step', () => {
    const ops: Array<[keyof Harness, string]> = [
      ['github', 'ensureRepoFromTemplate'],
      ['github', 'protectDefaultBranch'],
      ['store', 'updateLaunchpad'],
      ['vercel', 'ensureProject'],
      ['github', 'snapshot'],
      ['gateway', 'issueToken'],
      ['runner', 'run:agent'],
      ['runner', 'run:install'],
      ['runner', 'run:build'],
      ['github', 'getBranchHead'],
      ['github', 'commitFiles'],
      ['vercel', 'setEnv'],
      ['vercel', 'pruneEnv'],
      ['vercel', 'createDeployment'],
      ['vercel', 'waitForDeployment'],
    ];
    for (const [fake, op] of ops) {
      for (const when of ['before', 'after'] as const) {
        it(`${fake}.${op} (${when})`, async () => {
          const h = harness();
          (h[fake] as unknown as { fail(op: string, when: 'before' | 'after'): void }).fail(
            op,
            when,
          );
          await expect(runStep(h, building({ attempts: 1 }))).rejects.toThrow();
          expect(await jobsRootEntries()).toEqual([]);

          const { outcome } = await runStep(h, building({ attempts: 2 }));
          expect(h.github.repos.size).toBe(1);
          expect(h.vercel.projects.size).toBe(1);
          const repo = h.github.repos.get(REPO)!;
          const head = repo.branches.get(BRANCH)!;
          const project = h.vercel.projectBySlug('moonpad')!;
          const previews = h.vercel.deploymentsOf(project.id).filter((d) => d.sha === head);
          expect(previews).toHaveLength(1);
          expect(outcome).toEqual({ patch: { preview_url: previews[0]!.url } });
          // The branch holds exactly the scanned result of the successful attempt.
          const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
          expect(config.theme.primaryColor).toBe('#112233');
          expect(h.github.text(REPO, BRANCH, 'src/theme/theme.css')).toContain('#112233');
          expect(h.store.get(LAUNCHPAD_ID)).toMatchObject({
            github_repo: REPO,
            vercel_project_id: project.id,
          });
          // Every token handed to an agent run was revoked.
          for (const run of h.runner.runs.filter((r) => r.step === 'agent')) {
            expect(h.gateway.revoked).toContain(run.options.secrets?.gatewayToken);
          }
          expect(await jobsRootEntries()).toEqual([]);
        });
      }
    }
  });
});

async function buildPreview(h: Harness): Promise<void> {
  await runStep(h, building());
}

describe('create: onchain_setup', () => {
  it('creates the configs, prepares the launch and records the addresses', async () => {
    const h = harness();
    await buildPreview(h);
    const previewHead = h.github.repos.get(REPO)!.branches.get(BRANCH);
    const { outcome, events } = await runStep(h, onchainJob());
    expect(outcome).toEqual({ patch: { owner_tx: OWNER_TX } });
    expect(h.signer.count('createConfigs')).toBe(1);
    expect(h.signer.count('prepareLaunchCoin')).toBe(1);
    const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
    expect(config.onchain).toEqual({
      cluster: 'devnet',
      launchpadConfig: LAUNCHPAD_CONFIG,
      launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
      launchpadCoinMint: LAUNCHPAD_COIN_MINT,
      ownerWallet: OWNER,
      poolCreationFeeSol: 0.01,
    });
    // Only forge.config.json changed, in a builder-owned commit on the job branch.
    const head = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
    expect(h.github.commits.get(head)!.parents).toEqual([previewHead]);
    expect(h.github.commits.get(head)!.message).toMatch(/on-chain addresses/);
    expect(h.github.text(REPO, 'main', 'forge.config.json')).not.toContain(LAUNCHPAD_CONFIG);
    expect(h.store.get(LAUNCHPAD_ID)).toMatchObject({
      launchpad_config: LAUNCHPAD_CONFIG,
      launchpad_coin_config: LAUNCHPAD_COIN_CONFIG,
      launchpad_coin_mint: LAUNCHPAD_COIN_MINT,
      status: 'draft',
    });
    expect(events).toEqual([
      'Creating your launchpad configuration on-chain',
      'Preparing your launch transaction',
    ]);
    // No agent, no build, no deployment in this step.
    expect(h.runner.runs).toHaveLength(3);
    expect(h.vercel.deployments.size).toBe(1);
  });

  it('refuses addresses that differ from the recorded ones', async () => {
    const h = harness();
    await buildPreview(h);
    h.store.get(LAUNCHPAD_ID).launchpad_config = LAUNCHPAD_COIN_MINT;
    const commitsBefore = h.github.count('commitFiles');
    await expect(runStep(h, onchainJob())).rejects.toThrow(/differs/);
    expect(h.github.count('commitFiles')).toBe(commitsBefore);
  });

  it('fails before any signer call when the preview branch is missing', async () => {
    const h = harness();
    await expect(runStep(h, onchainJob())).rejects.toThrow();
    expect(h.signer.calls).toEqual([]);
  });

  it('is not a step of modification jobs', async () => {
    const h = harness();
    await expect(runStep(h, onchainJob({ type: 'modify_launchpad' }))).rejects.toThrow(
      /no on-chain step/,
    );
    expect(h.signer.calls).toEqual([]);
  });

  it('honours the abort signal before every side effect', async () => {
    const reference = harness();
    await buildPreview(reference);
    const fullLog = trace(reference);
    await runStep(reference, onchainJob());
    for (let k = 0; k < fullLog.length; k++) {
      const h = harness();
      await buildPreview(h);
      const controller = new AbortController();
      const log = trace(h, (index) => {
        if (index === k) controller.abort('timeout');
      });
      // Aborted on the last call, the step may still return: what matters is what follows.
      await runStep(h, onchainJob(), controller.signal).catch(() => undefined);
      const after = log.slice(k + 1).filter((entry) => sideEffects.has(entry));
      expect({ k, at: log[k], after }).toEqual({ k, at: log[k], after: [] });
    }
  });

  describe('re-run after a crash at each step (the team puts the job back to approved)', () => {
    const ops: Array<[keyof Harness, string]> = [
      ['signer', 'createConfigs'],
      ['signer', 'prepareLaunchCoin'],
      ['github', 'commitFiles'],
      ['store', 'updateLaunchpad'],
    ];
    for (const [fake, op] of ops) {
      for (const when of ['before', 'after'] as const) {
        it(`${fake}.${op} (${when})`, async () => {
          const h = harness();
          await buildPreview(h);
          const commitsBefore = h.github.commits.size;
          (h[fake] as unknown as { fail(op: string, when: 'before' | 'after'): void }).fail(
            op,
            when,
          );
          await expect(runStep(h, onchainJob())).rejects.toThrow();
          const { outcome } = await runStep(h, onchainJob());
          expect(outcome).toEqual({ patch: { owner_tx: OWNER_TX } });
          // Exactly one builder commit with the addresses, whatever the crash point.
          expect(h.github.commits.size).toBe(commitsBefore + 1);
          const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
          expect(config.onchain.launchpadCoinMint).toBe(LAUNCHPAD_COIN_MINT);
          expect(h.store.get(LAUNCHPAD_ID).launchpad_coin_mint).toBe(LAUNCHPAD_COIN_MINT);
        });
      }
    }
  });
});

async function prepareOnchain(h: Harness): Promise<void> {
  await buildPreview(h);
  await runStep(h, onchainJob());
}

describe('create: deploying', () => {
  it('merges, deploys to production, promotes, attaches the subdomain and goes live', async () => {
    const h = harness();
    await prepareOnchain(h);
    const { outcome, events } = await runStep(h, deployingJob());
    const repo = h.github.repos.get(REPO)!;
    const main = repo.branches.get('main')!;
    const config = JSON.parse(h.github.text(REPO, 'main', 'forge.config.json')!);
    expect(config.onchain.launchpadConfig).toBe(LAUNCHPAD_CONFIG);
    expect(config.mode).toBe('live');
    expect(h.github.text(REPO, 'main', 'src/components/Hero.tsx')).toContain('MoonPad');
    const project = h.vercel.projectBySlug('moonpad')!;
    const production = h.vercel.deploymentsOf(project.id).filter((d) => d.target === 'production');
    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({ sha: main, ref: 'main', readyState: 'READY' });
    expect(project.productionDeploymentId).toBe(production[0]!.id);
    expect(production[0]!.env.POOL_CONFIG_KEY).toBe(`${LAUNCHPAD_CONFIG},${LAUNCHPAD_COIN_CONFIG}`);
    expect(project.domains.has('moonpad.clients.test')).toBe(true);
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
    expect(outcome).toEqual({ message: 'Your launchpad is live at https://moonpad.clients.test' });
    expect(events).toEqual(['Publishing your launchpad', 'Connecting your domain']);
  });

  it('scans the release again: a file pushed to the job branch after the preview is refused', async () => {
    const h = harness();
    await prepareOnchain(h);
    await h.github.commitFiles({
      repo: REPO,
      branch: BRANCH,
      message: 'late change',
      files: [
        {
          path: 'src/components/Tracker.tsx',
          content:
            'export function Tracker() {\n  return <script src="https://evil.example/x.js" />;\n}\n',
        },
      ],
    });
    const mainBefore = h.github.repos.get(REPO)!.branches.get('main');
    const error = await runStep(h, deployingJob()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect((error as PolicyViolationError).violations.map((v) => v.file)).toContain(
      'src/components/Tracker.tsx',
    );
    expect(h.github.count('mergeBranch')).toBe(0);
    expect(h.github.repos.get(REPO)!.branches.get('main')).toBe(mainBefore);
    expect(h.vercel.deploymentsOf(h.vercel.projectBySlug('moonpad')!.id)).toHaveLength(1);
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ level: 'high', code: `release_blocked:${CREATE_JOB_ID}` }),
    );
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('draft');
  });

  it('does not promote when the launchpad is disabled while the production build runs', async () => {
    const h = harness();
    await prepareOnchain(h);
    h.vercel.onCall = (op) => {
      if (op === 'waitForDeployment') h.store.setStatus(LAUNCHPAD_ID, 'disabled');
    };
    await expect(runStep(h, deployingJob())).rejects.toThrow(/disabled/);
    expect(h.vercel.count('promoteToProduction')).toBe(0);
    expect(h.vercel.projectBySlug('moonpad')!.productionDeploymentId).toBeUndefined();
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('disabled');
  });

  it('never overwrites a disabled status set right before the final write', async () => {
    const h = harness();
    await prepareOnchain(h);
    h.store.beforeWrite = (_id, patch) => {
      if (patch.status === 'live') h.store.setStatus(LAUNCHPAD_ID, 'disabled');
    };
    await expect(runStep(h, deployingJob())).rejects.toThrow(/status changed/);
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('disabled');
  });

  it('refuses to release on-chain addresses of another cluster', async () => {
    const h = harness();
    await prepareOnchain(h);
    h.deps.config = { ...h.deps.config, cluster: 'mainnet-beta' };
    await expect(runStep(h, deployingJob())).rejects.toBeInstanceOf(PolicyViolationError);
    expect(h.github.count('mergeBranch')).toBe(0);
  });

  it('refuses to release a branch without the on-chain section', async () => {
    const h = harness();
    await buildPreview(h);
    await expect(runStep(h, deployingJob())).rejects.toThrow(/on-chain/);
    expect(h.github.count('mergeBranch')).toBe(0);
    expect(h.vercel.deploymentsOf(h.vercel.projectBySlug('moonpad')!.id)).toHaveLength(1);
  });

  it('honours the abort signal before every side effect', async () => {
    const reference = harness();
    await prepareOnchain(reference);
    const fullLog = trace(reference);
    await runStep(reference, deployingJob());
    for (let k = 0; k < fullLog.length; k++) {
      const h = harness();
      await prepareOnchain(h);
      const controller = new AbortController();
      const log = trace(h, (index) => {
        if (index === k) controller.abort('timeout');
      });
      // Aborted on the last call, the step may still return: what matters is what follows.
      await runStep(h, deployingJob(), controller.signal).catch(() => undefined);
      const after = log.slice(k + 1).filter((entry) => sideEffects.has(entry));
      expect({ k, at: log[k], after }).toEqual({ k, at: log[k], after: [] });
    }
  });

  describe('re-run after a crash at each step', () => {
    const ops: Array<[keyof Harness, string]> = [
      ['vercel', 'ensureProject'],
      ['github', 'mergeBranch'],
      ['vercel', 'setEnv'],
      ['vercel', 'createDeployment'],
      ['vercel', 'waitForDeployment'],
      ['vercel', 'promoteToProduction'],
      ['vercel', 'attachSubdomain'],
      ['store', 'updateLaunchpad'],
    ];
    for (const [fake, op] of ops) {
      for (const when of ['before', 'after'] as const) {
        it(`${fake}.${op} (${when})`, async () => {
          const h = harness();
          await prepareOnchain(h);
          (h[fake] as unknown as { fail(op: string, when: 'before' | 'after'): void }).fail(
            op,
            when,
          );
          await expect(runStep(h, deployingJob())).rejects.toThrow();
          await runStep(h, deployingJob());
          const repo = h.github.repos.get(REPO)!;
          const main = repo.branches.get('main')!;
          const merges = [...h.github.commits.values()].filter((c) => c.parents.length === 2);
          expect(merges).toHaveLength(1);
          const project = h.vercel.projectBySlug('moonpad')!;
          const production = h.vercel
            .deploymentsOf(project.id)
            .filter((d) => d.target === 'production');
          expect(production).toHaveLength(1);
          expect(production[0]!.sha).toBe(main);
          expect(project.productionDeploymentId).toBe(production[0]!.id);
          expect(project.domains.size).toBe(1);
          expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
        });
      }
    }
  });
});

describe('create: through the worker', () => {
  function workerFor(h: Harness, db: FakeJobsDb) {
    const alerts: Array<{ level: string; code: string }> = [];
    const worker = new Worker({
      db,
      handler: createPipelineHandler(h.deps),
      logger: silentLogger(),
      alerter: {
        alert: async (level, code) => {
          alerts.push({ level, code });
        },
      },
      workerId: 'w1',
      sleep: async () => undefined,
      now: () => db.clock,
    });
    return { worker, alerts };
  }

  it('runs paid -> preview_ready -> awaiting_owner_signature -> live', async () => {
    const h = harness();
    const db = new FakeJobsDb();
    db.addJob({ id: CREATE_JOB_ID, launchpad_id: LAUNCHPAD_ID, status: 'paid' });
    const { worker } = workerFor(h, db);

    expect(await worker.tick()).toBe(1);
    await worker.idle();
    const preview = db.get(CREATE_JOB_ID);
    expect(preview).toMatchObject({ status: 'preview_ready', locked_by: null });
    expect(preview.preview_url).toMatch(/^https:\/\/lp-moonpad-\d+\.vercel\.test$/);

    db.get(CREATE_JOB_ID).status = 'approved';
    await worker.tick();
    await worker.idle();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({
      status: 'awaiting_owner_signature',
      owner_tx: OWNER_TX,
    });

    db.get(CREATE_JOB_ID).status = 'owner_signed';
    await worker.tick();
    await worker.idle();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({ status: 'live', locked_by: null });
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
    const events = db.eventsFor(CREATE_JOB_ID);
    expect(events).toContain('Creating your repo');
    expect(events).toContain('Preview ready');
    expect(events).toContain('Your transaction is ready to sign');
    expect(events.at(-1)).toBe('Your launchpad is live at https://moonpad.clients.test');
  });

  it('never retries a failed on-chain step automatically (D18)', async () => {
    const h = harness();
    await buildPreview(h);
    const db = new FakeJobsDb();
    db.addJob({ id: CREATE_JOB_ID, launchpad_id: LAUNCHPAD_ID, status: 'approved', attempts: 1 });
    h.signer.fail('prepareLaunchCoin');
    const { worker, alerts } = workerFor(h, db);

    await worker.tick();
    await worker.idle();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({
      status: 'failed',
      failed_stage: 'onchain',
      locked_by: null,
      owner_tx: null,
    });
    expect(alerts).toContainEqual({ level: 'high', code: `job_failed_onchain:${CREATE_JOB_ID}` });

    // Later polls never pick it up again: no second signer call.
    for (let i = 0; i < 3; i++) {
      db.clock += 120_000;
      await worker.tick();
      await worker.idle();
    }
    expect(h.signer.count('createConfigs')).toBe(1);
    expect(h.signer.count('prepareLaunchCoin')).toBe(1);
    expect(db.get(CREATE_JOB_ID).status).toBe('failed');
  });

  it('retries a scan rejection once, from a clean checkout, then gives up', async () => {
    const h = harness();
    h.runner.agent = agents.externalScript;
    const db = new FakeJobsDb();
    db.addJob({ id: CREATE_JOB_ID, launchpad_id: LAUNCHPAD_ID, status: 'paid' });
    const { worker } = workerFor(h, db);
    for (let i = 0; i < 4; i++) {
      await worker.tick();
      await worker.idle();
    }
    expect(db.get(CREATE_JOB_ID)).toMatchObject({
      status: 'failed',
      failed_stage: 'build',
      attempts: 2,
    });
    expect(db.get(CREATE_JOB_ID).error).toMatch(/external-script/);
    expect(h.runner.stepsRun()).toEqual(['agent', 'agent']);
    expect(h.github.count('commitFiles')).toBe(0);
  });
});
