/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import {
  serializeSiteConfig,
  initialSiteConfig,
  onchainBlock,
  withOnchain,
  withMode,
} from './pipeline/site-config.js';
import {
  FakeGithub,
  FakeStore,
  FakeVercel,
  LAUNCHPAD_COIN_CONFIG,
  LAUNCHPAD_COIN_MINT,
  LAUNCHPAD_CONFIG,
  LAUNCHPAD_ID,
  launchpadFixture,
  silentLogger,
  specFixture,
  templateFiles,
} from './pipeline/test-fakes.js';
import { TEST_PROJECT_ENV } from './pipeline/test-harness.js';
import type { SiteMode } from '@forge/shared';
import {
  runSleepCycle,
  setLaunchpadMode,
  sleepLaunchpad,
  startSleepScheduler,
  wakeLaunchpad,
  type SleepDeps,
} from './sleep.js';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
const REPO = 'lp-moonpad';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';

function siteConfig(mode: SiteMode, slug = 'moonpad', name = 'MoonPad'): string {
  const spec = { ...specFixture(), slug, name };
  const onchain = onchainBlock({
    cluster: 'devnet',
    launchpadConfig: LAUNCHPAD_CONFIG,
    launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
    launchpadCoinMint: LAUNCHPAD_COIN_MINT,
    spec,
  });
  return serializeSiteConfig(withMode(withOnchain(initialSiteConfig(spec), onchain), mode));
}

async function setup(opts: { mode?: SiteMode; lastTradeDaysAgo?: number | null } = {}) {
  const github = new FakeGithub();
  const vercel = new FakeVercel();
  const store = new FakeStore();
  const files = templateFiles();
  files.set('forge.config.json', {
    content: Buffer.from(siteConfig(opts.mode ?? 'live')),
    executable: false,
  });
  github.seedRepo('moonpad', files);
  await vercel.ensureProject({ slug: 'moonpad' });
  const days = opts.lastTradeDaysAgo === undefined ? 40 : opts.lastTradeDaysAgo;
  store.add(
    launchpadFixture({
      status: opts.mode === 'sleeping' ? 'sleeping' : 'live',
      github_repo: REPO,
      last_trade_at: days === null ? null : new Date(NOW - days * DAY).toISOString(),
      created_at: new Date(NOW - 90 * DAY).toISOString(),
    }),
  );
  const alerts: string[] = [];
  let paused = false;
  const deps: SleepDeps = {
    store,
    github,
    vercel,
    projectEnv: TEST_PROJECT_ENV,
    logger: silentLogger(),
    isPaused: async () => paused,
    alerter: {
      alert: async (_level, code) => {
        alerts.push(code);
      },
    },
    now: () => NOW,
  };
  return { github, vercel, store, deps, alerts, pause: () => (paused = true) };
}

function mode(github: FakeGithub): string {
  return JSON.parse(github.text(REPO, 'main', 'forge.config.json')!).mode;
}

