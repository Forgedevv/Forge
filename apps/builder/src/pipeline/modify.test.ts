/// <reference types="node" />
import type { JobRow } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobBranch } from './context.js';
import { PipelineError, PolicyViolationError } from './errors.js';
import { createPipelineHandler } from './index.js';
import { MAX_REQUEST_CHARS } from '../prompts/index.js';
import {
  address,
  CREATE_JOB_ID,
  jobContext,
  jobFixture,
  LAUNCHPAD_CONFIG,
  LAUNCHPAD_ID,
  makeJobsRoot,
  MODIFY_JOB_ID,
} from './test-fakes.js';
import { agents, designAgent, makeHarness, modifyAgent, type Harness } from './test-harness.js';

const REPO = 'lp-moonpad';
const BRANCH = jobBranch(MODIFY_JOB_ID);

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

async function run(h: Harness, job: JobRow) {
  const { ctx, events } = jobContext();
  const outcome = await createPipelineHandler(h.deps).handle(job, ctx);
  return { outcome, events };
}

const modifyJob = (over: Partial<JobRow> = {}) =>
  jobFixture({
    id: MODIFY_JOB_ID,
    type: 'modify_launchpad',
    status: 'building',
    request: 'Make the accent color green and change the tagline to "Now even faster".',
    ...over,
  });

/** A launchpad that went through the whole creation flow. */
async function liveLaunchpad(): Promise<Harness> {
  const h = makeHarness(root);
  h.runner.agent = designAgent;
  const create = (status: JobRow['status']) => jobFixture({ id: CREATE_JOB_ID, status });
  await run(h, create('building'));
  await run(h, create('onchain_setup'));
  await run(h, create('deploying'));
  expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
  h.runner.agent = modifyAgent;
  return h;
}

function mainConfig(h: Harness): Record<string, unknown> {
  return JSON.parse(h.github.text(REPO, 'main', 'forge.config.json')!) as Record<string, unknown>;
}

