/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRow } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../scan/index.js';
import { Worker } from '../worker.js';
import { FakeJobsDb } from '../worker/fake-db.js';
import { createPipelineHandler } from './index.js';
import { jobBranch, StepAbortedError } from './context.js';
import { ServiceError } from '../http.js';
import { PRODUCTION_NOT_STAGED } from '../vercel.js';
import { AgentFailedError, PipelineError, PolicyViolationError, SiteBuildError } from './errors.js';
import { StoreError, type LaunchpadPatch } from './store.js';
import {
  address,
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
  OWNER_TX_DETAILS,
  silentLogger,
} from './test-fakes.js';
import {
  agents,
  designAgent,
  makeHarness,
  TEST_RELAY_SECRET,
  withPreviewUrl,
  type Harness,
} from './test-harness.js';

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
/** Outcome of the on-chain step: the launch transaction and its accounts, stored together. */
const STORED_LAUNCH = { patch: { owner_tx: OWNER_TX, owner_tx_details: OWNER_TX_DETAILS } };

function harness(): Harness {
  const h = makeHarness(root);
  h.runner.agent = designAgent;
  return h;
}

async function runStep(h: Harness, job: JobRow, signal?: AbortSignal) {
  const { ctx, events } = jobContext(signal);
  const outcome = await createPipelineHandler(h.deps).handle(withPreviewUrl(h, job), ctx);
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

  it('gives the project its own server-only relay token', async () => {
    const h = harness();
    await runStep(h, building());
    const project = h.vercel.projectBySlug('moonpad')!;
    const expected = `v1.moonpad.${createHmac('sha256', TEST_RELAY_SECRET)
      .update('forge-rpc-relay:v1:moonpad')
      .digest('hex')}`;
    expect(project.env.get('FORGE_RPC_RELAY_TOKEN')).toBe(expected);
    expect(h.vercel.deploymentsOf(project.id)[0]!.env.FORGE_RPC_RELAY_TOKEN).toBe(expected);
    for (const [key, value] of project.env) {
      if (key.startsWith('NEXT_PUBLIC_')) expect(value).not.toBe(expected);
      expect(value).not.toContain(TEST_RELAY_SECRET);
    }
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

  describe('a preview Vercel published in production', () => {
    const previewOf = (h: Harness) => {
      const project = h.vercel.projectBySlug('moonpad')!;
      return {
        project,
        preview: h.vercel.deploymentsOf(project.id).find((d) => d.ref === BRANCH)!,
      };
    };
    const publicAlias = (h: Harness) =>
      h.vercel.aliases.find((a) => a.alias === 'lp-moonpad.vercel.app')?.deploymentId;

    it('said so: canceled, the placeholder serves production again, high alert, step failed', async () => {
      const h = harness();
      h.vercel.firstDeploymentIsProduction = true;
      const error = await runStep(h, building()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as Error).message).toMatch(
        /production deployment \(target\); the placeholder serves production again/,
      );
      const { project, preview } = previewOf(h);
      expect(preview).toMatchObject({ target: 'production', readyState: 'CANCELED' });
      // Never waited for and never handed to the client as a preview.
      expect(h.vercel.count('waitForDeployment')).toBe(0);
      expect(h.vercel.placeholders.has(project.productionDeploymentId!)).toBe(true);
      expect(publicAlias(h)).toBe(project.productionDeploymentId);
      expect(project.paused).toBe(false);
      expect(h.alerts).toContainEqual({
        level: 'high',
        code: 'preview_public:moonpad',
        message: expect.stringContaining('the placeholder serves production again') as unknown,
        details: {
          jobId: CREATE_JOB_ID,
          launchpad: 'moonpad',
          deployment: preview.id,
          seen: 'target',
          canceled: true,
          contained: 'placeholder',
        },
      });
    });

    it('did not say so: caught from the project production pointer once READY', async () => {
      const h = harness();
      // The answer says preview; the project's production points at it all the same.
      h.vercel.firstDeploymentIsProduction = 'pointer';
      await expect(runStep(h, building())).rejects.toThrow(/production deployment \(production\)/);
      const { project, preview } = previewOf(h);
      expect(preview).toMatchObject({ target: 'preview', readyState: 'READY' });
      // Already READY: nothing to cancel, the placeholder takes production back.
      expect(h.vercel.count('cancelDeployment')).toBe(0);
      expect(h.vercel.placeholders.has(project.productionDeploymentId!)).toBe(true);
      expect(publicAlias(h)).toBe(project.productionDeploymentId);
      expect(h.alerts).toContainEqual(
        expect.objectContaining({
          level: 'high',
          code: 'preview_public:moonpad',
          details: expect.objectContaining({
            seen: 'production',
            canceled: false,
            contained: 'placeholder',
          }) as unknown,
        }),
      );
    });

    it('pauses the project (D24) when the placeholder cannot be put back', async () => {
      for (const failure of ['throws', 'does not move production'] as const) {
        const h = harness();
        h.vercel.firstDeploymentIsProduction = 'pointer';
        if (failure === 'throws') h.vercel.fail('restorePlaceholder');
        else h.vercel.placeholderIgnored = true;
        await expect(runStep(h, building()), failure).rejects.toThrow(
          /the Vercel project was paused/,
        );
        const { project, preview } = previewOf(h);
        expect(project.paused, failure).toBe(true);
        expect(project.productionDeploymentId).toBe(preview.id);
        expect(h.alerts).toContainEqual(
          expect.objectContaining({
            level: 'high',
            code: 'preview_public:moonpad',
            message: expect.stringContaining('paused') as unknown,
            details: expect.objectContaining({ contained: 'paused' }) as unknown,
          }),
        );
      }
    });

    it('says the site may be public when neither the placeholder nor the pause works', async () => {
      const h = harness();
      h.vercel.firstDeploymentIsProduction = true;
      h.vercel.fail('cancelDeployment');
      h.vercel.fail('restorePlaceholder');
      h.vercel.fail('pauseProject');
      await expect(runStep(h, building())).rejects.toThrow(/could not be taken back/);
      expect(h.alerts).toContainEqual(
        expect.objectContaining({
          level: 'high',
          code: 'preview_public:moonpad',
          message: expect.stringContaining('may be public') as unknown,
          details: expect.objectContaining({
            canceled: false,
            contained: 'none',
            problems: 'cancel: Error; placeholder: Error; pause: Error',
          }) as unknown,
        }),
      );
    });

    it('gives a private preview on the next attempt, the placeholder in production', async () => {
      const h = harness();
      h.vercel.firstDeploymentIsProduction = true;
      await expect(runStep(h, building({ attempts: 1 }))).rejects.toThrow(/production/);
      const { outcome } = await runStep(h, building({ attempts: 2 }));
      const project = h.vercel.projectBySlug('moonpad')!;
      const previews = h.vercel.deploymentsOf(project.id).filter((d) => d.target === 'preview');
      expect(previews).toHaveLength(1);
      expect(outcome).toEqual({ patch: { preview_url: previews[0]!.url } });
      expect(h.vercel.placeholders.has(project.productionDeploymentId!)).toBe(true);
    });
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
    expect(outcome).toEqual(STORED_LAUNCH);
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

  // Before: only the transaction was stored, so apps/web had to read the creator wallet, the
  // nonce account and the metadata URI it pins back from that same transaction.
  it('stores the launch accounts of the prepare answer with the transaction, extra fields dropped', async () => {
    const h = harness();
    await buildPreview(h);
    const { outcome } = await runStep(h, onchainJob());
    expect(outcome.patch?.owner_tx_details).toEqual(OWNER_TX_DETAILS);
    expect(Object.keys(outcome.patch?.owner_tx_details ?? {}).sort()).toEqual([
      'config',
      'creator',
      'metadataUri',
      'nonceAccount',
      'pool',
    ]);
  });

  it.each<[string, (details: Record<string, unknown>) => Record<string, unknown> | undefined]>([
    ['missing', () => undefined],
    [
      'without the creator wallet',
      (d) => Object.fromEntries(Object.entries(d).filter(([key]) => key !== 'creator')),
    ],
    ['with an invalid nonce account', (d) => ({ ...d, nonceAccount: 'not-an-address' })],
    ['with a non-https metadata URI', (d) => ({ ...d, metadataUri: 'http://forge.test/x.json' })],
    ['for another coin config', (d) => ({ ...d, config: LAUNCHPAD_CONFIG })],
  ])('refuses to store the launch transaction when the details are %s', async (_label, change) => {
    const h = harness();
    await buildPreview(h);
    const commits = h.github.count('commitFiles');
    const details = change({ ...h.signer.prepared.details });
    h.signer.prepared = { partiallySignedTx: OWNER_TX, mint: LAUNCHPAD_COIN_MINT };
    if (details !== undefined) h.signer.prepared.details = details;
    await expect(runStep(h, onchainJob())).rejects.toThrow(/launch transaction is not stored/);
    // Nothing written: no address commit, no launchpad row update.
    expect(h.github.count('commitFiles')).toBe(commits);
    expect(h.store.get(LAUNCHPAD_ID).launchpad_coin_mint).toBeNull();
  });

  it('refuses addresses that differ from the recorded ones', async () => {
    const h = harness();
    await buildPreview(h);
    h.store.get(LAUNCHPAD_ID).launchpad_config = LAUNCHPAD_COIN_MINT;
    const commitsBefore = h.github.count('commitFiles');
    await expect(runStep(h, onchainJob())).rejects.toThrow(/differs/);
    expect(h.github.count('commitFiles')).toBe(commitsBefore);
  });

  it('refuses to re-enter once the launch was prepared and recorded', async () => {
    const h = harness();
    await prepareOnchain(h);
    const signerCalls = h.signer.calls.length;
    const commits = h.github.commits.size;
    // The team put a creation whose release failed back to `approved` instead of `owner_signed`.
    await expect(runStep(h, onchainJob({ owner_tx: OWNER_TX }))).rejects.toThrow(/owner_signed/);
    expect(h.signer.calls.length).toBe(signerCalls);
    expect(h.github.commits.size).toBe(commits);
    // A crash before owner_tx was stored is still resumed (addresses recorded, no owner_tx).
    const { outcome } = await runStep(h, onchainJob({ owner_tx: null }));
    expect(outcome).toEqual(STORED_LAUNCH);
  });

  describe('after an operator revocation (signer --revoke-launch, owner_tx cleared)', () => {
    // Regression (audit): the signer rebuilt the launch with a new mint and recorded it on the row,
    // and the builder refused it ("differs from the recorded one" / "already holds different").
    const REBUILT_MINT = address(40);
    const REBUILT_TX = Buffer.from('rebuilt launch transaction').toString('base64');
    const REBUILT_DETAILS = { ...OWNER_TX_DETAILS, pool: address(41) };

    /** The signer prepares a new launch; `records`: it writes the new mint to the row (CAS). */
    function rebuildingSigner(h: Harness, records = true): void {
      h.signer.prepared = {
        partiallySignedTx: REBUILT_TX,
        mint: REBUILT_MINT,
        details: { ...REBUILT_DETAILS, expectedTokensOut: '1', minimumTokensOut: '1' },
      };
      const prepare = h.signer.prepareLaunchCoin.bind(h.signer);
      h.signer.prepareLaunchCoin = async () => {
        const answer = await prepare();
        if (records) h.store.get(LAUNCHPAD_ID).launchpad_coin_mint = answer.mint;
        return answer;
      };
    }

    it('accepts the mint the signer rebuilt and rewrites onchain.launchpadCoinMint', async () => {
      const h = harness();
      await prepareOnchain(h);
      const before = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
      const previous = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
      expect(previous.onchain.launchpadCoinMint).toBe(LAUNCHPAD_COIN_MINT);
      rebuildingSigner(h);

      const { outcome } = await runStep(h, onchainJob({ owner_tx: null }));

      expect(outcome).toEqual({
        patch: { owner_tx: REBUILT_TX, owner_tx_details: REBUILT_DETAILS },
      });
      const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
      expect(config).toEqual({
        ...previous,
        onchain: { ...previous.onchain, launchpadCoinMint: REBUILT_MINT },
      });
      // One builder-owned commit on the job branch, forge.config.json only.
      const head = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
      const commit = h.github.commits.get(head)!;
      expect(commit.parents).toEqual([before]);
      expect(commit.message).toMatch(/rebuilt launch coin mint/);
      expect(h.store.get(LAUNCHPAD_ID)).toMatchObject({
        launchpad_config: LAUNCHPAD_CONFIG,
        launchpad_coin_config: LAUNCHPAD_COIN_CONFIG,
        launchpad_coin_mint: REBUILT_MINT,
      });

      // A re-run after a crash before owner_tx was stored is idempotent: nothing committed again.
      const commits = h.github.commits.size;
      const again = await runStep(h, onchainJob({ owner_tx: null }));
      expect(again.outcome).toEqual(outcome);
      expect(h.github.commits.size).toBe(commits);
    });

    it('rewrites the mint on a re-run after the commit of the rebuilt mint failed', async () => {
      const h = harness();
      await prepareOnchain(h);
      const before = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
      const previous = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
      rebuildingSigner(h);
      h.github.fail('commitFiles', 'before');

      // The signer rebuilt and recorded the new mint, then the commit failed.
      await expect(runStep(h, onchainJob({ owner_tx: null }))).rejects.toThrow(/commitFiles/);
      expect(h.store.get(LAUNCHPAD_ID).launchpad_coin_mint).toBe(REBUILT_MINT);
      expect(h.github.repos.get(REPO)!.branches.get(BRANCH)).toBe(before);
      expect(JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!)).toEqual(previous);

      // The team puts the job back: the row already holds the new mint, the branch the old one.
      const { outcome } = await runStep(h, onchainJob({ owner_tx: null }));
      expect(outcome).toEqual({
        patch: { owner_tx: REBUILT_TX, owner_tx_details: REBUILT_DETAILS },
      });
      const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
      expect(config).toEqual({
        ...previous,
        onchain: { ...previous.onchain, launchpadCoinMint: REBUILT_MINT },
      });
      const head = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
      expect(h.github.commits.get(head)!.parents).toEqual([before]);
      expect(h.github.commits.get(head)!.message).toMatch(/rebuilt launch coin mint/);
      expect(h.store.get(LAUNCHPAD_ID).launchpad_coin_mint).toBe(REBUILT_MINT);

      // Still refused on such a re-run: any other changed address, or a mint the row does not hold.
      const other = harness();
      await prepareOnchain(other);
      rebuildingSigner(other);
      other.github.fail('commitFiles', 'before');
      await expect(runStep(other, onchainJob({ owner_tx: null }))).rejects.toThrow();
      other.signer.configs = { ...other.signer.configs, launchpadConfig: address(44) };
      await expect(runStep(other, onchainJob({ owner_tx: null }))).rejects.toThrow(
        /launchpad config that differs from the recorded one/,
      );
      other.signer.configs = { ...other.signer.configs, launchpadConfig: LAUNCHPAD_CONFIG };
      // The row held another mint when the signer replaced it: the branch must hold that one.
      other.store.get(LAUNCHPAD_ID).launchpad_coin_mint = address(45);
      const commits = other.github.commits.size;
      await expect(runStep(other, onchainJob({ owner_tx: null }))).rejects.toThrow(
        /already holds different on-chain addresses/,
      );
      expect(other.github.commits.size).toBe(commits);
    });

    it('refuses a new mint the signer did not record on the launchpad row', async () => {
      const h = harness();
      await prepareOnchain(h);
      rebuildingSigner(h, false);
      const commits = h.github.commits.size;
      await expect(runStep(h, onchainJob({ owner_tx: null }))).rejects.toThrow(
        /launchpad coin mint that differs from the recorded one/,
      );
      expect(h.github.commits.size).toBe(commits);
      expect(h.store.get(LAUNCHPAD_ID).launchpad_coin_mint).toBe(LAUNCHPAD_COIN_MINT);
    });

    it('never accepts a changed config address, even with a rebuilt mint', async () => {
      const h = harness();
      await prepareOnchain(h);
      rebuildingSigner(h);
      h.signer.configs = { ...h.signer.configs, launchpadConfig: address(42) };
      const commits = h.github.commits.size;
      await expect(runStep(h, onchainJob({ owner_tx: null }))).rejects.toThrow(
        /launchpad config that differs from the recorded one/,
      );
      expect(h.github.commits.size).toBe(commits);
    });

    it('refuses when the branch holds another mint than the one replaced', async () => {
      const h = harness();
      await prepareOnchain(h);
      const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
      config.onchain.launchpadCoinMint = address(43);
      await h.github.commitFiles({
        repo: REPO,
        branch: BRANCH,
        message: 'Edit the config',
        files: [{ path: 'forge.config.json', content: `${JSON.stringify(config, null, 2)}\n` }],
      });
      rebuildingSigner(h);
      const commits = h.github.commits.size;
      await expect(runStep(h, onchainJob({ owner_tx: null }))).rejects.toThrow(
        /already holds different on-chain addresses/,
      );
      expect(h.github.commits.size).toBe(commits);
    });
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
          expect(outcome).toEqual(STORED_LAUNCH);
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
    // The verified client subdomain is the site's host (no wait for the aliases).
    expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('moonpad.clients.test');
    expect(h.vercel.hostWaits).toEqual([{ timeoutMs: 0 }]);
    expect(outcome).toEqual({ message: 'Your launchpad is live at https://moonpad.clients.test' });
    expect(events).toEqual(['Publishing your launchpad', 'Connecting your domain']);
  });

  describe('site host', () => {
    it('records the vercel.app alias of its own project while the subdomain is unverified', async () => {
      const h = harness();
      h.vercel.domainVerified = false;
      await prepareOnchain(h);
      const { outcome } = await runStep(h, deployingJob());
      const project = h.vercel.projectBySlug('moonpad')!;
      expect(h.vercel.aliases).toContainEqual({
        alias: 'lp-moonpad.vercel.app',
        projectId: project.id,
        deploymentId: project.productionDeploymentId,
      });
      expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('lp-moonpad.vercel.app');
      // The aliases may still be moving to the promoted deployment: a bounded wait.
      expect(h.vercel.hostWaits).toEqual([{ timeoutMs: 1_000 }]);
      expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
      expect(outcome).toEqual({
        message: 'Your launchpad is live at https://lp-moonpad.vercel.app',
      });
      // The domain is still attached and its alert kept.
      expect(project.domains.has('moonpad.clients.test')).toBe(true);
      expect(h.alerts).toContainEqual(
        expect.objectContaining({ code: 'domain_unverified:moonpad' }),
      );
      expect(h.alerts.map((a) => a.code)).not.toContain('site_host_missing:moonpad');
    });

    it('never records an alias of another project, even with the expected name', async () => {
      const h = harness();
      h.vercel.domainVerified = false;
      // Someone else's projects: one took `lp-moonpad.vercel.app` first, one is a look-alike.
      h.vercel.aliases.push(
        { alias: 'lp-moonpad.vercel.app', projectId: 'prj_someone', deploymentId: 'dpl_someone' },
        { alias: 'lp-moonpad-evil.vercel.app', projectId: 'prj_evil', deploymentId: 'dpl_evil' },
      );
      h.vercel.productionAliasNames = (p) => [`${p.name}.vercel.app`, `${p.name}-forge.vercel.app`];
      await prepareOnchain(h);
      await runStep(h, deployingJob());
      expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('lp-moonpad-forge.vercel.app');
      expect(h.vercel.aliases.find((a) => a.alias === 'lp-moonpad.vercel.app')?.projectId).toBe(
        'prj_someone',
      );
    });

    it('clears the recorded host and alerts when no verified host serves the site', async () => {
      const h = harness();
      h.vercel.domainVerified = false;
      h.vercel.productionAliasNames = () => [];
      await h.store.updateLaunchpad(LAUNCHPAD_ID, { site_host: 'lp-moonpad.vercel.app' });
      await prepareOnchain(h);
      const { outcome } = await runStep(h, deployingJob());
      expect(h.store.siteHost(LAUNCHPAD_ID)).toBeNull();
      expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
      expect(h.alerts).toContainEqual(
        expect.objectContaining({ level: 'high', code: 'site_host_missing:moonpad' }),
      );
      expect(outcome).toEqual({
        message: 'Your launchpad is live at https://moonpad.clients.test',
      });
    });

    it('alerts on a host another launchpad already holds, then fails the step', async () => {
      const h = harness();
      h.vercel.domainVerified = false;
      await prepareOnchain(h);
      // The unique constraint of `launchpads.site_host` (migration 0011), as PostgREST answers it.
      h.store.beforeWrite = (_id, patch) => {
        if (typeof patch.site_host === 'string') {
          throw new StoreError('update_launchpad: HTTP 409 duplicate key value', 409);
        }
      };
      const error = await runStep(h, deployingJob()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StoreError);
      expect(h.alerts).toContainEqual({
        level: 'high',
        code: 'site_host_conflict:moonpad',
        message: expect.stringContaining('another launchpad') as unknown,
        details: expect.objectContaining({
          launchpad: 'moonpad',
          siteHost: 'lp-moonpad.vercel.app',
        }) as unknown,
      });
      expect(h.store.get(LAUNCHPAD_ID).status).toBe('draft');
    });

    it('does not call any other failed host write a conflict', async () => {
      const h = harness();
      await prepareOnchain(h);
      h.store.beforeWrite = (_id, patch) => {
        if ('site_host' in patch) throw new StoreError('update_launchpad: HTTP 503', 503);
      };
      await expect(runStep(h, deployingJob())).rejects.toBeInstanceOf(StoreError);
      expect(h.alerts.map((a) => a.code)).not.toContain('site_host_conflict:moonpad');
    });

    it('records the same host when the release runs again', async () => {
      const h = harness();
      h.vercel.domainVerified = false;
      await prepareOnchain(h);
      await runStep(h, deployingJob());
      const aliases = structuredClone(h.vercel.aliases);
      const writes = h.store.count('updateLaunchpad');
      await runStep(h, deployingJob());
      expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('lp-moonpad.vercel.app');
      expect(h.vercel.aliases).toEqual(aliases);
      // One more write: the same host (the status is already live).
      expect(h.store.count('updateLaunchpad')).toBe(writes + 1);
    });
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

  it('merges the commit it checked, not what the branch points to by then', async () => {
    const h = harness();
    await prepareOnchain(h);
    const checked = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
    h.github.onCall = (op) => {
      if (op !== 'mergeBranch') return;
      // A push lands on the job branch between the checks and the merge.
      const files = new Map(h.github.filesAt(REPO, BRANCH));
      files.set('src/components/Late.tsx', {
        content: Buffer.from('export const Late = () => null;\n'),
        executable: false,
      });
      h.github.forceBranch(REPO, BRANCH, files, 'late push');
    };
    await runStep(h, deployingJob());
    expect(h.github.text(REPO, 'main', 'src/components/Late.tsx')).toBeUndefined();
    const merge = h.github.commits.get(h.github.repos.get(REPO)!.branches.get('main')!)!;
    expect(merge.parents).toContain(checked);
  });

  it('refuses a clean commit pushed to the job branch after the approved preview', async () => {
    const h = harness();
    await prepareOnchain(h);
    await h.github.commitFiles({
      repo: REPO,
      branch: BRANCH,
      message: 'late change',
      files: [{ path: 'src/components/Note.tsx', content: 'export const Note = () => null;\n' }],
    });
    await expect(runStep(h, deployingJob())).rejects.toThrow(/approved preview/);
    expect(h.github.count('mergeBranch')).toBe(0);
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ level: 'high', code: `release_unapproved:${CREATE_JOB_ID}` }),
    );
  });

  it('accepts only the on-chain section in the commit after the preview', async () => {
    const h = harness();
    await buildPreview(h);
    // A commit that adds the on-chain block and changes the theme too.
    const config = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
    const onchain = {
      cluster: 'devnet',
      launchpadConfig: LAUNCHPAD_CONFIG,
      launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
      launchpadCoinMint: LAUNCHPAD_COIN_MINT,
      ownerWallet: OWNER,
      poolCreationFeeSol: 0.01,
    };
    await h.github.commitFiles({
      repo: REPO,
      branch: BRANCH,
      message: 'onchain and more',
      files: [
        {
          path: 'forge.config.json',
          content: `${JSON.stringify({ ...config, onchain, theme: { ...config.theme, darkMode: false } }, null, 2)}\n`,
        },
      ],
    });
    await expect(runStep(h, deployingJob())).rejects.toThrow(/approved preview/);
    expect(h.github.count('mergeBranch')).toBe(0);
  });

  it('refuses a preview deployment that does not report its Vercel project', async () => {
    const h = harness();
    await prepareOnchain(h);
    const read = h.vercel.getDeployment.bind(h.vercel);
    h.vercel.getDeployment = async (idOrUrl) => ({
      ...(await read(idOrUrl)),
      projectId: undefined,
    });
    await expect(runStep(h, deployingJob())).rejects.toThrow(/does not report its Vercel project/);
    expect(h.github.count('mergeBranch')).toBe(0);
    expect(h.vercel.count('promoteToProduction')).toBe(0);
  });

  it('refuses to promote, with a high alert, a release that took production by itself', async () => {
    const h = harness();
    await prepareOnchain(h);
    // vercel.ts: production pointed at the staged deployment before any promotion.
    h.vercel.fail(
      'waitForDeployment',
      'before',
      new ServiceError('vercel', 'unexpected', 'took production before its promotion', {
        apiCode: PRODUCTION_NOT_STAGED,
      }),
    );
    await expect(runStep(h, deployingJob())).rejects.toThrow(/before its promotion/);
    expect(h.vercel.count('promoteToProduction')).toBe(0);
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('draft');
    const project = h.vercel.projectBySlug('moonpad')!;
    const release = h.vercel.deploymentsOf(project.id).find((d) => d.target === 'production')!;
    expect(h.alerts).toContainEqual({
      level: 'high',
      code: 'production_not_staged:moonpad',
      message: expect.stringContaining('before its checks and its promotion') as unknown,
      details: expect.objectContaining({ deployment: release.id, sha: release.sha }) as unknown,
    });
  });

  it('refuses a release without an approved preview deployment', async () => {
    const h = harness();
    await prepareOnchain(h);
    const handler = createPipelineHandler(h.deps);
    const noPreview = deployingJob({ preview_url: null });
    await expect(handler.handle(noPreview, jobContext().ctx)).rejects.toThrow(/no preview/);
    const unknown = deployingJob({ preview_url: 'https://lp-other-1.vercel.test' });
    await expect(handler.handle(unknown, jobContext().ctx)).rejects.toThrow(/not found/);
    // A production deployment is not an approved preview.
    const project = h.vercel.projectBySlug('moonpad')!;
    const prod = await h.vercel.createDeployment({
      project: { id: project.id, name: project.name },
      repo: REPO,
      ref: BRANCH,
      sha: h.github.repos.get(REPO)!.branches.get(BRANCH)!,
      target: 'production',
    });
    const asProduction = deployingJob({ preview_url: prod.url });
    await expect(handler.handle(asProduction, jobContext().ctx)).rejects.toThrow(/not a preview/);
    expect(h.github.count('mergeBranch')).toBe(0);
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
      ['vercel', 'listProductionHosts'],
      ['store', 'updateLaunchpad'],
    ];
    for (const [fake, op] of ops) {
      for (const when of ['before', 'after'] as const) {
        it(`${fake}.${op} (${when})`, async () => {
          const h = harness();
          h.vercel.domainVerified = false;
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
          expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('lp-moonpad.vercel.app');
        });
      }
    }
  });
});

