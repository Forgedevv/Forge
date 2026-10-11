/// <reference types="node" />
import type { SiteMode } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import { cutDisabledLaunchpad, enforceDisabledLaunchpads, type DisableDeps } from './disable.js';
import {
  initialSiteConfig,
  onchainBlock,
  serializeSiteConfig,
  withMode,
  withOnchain,
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
import { startSleepScheduler } from './sleep.js';

const REPO = 'lp-moonpad';
const SECOND = '22222222-2222-4333-8444-555555555555';

function siteConfig(mode: SiteMode, slug = 'moonpad'): string {
  const spec = { ...specFixture(), slug };
  const onchain = onchainBlock({
    cluster: 'devnet',
    launchpadConfig: LAUNCHPAD_CONFIG,
    launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
    launchpadCoinMint: LAUNCHPAD_COIN_MINT,
    spec,
  });
  return serializeSiteConfig(withMode(withOnchain(initialSiteConfig(spec), onchain), mode));
}

/** A launchpad that went live (production deployment of main), then disabled by the team. */
async function setup(opts: { released?: boolean; status?: 'disabled' | 'live' } = {}) {
  const github = new FakeGithub();
  const vercel = new FakeVercel();
  const store = new FakeStore();
  const alerts: Array<{ level: string; code: string }> = [];
  let paused = false;
  async function addSite(id: string, slug: string): Promise<void> {
    const files = templateFiles();
    files.set('forge.config.json', {
      content: Buffer.from(siteConfig('live', slug)),
      executable: false,
    });
    github.seedRepo(slug, files);
    const { project } = await vercel.ensureProject({ slug });
    if (opts.released !== false) {
      const d = await vercel.createDeployment({
        project: { id: project.id, name: project.name },
        repo: `lp-${slug}`,
        ref: 'main',
        sha: github.repos.get(`lp-${slug}`)!.branches.get('main')!,
        target: 'production',
      });
      await vercel.waitForDeployment(d.id);
      await vercel.promoteToProduction(project.id, d.id);
    }
    store.add(
      launchpadFixture({
        id,
        slug,
        spec: { ...specFixture(), slug },
        status: opts.status ?? 'disabled',
        github_repo: `lp-${slug}`,
        vercel_project_id: project.id,
      }),
    );
  }
  await addSite(LAUNCHPAD_ID, 'moonpad');
  const verified = new Map<string, string>();
  const deps: DisableDeps = {
    store,
    github,
    vercel,
    projectEnv: TEST_PROJECT_ENV,
    rpcRelayTokenSecret: TEST_RELAY_SECRET,
    logger: silentLogger(),
    isPaused: async () => paused,
    alerter: {
      alert: async (level, code) => {
        alerts.push({ level, code });
      },
    },
    verified,
  };
  return {
    github,
    vercel,
    store,
    deps,
    alerts,
    addSite,
    verified,
    pause: () => (paused = true),
  };
}

const mainMode = (github: FakeGithub, repo = REPO): string =>
  JSON.parse(github.text(repo, 'main', 'forge.config.json')!).mode;

const production = (vercel: FakeVercel, slug = 'moonpad') => {
  const p = vercel.projectBySlug(slug)!;
  return p.productionDeploymentId ? vercel.deployments.get(p.productionDeploymentId) : undefined;
};

describe('disabled launchpads', () => {
  it('cuts the live site: mode disabled on main, production deployment, promotion, alert', async () => {
    const h = await setup();
    const result = await enforceDisabledLaunchpads(h.deps);
    expect(result).toMatchObject({ cut: [{ slug: 'moonpad', how: 'maintenance' }], failed: [] });
    expect(mainMode(h.github)).toBe('disabled');
    const main = h.github.repos.get(REPO)!.branches.get('main')!;
    expect(h.github.commits.get(main)!.message).toBe('Disable the site (cut by FORGE)');
    expect(production(h.vercel)).toMatchObject({ sha: main, target: 'production' });
    expect(production(h.vercel)!.env.POOL_CONFIG_KEY).toContain(LAUNCHPAD_CONFIG);
    expect(h.vercel.projectBySlug('moonpad')!.paused).toBe(false);
    expect(h.alerts).toEqual([{ level: 'normal', code: 'site_cut:moonpad' }]);
    // The status stays the team's: the builder never writes it here.
    expect(h.store.get(LAUNCHPAD_ID).status).toBe('disabled');
    expect(h.store.count('updateLaunchpad')).toBe(0);
  });

  it('is idempotent: a cut site is left alone, without new commits, deployments or alerts', async () => {
    const h = await setup();
    await enforceDisabledLaunchpads(h.deps);
    const commits = h.github.commits.size;
    const deployments = h.vercel.deployments.size;
    const second = await enforceDisabledLaunchpads(h.deps);
    expect(second).toMatchObject({ cut: [], alreadyCut: 1, failed: [] });
    expect(h.github.commits.size).toBe(commits);
    expect(h.vercel.deployments.size).toBe(deployments);
    expect(h.alerts).toHaveLength(1);
    // Without the in-memory cache (a restart), the production commit is verified on GitHub.
    h.verified.clear();
    expect(await enforceDisabledLaunchpads(h.deps)).toMatchObject({ alreadyCut: 1, cut: [] });
    expect(h.vercel.count('getDeployment')).toBeGreaterThan(0);
    expect(h.vercel.deployments.size).toBe(deployments);
  });

  it('cuts again when the production deployment changed after the cut', async () => {
    const h = await setup();
    await enforceDisabledLaunchpads(h.deps);
    // Someone promoted the previous (live) deployment again.
    const project = h.vercel.projectBySlug('moonpad')!;
    const live = h.vercel.deploymentsOf(project.id)[0]!;
    project.productionDeploymentId = live.id;
    const result = await enforceDisabledLaunchpads(h.deps);
    expect(result.cut).toEqual([{ slug: 'moonpad', how: 'maintenance' }]);
    expect(project.productionDeploymentId).not.toBe(live.id);
    expect(mainMode(h.github)).toBe('disabled');
  });

  it('pauses the project when the maintenance page cannot be deployed', async () => {
    const h = await setup();
    h.vercel.nextState = 'ERROR';
    const result = await enforceDisabledLaunchpads(h.deps);
    expect(result.cut).toEqual([
      { slug: 'moonpad', how: 'paused', reason: expect.stringMatching(/ERROR/) },
    ]);
    expect(h.vercel.projectBySlug('moonpad')!.paused).toBe(true);
    expect(h.alerts).toEqual([{ level: 'high', code: 'site_cut:moonpad' }]);
    // Paused counts as cut from then on.
    expect(await enforceDisabledLaunchpads(h.deps)).toMatchObject({ cut: [], alreadyCut: 1 });
    expect(h.vercel.count('pauseProject')).toBe(1);
  });

  it('pauses without deploying anything while deploys are paused', async () => {
    const h = await setup();
    h.pause();
    const deployments = h.vercel.deployments.size;
    const result = await enforceDisabledLaunchpads(h.deps);
    expect(result.cut).toEqual([
      { slug: 'moonpad', how: 'paused', reason: expect.stringMatching(/deploys_paused/) },
    ]);
    expect(h.vercel.deployments.size).toBe(deployments);
    expect(h.github.count('commitFiles')).toBe(0);
    expect(h.vercel.projectBySlug('moonpad')!.paused).toBe(true);
  });

  it('pauses a project that never went to production (its previews are cut too)', async () => {
    const h = await setup({ released: false });
    const result = await cutDisabledLaunchpad(h.deps, LAUNCHPAD_ID);
    expect(result).toEqual({ state: 'cut', how: 'paused', reason: 'no production deployment' });
    expect(h.vercel.projectBySlug('moonpad')!.paused).toBe(true);
    expect(h.github.count('commitFiles')).toBe(0);
  });

  it('does nothing for a launchpad without a project, or one that is not disabled', async () => {
    const h = await setup({ status: 'live' });
    expect(await cutDisabledLaunchpad(h.deps, LAUNCHPAD_ID)).toEqual({ state: 'not-disabled' });
    expect(await enforceDisabledLaunchpads(h.deps)).toMatchObject({ cut: [], alreadyCut: 0 });
    expect(mainMode(h.github)).toBe('live');
    const none = await setup();
    none.vercel.projects.clear();
    none.store.get(LAUNCHPAD_ID).vercel_project_id = null;
    expect(await cutDisabledLaunchpad(none.deps, LAUNCHPAD_ID)).toEqual({
      state: 'nothing-deployed',
    });
  });

  it('does not promote the maintenance page when the team re-enabled the launchpad meanwhile', async () => {
    const h = await setup();
    h.vercel.onCall = (op) => {
      if (op === 'waitForDeployment') h.store.setStatus(LAUNCHPAD_ID, 'live');
    };
    const before = h.vercel.projectBySlug('moonpad')!.productionDeploymentId;
    expect(await cutDisabledLaunchpad(h.deps, LAUNCHPAD_ID)).toEqual({ state: 'not-disabled' });
    expect(h.vercel.count('promoteToProduction')).toBe(1); // the setup release only
    expect(h.vercel.projectBySlug('moonpad')!.productionDeploymentId).toBe(before);
  });

  it('pages through every disabled launchpad, one failure does not stop the others', async () => {
    const h = await setup();
    await h.addSite(SECOND, 'secondpad');
    h.deps.pageSize = 1;
    // The first one cannot even be paused.
    h.vercel.nextState = 'ERROR';
    h.vercel.fail('pauseProject');
    const result = await enforceDisabledLaunchpads(h.deps);
    expect(result.failed).toEqual([{ slug: 'moonpad', error: expect.stringMatching(/pause/) }]);
    expect(result.cut).toEqual([
      { slug: 'secondpad', how: 'paused', reason: expect.stringMatching(/ERROR/) },
    ]);
    expect(h.alerts).toContainEqual({ level: 'high', code: 'site_cut_failed:moonpad' });
    expect(h.store.count('listDisabled')).toBe(3);
  });

  it('runs at startup and on the scheduler, even with sleep mode off', async () => {
    const h = await setup();
    const scheduler = startSleepScheduler(
      {
        store: h.store,
        github: h.github,
        vercel: h.vercel,
        projectEnv: TEST_PROJECT_ENV,
        rpcRelayTokenSecret: TEST_RELAY_SECRET,
        logger: silentLogger(),
      },
      {
        sleepEnabled: false,
        initialDelayMs: 60_000,
        intervalMs: 60_000,
        enforceDisabled: (signal) => enforceDisabledLaunchpads(h.deps, signal),
      },
    );
    for (let i = 0; i < 200 && mainMode(h.github) !== 'disabled'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await scheduler.stop();
    expect(mainMode(h.github)).toBe('disabled');
    expect(h.store.count('listDisabled')).toBeGreaterThan(0);
    expect(h.store.count('listDormant')).toBe(0);
  });

  it('runs the sweep before every sleep cycle and in between', async () => {
    const h = await setup();
    let sweeps = 0;
    const scheduler = startSleepScheduler(
      {
        store: h.store,
        github: h.github,
        vercel: h.vercel,
        projectEnv: TEST_PROJECT_ENV,
        rpcRelayTokenSecret: TEST_RELAY_SECRET,
        logger: silentLogger(),
      },
      {
        initialDelayMs: 30,
        intervalMs: 60_000,
        disableIntervalMs: 5,
        enforceDisabled: async () => {
          sweeps += 1;
        },
      },
    );
    for (let i = 0; i < 300 && (sweeps < 4 || h.store.count('listDormant') === 0); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await scheduler.stop();
    expect(sweeps).toBeGreaterThanOrEqual(4);
    expect(h.store.count('listDormant')).toBe(1);
  });
});
