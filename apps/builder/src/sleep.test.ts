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
import { TEST_PROJECT_ENV, TEST_RELAY_SECRET } from './pipeline/test-harness.js';
import type { SiteMode } from '@forge/shared';
import {
  DeploysPausedError,
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
    rpcRelayTokenSecret: TEST_RELAY_SECRET,
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
    expect(production.env.FORGE_RPC_RELAY_TOKEN).toMatch(/^v1\.moonpad\.[0-9a-f]{64}$/);
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

  it('does not promote when the launchpad is disabled while the deployment builds', async () => {
    const { vercel, store, deps } = await setup();
    vercel.onCall = (op) => {
      if (op === 'waitForDeployment') store.setStatus(LAUNCHPAD_ID, 'disabled');
    };
    await expect(sleepLaunchpad(deps, LAUNCHPAD_ID)).rejects.toThrow(/disabled/);
    expect(vercel.count('promoteToProduction')).toBe(0);
    expect(store.get(LAUNCHPAD_ID).status).toBe('disabled');
  });

  it('never overwrites a disabled status set right before the status write', async () => {
    const { store, deps } = await setup();
    store.beforeWrite = () => store.setStatus(LAUNCHPAD_ID, 'disabled');
    await expect(sleepLaunchpad(deps, LAUNCHPAD_ID)).rejects.toThrow(/status changed/);
    expect(store.get(LAUNCHPAD_ID).status).toBe('disabled');
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

  /** A second launchpad with its repo and project (ids sort after LAUNCHPAD_ID). */
  async function addLaunchpad(
    h: Awaited<ReturnType<typeof setup>>,
    id: string,
    slug: string,
    mode: SiteMode = 'live',
  ): Promise<void> {
    const files = templateFiles();
    files.set('forge.config.json', {
      content: Buffer.from(siteConfig(mode, slug, `Pad ${slug}`)),
      executable: false,
    });
    h.github.seedRepo(slug, files);
    await h.vercel.ensureProject({ slug });
    h.store.add(
      launchpadFixture({
        id,
        slug,
        spec: { ...specFixture(), slug, name: `Pad ${slug}` },
        status: mode === 'sleeping' ? 'sleeping' : 'live',
        github_repo: `lp-${slug}`,
        last_trade_at: new Date(NOW - (mode === 'sleeping' ? 1 : 40) * DAY).toISOString(),
        created_at: new Date(NOW - 90 * DAY).toISOString(),
      }),
    );
  }

  describe('deploys_paused is re-read before every deployment step', () => {
    it('stops the cycle as soon as the switch is set', async () => {
      const h = await setup();
      await addLaunchpad(h, '22222222-2222-4333-8444-555555555555', 'secondpad');
      // The first launchpad was promoted before the switch: the next one is never touched.
      h.vercel.onCall = (op) => {
        if (op === 'promoteToProduction' && h.vercel.count('promoteToProduction') === 1) h.pause();
      };
      const result = await runSleepCycle(h.deps);
      expect(result.paused).toBe(true);
      expect(result.slept).toEqual(['moonpad']);
      expect(result.failed).toEqual([]);
      expect(h.store.get('22222222-2222-4333-8444-555555555555').status).toBe('live');
      expect(h.vercel.count('createDeployment')).toBe(1);
    });

    for (const [op, expectCommit, expectDeployment] of [
      ['getBranchHead', false, false],
      ['setEnv', true, false],
      ['waitForDeployment', true, true],
    ] as const) {
      it(`refuses to go on when deploys are paused at ${op}`, async () => {
        const h = await setup();
        h.github.onCall = (o) => {
          if (o === op) h.pause();
        };
        h.vercel.onCall = (o) => {
          if (o === op) h.pause();
        };
        await expect(sleepLaunchpad(h.deps, LAUNCHPAD_ID)).rejects.toBeInstanceOf(
          DeploysPausedError,
        );
        expect(h.github.count('commitFiles')).toBe(expectCommit ? 1 : 0);
        expect(h.vercel.count('createDeployment')).toBe(expectDeployment ? 1 : 0);
        expect(h.vercel.count('promoteToProduction')).toBe(0);
        expect(h.store.get(LAUNCHPAD_ID).status).toBe('live');
      });
    }

    it('fails closed when the switch cannot be read', async () => {
      const h = await setup();
      let reads = 0;
      h.deps.isPaused = async () => {
        reads += 1;
        if (reads > 1) throw new Error('flags unreadable');
        return false;
      };
      const result = await runSleepCycle(h.deps);
      expect(result).toMatchObject({ paused: true, slept: [], failed: [] });
      expect(h.vercel.count('createDeployment')).toBe(0);
      // Unreadable from the start: nothing at all.
      h.deps.isPaused = async () => {
        throw new Error('flags unreadable');
      };
      expect(await runSleepCycle(h.deps)).toMatchObject({ paused: true, slept: [] });
      expect(h.store.count('listDormant')).toBe(1);
    });
  });

  it('never redeploys around a job that failed after approval', async () => {
    for (const failedStage of ['onchain', 'deploy']) {
      const { github, vercel, store, deps } = await setup();
      store.jobs.push({
        launchpadId: LAUNCHPAD_ID,
        status: 'failed',
        failedStage,
        updatedAt: new Date(NOW - 300 * DAY).toISOString(),
      });
      expect(await runSleepCycle(deps)).toMatchObject({ slept: [], skipped: ['moonpad'] });
      expect(mode(github)).toBe('live');
      expect(vercel.deployments.size).toBe(0);
    }
    // Same for a wake-up.
    const woken = await setup({ mode: 'sleeping', lastTradeDaysAgo: 1 });
    woken.store.jobs.push({
      launchpadId: LAUNCHPAD_ID,
      status: 'failed',
      failedStage: 'deploy',
      updatedAt: new Date(NOW - 300 * DAY).toISOString(),
    });
    expect(await runSleepCycle(woken.deps)).toMatchObject({ woken: [], skipped: ['moonpad'] });
    // An old build failure (refunded or not) does not block anything.
    const build = await setup();
    build.store.jobs.push({
      launchpadId: LAUNCHPAD_ID,
      status: 'failed',
      failedStage: 'build',
      updatedAt: new Date(NOW - 300 * DAY).toISOString(),
    });
    expect((await runSleepCycle(build.deps)).slept).toEqual(['moonpad']);
  });

  it('pages through every candidate: skipped launchpads cannot starve the others', async () => {
    const h = await setup();
    const second = '22222222-2222-4333-8444-555555555555';
    const third = '33333333-2222-4333-8444-555555555555';
    await addLaunchpad(h, second, 'secondpad');
    await addLaunchpad(h, third, 'thirdpad');
    // The first two have a job in flight, every cycle.
    for (const id of [LAUNCHPAD_ID, second]) {
      h.store.jobs.push({ launchpadId: id, status: 'preview_ready', updatedAt: '2026-01-01' });
    }
    h.deps.batchSize = 1;
    const result = await runSleepCycle(h.deps);
    expect(result.skipped).toEqual(['moonpad', 'secondpad']);
    expect(result.slept).toEqual(['thirdpad']);
    expect(h.store.get(third).status).toBe('sleeping');
    // Pages of one row until a short page: three rows, then an empty page.
    expect(h.store.count('listDormant')).toBe(4);
  });

  it('pages through failing launchpads too', async () => {
    const h = await setup();
    const second = '22222222-2222-4333-8444-555555555555';
    await addLaunchpad(h, second, 'secondpad');
    h.github.repos.delete(REPO); // the first one always fails
    h.deps.batchSize = 1;
    const result = await runSleepCycle(h.deps);
    expect(result.failed.map((f) => f.slug)).toEqual(['moonpad']);
    expect(result.slept).toEqual(['secondpad']);
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