describe('create: the launchpad moved to another Vercel project (D30)', () => {
  /** Every patch written to the launchpad, in order. */
  function patches(h: Harness): LaunchpadPatch[] {
    const out: LaunchpadPatch[] = [];
    h.store.beforeWrite = (_id, patch) => out.push({ ...patch });
    return out;
  }

  it('building: drops the recorded host in the same write as the new project', async () => {
    const h = harness();
    await h.store.updateLaunchpad(LAUNCHPAD_ID, {
      vercel_project_id: 'prj_old',
      site_host: 'lp-moonpad.vercel.app',
    });
    const written = patches(h);
    await runStep(h, building());
    const project = h.vercel.projectBySlug('moonpad')!;
    expect(written).toContainEqual({ vercel_project_id: project.id, site_host: null });
    expect(written.filter((p) => 'vercel_project_id' in p)).toHaveLength(1);
    expect(h.store.get(LAUNCHPAD_ID).vercel_project_id).toBe(project.id);
    expect(h.store.siteHost(LAUNCHPAD_ID)).toBeNull();
  });

  it('building: a first project leaves the host alone', async () => {
    const h = harness();
    const written = patches(h);
    await runStep(h, building());
    const project = h.vercel.projectBySlug('moonpad')!;
    expect(written).toContainEqual({ vercel_project_id: project.id });
    expect(h.store.siteHost(LAUNCHPAD_ID)).toBeUndefined();
  });

  it('deploying: drops the old host with the new project, then records the new one', async () => {
    const h = harness();
    h.vercel.domainVerified = false;
    await prepareOnchain(h);
    // Recorded for a project that was replaced since (deleted and created again by name).
    h.store.get(LAUNCHPAD_ID).vercel_project_id = 'prj_old';
    await h.store.updateLaunchpad(LAUNCHPAD_ID, { site_host: 'lp-moonpad-old.vercel.app' });
    const written = patches(h);
    await runStep(h, deployingJob());
    const project = h.vercel.projectBySlug('moonpad')!;
    expect(written[0]).toEqual({ vercel_project_id: project.id, site_host: null });
    expect(h.store.siteHost(LAUNCHPAD_ID)).toBe('lp-moonpad.vercel.app');
  });

  it('deploying: a failure after the project change leaves no host of the old project', async () => {
    const h = harness();
    await prepareOnchain(h);
    h.store.get(LAUNCHPAD_ID).vercel_project_id = 'prj_old';
    await h.store.updateLaunchpad(LAUNCHPAD_ID, { site_host: 'lp-moonpad-old.vercel.app' });
    h.github.fail('mergeBranch');
    await expect(runStep(h, deployingJob())).rejects.toThrow();
    expect(h.store.siteHost(LAUNCHPAD_ID)).toBeNull();
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

  it('retries a failed release from owner_signed, never from approved', async () => {
    const h = harness();
    const db = new FakeJobsDb();
    db.addJob({ id: CREATE_JOB_ID, launchpad_id: LAUNCHPAD_ID, status: 'paid' });
    const { worker } = workerFor(h, db);
    const step = async () => {
      await worker.tick();
      await worker.idle();
    };
    await step();
    db.get(CREATE_JOB_ID).status = 'approved';
    await step();
    db.get(CREATE_JOB_ID).status = 'owner_signed';
    h.vercel.fail('createDeployment');
    await step();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({ status: 'failed', failed_stage: 'deploy' });
    const prepares = h.signer.count('prepareLaunchCoin');

    // Wrong retry status: the on-chain step refuses to prepare another launch.
    db.get(CREATE_JOB_ID).status = 'approved';
    await step();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({ status: 'failed', failed_stage: 'onchain' });
    expect(db.get(CREATE_JOB_ID).error).toMatch(/owner_signed/);
    expect(h.signer.count('prepareLaunchCoin')).toBe(prepares);

    // Documented retry status for a creation release: owner_signed.
    db.get(CREATE_JOB_ID).status = 'owner_signed';
    await step();
    expect(db.get(CREATE_JOB_ID)).toMatchObject({ status: 'live' });
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
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