describe('modify: building', () => {
  it('applies the request on the live site and publishes a preview', async () => {
    const h = await liveLaunchpad();
    const before = mainConfig(h);
    const { outcome, events } = await run(h, modifyJob());
    const project = h.vercel.projectBySlug('moonpad')!;
    const head = h.github.repos.get(REPO)!.branches.get(BRANCH)!;
    const preview = h.vercel.deploymentsOf(project.id).find((d) => d.sha === head)!;
    expect(outcome).toEqual({ patch: { preview_url: preview.url } });
    expect(preview.target).toBe('preview');

    const branch = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
    expect(branch.theme.accentColor).toBe('#00FF88');
    expect(branch.content.tagline).toBe('Now even faster');
    expect(branch.onchain).toEqual(before.onchain);
    expect(branch.mode).toBe('live');
    // Earlier work stays (the agent started from the live site).
    expect(h.github.text(REPO, BRANCH, 'src/components/Hero.tsx')).toContain('MoonPad');
    // The live site is untouched until approval, and the repo was not created again.
    expect(mainConfig(h)).toEqual(before);
    expect(h.github.count('ensureRepoFromTemplate')).toBe(1);
    expect(events[0]).toBe('Opening your launchpad repo');
    expect(events).toContain('Applying your changes');

    // The prompt carries the request as data.
    const agentRun = h.runner.runs.filter((r) => r.step === 'agent').at(-1)!;
    const prompt = agentRun.options.command[2]!;
    expect(prompt).toContain('<client_request>');
    expect(prompt).toContain('Make the accent color green');
    // The preview of a live launchpad gets its pool config keys.
    expect(preview.env.POOL_CONFIG_KEY).toContain(LAUNCHPAD_CONFIG);
  });

  it('cannot touch forge.config.json#onchain', async () => {
    const h = await liveLaunchpad();
    h.runner.agent = agents.changeOnchain;
    const error = await run(h, modifyJob()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyViolationError);
    const violations = (error as PolicyViolationError).violations;
    expect(violations.some((v) => v.rule === 'forge-config-locked-field')).toBe(true);
    expect(violations.some((v) => v.reason.includes('onchain'))).toBe(true);
    expect(h.github.repos.get(REPO)!.branches.has(BRANCH)).toBe(false);
    expect(h.runner.runs.filter((r) => r.step !== 'agent')).toHaveLength(2); // creation only
  });

  it('cannot touch forge.config.json#mode', async () => {
    const h = await liveLaunchpad();
    h.runner.agent = agents.changeMode;
    const error = await run(h, modifyJob()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect((error as PolicyViolationError).violations.some((v) => v.reason.includes('mode'))).toBe(
      true,
    );
    expect(h.github.repos.get(REPO)!.branches.has(BRANCH)).toBe(false);
  });

  it('cannot touch src/forge', async () => {
    const h = await liveLaunchpad();
    h.runner.agent = agents.touchForgeZone;
    await expect(run(h, modifyJob())).rejects.toBeInstanceOf(PolicyViolationError);
    expect(h.github.repos.get(REPO)!.branches.has(BRANCH)).toBe(false);
  });

  it('refuses an empty or oversized request before running the agent', async () => {
    const h = await liveLaunchpad();
    const agentRuns = () => h.runner.runs.filter((r) => r.step === 'agent').length;
    const before = agentRuns();
    await expect(run(h, modifyJob({ request: '  ' }))).rejects.toBeInstanceOf(PipelineError);
    await expect(
      run(h, modifyJob({ request: 'x'.repeat(MAX_REQUEST_CHARS + 1) })),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(agentRuns()).toBe(before);
    expect(h.gateway.issued).toHaveLength(1);
  });

  it('needs a launchpad that went live', async () => {
    const h = makeHarness(root);
    await expect(run(h, modifyJob())).rejects.toThrow(/went live/);
    expect(h.github.calls).toEqual([]);
  });

  it('has no on-chain step', async () => {
    const h = await liveLaunchpad();
    const signerCalls = h.signer.calls.length;
    await expect(run(h, modifyJob({ status: 'onchain_setup' }))).rejects.toThrow(
      /no on-chain step/,
    );
    expect(h.signer.calls.length).toBe(signerCalls);
  });
});

describe('modify: deploying', () => {
  it('releases the approved preview to production', async () => {
    const h = await liveLaunchpad();
    await run(h, modifyJob());
    const { outcome } = await run(h, modifyJob({ status: 'deploying' }));
    const config = mainConfig(h);
    expect((config.theme as Record<string, unknown>).accentColor).toBe('#00FF88');
    expect(config.mode).toBe('live');
    const project = h.vercel.projectBySlug('moonpad')!;
    const production = h.vercel.deploymentsOf(project.id).filter((d) => d.target === 'production');
    expect(production).toHaveLength(2);
    const main = h.github.repos.get(REPO)!.branches.get('main')!;
    expect(project.productionDeploymentId).toBe(production[1]!.id);
    expect(production[1]!.sha).toBe(main);
    expect(outcome).toEqual({ message: 'Your launchpad is live at https://moonpad.clients.test' });
    expect(h.signer.count('createConfigs')).toBe(1);
  });

  it('refuses a branch whose on-chain section differs from the live site', async () => {
    const h = await liveLaunchpad();
    await run(h, modifyJob());
    // Tamper with the job branch after the preview.
    const branch = JSON.parse(h.github.text(REPO, BRANCH, 'forge.config.json')!);
    branch.onchain.launchpadConfig = address(77);
    await h.github.commitFiles({
      repo: REPO,
      branch: BRANCH,
      message: 'tamper',
      files: [{ path: 'forge.config.json', content: `${JSON.stringify(branch, null, 2)}\n` }],
    });
    const mainBefore = h.github.repos.get(REPO)!.branches.get('main');
    const error = await run(h, modifyJob({ status: 'deploying' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect(h.github.count('mergeBranch')).toBe(1); // the creation release only
    expect(h.github.repos.get(REPO)!.branches.get('main')).toBe(mainBefore);
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ level: 'high', code: `release_blocked:${MODIFY_JOB_ID}` }),
    );
  });

  it('wakes a sleeping launchpad on release', async () => {
    const h = await liveLaunchpad();
    // The site went to sleep: mode sleeping on main, status sleeping.
    const sleeping = { ...mainConfig(h), mode: 'sleeping' };
    await h.github.commitFiles({
      repo: REPO,
      branch: 'main',
      message: 'sleep',
      files: [{ path: 'forge.config.json', content: `${JSON.stringify(sleeping, null, 2)}\n` }],
    });
    h.store.setStatus(LAUNCHPAD_ID, 'sleeping');
    await run(h, modifyJob());
    await run(h, modifyJob({ status: 'deploying' }));
    expect(mainConfig(h).mode).toBe('live');
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
    const project = h.vercel.projectBySlug('moonpad')!;
    const main = h.github.repos.get(REPO)!.branches.get('main')!;
    expect(h.vercel.deployments.get(project.productionDeploymentId!)!.sha).toBe(main);
  });

  it('converges when re-run after a crash after the merge', async () => {
    const h = await liveLaunchpad();
    await run(h, modifyJob());
    h.vercel.fail('createDeployment', 'after');
    await expect(run(h, modifyJob({ status: 'deploying' }))).rejects.toThrow();
    await run(h, modifyJob({ status: 'deploying' }));
    const project = h.vercel.projectBySlug('moonpad')!;
    const production = h.vercel.deploymentsOf(project.id).filter((d) => d.target === 'production');
    expect(production).toHaveLength(2);
    const merges = [...h.github.commits.values()].filter((c) => c.parents.length === 2);
    expect(merges).toHaveLength(2);
  });

  it('refuses a disabled launchpad', async () => {
    const h = await liveLaunchpad();
    await run(h, modifyJob());
    h.store.setStatus(LAUNCHPAD_ID, 'disabled');
    await expect(run(h, modifyJob({ status: 'deploying' }))).rejects.toThrow(/disabled/);
    expect(h.github.count('mergeBranch')).toBe(1);
  });
});