describe('sleep mode', () => {
  it('puts a dormant launchpad to sleep: mode commit, production deployment, status', async () => {
    const { github, vercel, store, deps } = await setup();
    const result = await runSleepCycle(deps);
    expect(result).toMatchObject({ paused: false, slept: ['moonpad'], woken: [], failed: [] });
    expect(mode(github)).toBe('sleeping');
    const config = JSON.parse(github.text(REPO, 'main', 'forge.config.json')!);
    expect(config.onchain.launchpadConfig).toBe(LAUNCHPAD_CONFIG);
    const project = vercel.projectBySlug('moonpad')!;
    const main = github.repos.get(REPO)!.branches.get('main');
    const production = vercel.deployments.get(project.productionDeploymentId!)!;
    expect(production).toMatchObject({ target: 'production', sha: main, readyState: 'READY' });
    expect(production.env.POOL_CONFIG_KEY).toBe(`${LAUNCHPAD_CONFIG},${LAUNCHPAD_COIN_CONFIG}`);
    expect(store.get(LAUNCHPAD_ID).status).toBe('sleeping');
  });

  it('counts a launchpad that never traded from its creation date', async () => {
    const { deps } = await setup({ lastTradeDaysAgo: null });
    expect((await runSleepCycle(deps)).slept).toEqual(['moonpad']);
  });

  it('leaves recently traded launchpads alone', async () => {
    const { github, vercel, deps } = await setup({ lastTradeDaysAgo: 3 });
    const result = await runSleepCycle(deps);
    expect(result.slept).toEqual([]);
    expect(mode(github)).toBe('live');
    expect(vercel.deployments.size).toBe(0);
  });

  it('leaves a launchpad with a job in flight or a recent job alone', async () => {
    for (const job of [
      { status: 'building', updatedAt: new Date(NOW - 60 * DAY).toISOString() },
      { status: 'live', updatedAt: new Date(NOW - 2 * DAY).toISOString() },
    ]) {
      const { github, store, deps } = await setup();
      store.jobs.push({ launchpadId: LAUNCHPAD_ID, ...job });
      const result = await runSleepCycle(deps);
      expect(result).toMatchObject({ slept: [], skipped: ['moonpad'] });
      expect(mode(github)).toBe('live');
    }
  });

  it('does nothing while deploys are paused', async () => {
    const { github, store, deps, pause } = await setup();
    pause();
    expect(await runSleepCycle(deps)).toMatchObject({ paused: true, slept: [] });
    expect(store.calls).toEqual([]);
    expect(mode(github)).toBe('live');
  });

  it('never touches a disabled launchpad or a disabled site', async () => {
    const a = await setup();
    a.store.setStatus(LAUNCHPAD_ID, 'disabled');
    await expect(sleepLaunchpad(a.deps, LAUNCHPAD_ID)).rejects.toThrow(/disabled/);
    expect((await runSleepCycle(a.deps)).slept).toEqual([]);
    const b = await setup({ mode: 'disabled' });
    await expect(sleepLaunchpad(b.deps, LAUNCHPAD_ID)).rejects.toThrow(/disabled/);
    expect(b.github.count('commitFiles')).toBe(0);
    expect(b.vercel.deployments.size).toBe(0);
  });

  it('wakes a sleeping launchpad that traded again', async () => {
    const { github, store, deps } = await setup({ mode: 'sleeping', lastTradeDaysAgo: 1 });
    const result = await runSleepCycle(deps);
    expect(result.woken).toEqual(['moonpad']);
    expect(mode(github)).toBe('live');
    expect(store.get(LAUNCHPAD_ID).status).toBe('live');
  });

  it('wakes on request and is idempotent', async () => {
    const { github, vercel, deps } = await setup({ mode: 'sleeping', lastTradeDaysAgo: 60 });
    const first = await wakeLaunchpad(deps, LAUNCHPAD_ID);
    const second = await wakeLaunchpad(deps, LAUNCHPAD_ID);
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.deploymentId).toBe(first.deploymentId);
    expect(github.count('commitFiles')).toBe(1);
    expect(vercel.deployments.size).toBe(1);
  });

  it('reports a failure, alerts and carries on with the next launchpad', async () => {
    const { github, store, deps, alerts } = await setup();
    // A second dormant launchpad whose repository is missing.
    store.add(
      launchpadFixture({
        id: OTHER_ID,
        slug: 'ghostpad',
        status: 'live',
        created_at: new Date(NOW - 90 * DAY).toISOString(),
      }),
    );
    const result = await runSleepCycle(deps);
    expect(result.slept).toEqual(['moonpad']);
    expect(result.failed).toEqual([
      { slug: 'ghostpad', error: expect.stringMatching(/repository/) },
    ]);
    expect(alerts).toEqual(['sleep_failed:ghostpad']);
    expect(mode(github)).toBe('sleeping');
  });

  describe('re-run after a crash at each step', () => {
    const ops: Array<['github' | 'vercel' | 'store', string]> = [
      ['github', 'commitFiles'],
      ['vercel', 'ensureProject'],
      ['vercel', 'setEnv'],
      ['vercel', 'createDeployment'],
      ['vercel', 'waitForDeployment'],
      ['vercel', 'promoteToProduction'],
      ['store', 'updateLaunchpad'],
    ];
    for (const [fake, op] of ops) {
      for (const when of ['before', 'after'] as const) {
        it(`${fake}.${op} (${when})`, async () => {
          const h = await setup();
          h[fake].fail(op, when);
          await expect(sleepLaunchpad(h.deps, LAUNCHPAD_ID)).rejects.toThrow();
          await sleepLaunchpad(h.deps, LAUNCHPAD_ID);
          expect(mode(h.github)).toBe('sleeping');
          const modeCommits = [...h.github.commits.values()].filter(
            (c) => c.message === 'Put the site to sleep',
          );
          expect(modeCommits).toHaveLength(1);
          const project = h.vercel.projectBySlug('moonpad')!;
          expect(h.vercel.deploymentsOf(project.id)).toHaveLength(1);
          expect(project.productionDeploymentId).toBe(h.vercel.deploymentsOf(project.id)[0]!.id);
          expect(h.store.get(LAUNCHPAD_ID).status).toBe('sleeping');
        });
      }
    }
  });

  it('stops before the next side effect when aborted', async () => {
    const { github, vercel, deps } = await setup();
    const controller = new AbortController();
    github.onCall = (op) => {
      if (op === 'commitFiles') controller.abort('shutdown');
    };
    await expect(
      setLaunchpadMode(deps, LAUNCHPAD_ID, 'sleeping', controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(vercel.calls.filter((c) => c !== 'ensureProject')).toEqual([]);
    expect(vercel.count('ensureProject')).toBe(1); // seeded in setup only
  });

  it('runs on a schedule and stops cleanly', async () => {
    const { store, deps } = await setup();
    const scheduler = startSleepScheduler(deps, { initialDelayMs: 1, intervalMs: 60_000 });
    for (let i = 0; i < 200 && store.get(LAUNCHPAD_ID).status !== 'sleeping'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await scheduler.stop();
    expect(store.get(LAUNCHPAD_ID).status).toBe('sleeping');
    expect(store.count('listDormant')).toBe(1);
  });
});
