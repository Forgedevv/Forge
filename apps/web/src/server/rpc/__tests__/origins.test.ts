// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  CachedLaunchpadDirectory,
  canonicalOrigin,
  decideOrigin,
  DirectoryUnavailableError,
  type DirectorySnapshot,
  type LaunchpadDirectory,
  type OriginPolicy,
} from '../origins';
import { createSupabaseSnapshotLoader, previewOriginOf, siteOriginOf } from '../supabase-directory';

const POLICY: OriginPolicy = {
  appOrigin: 'https://forge.example',
  clientsDomain: 'forge-sites.app',
  allowLocalhost: false,
};
const PREVIEW = 'https://forge-moonpad-abc123def-forge-team.vercel.app';

function staticDirectory(
  slugs: string[],
  previews: [string, string][] = [],
  sleeping: string[] = [],
  sites: [string, string][] = [],
): LaunchpadDirectory {
  const snapshot: DirectorySnapshot = {
    activeSlugs: new Set(slugs),
    sleepingSlugs: new Set(sleeping),
    siteOrigins: new Map(sites),
    previewOrigins: new Map(previews),
    loadedAt: 0,
  };
  return { snapshot: () => Promise.resolve(snapshot) };
}

const failingDirectory: LaunchpadDirectory = {
  snapshot: () => Promise.reject(new DirectoryUnavailableError()),
};

describe('decideOrigin', () => {
  const dir = staticDirectory(['moonpad', 'sun-pad'], [[PREVIEW, 'moonpad']]);

  it('allows the FORGE site without touching the directory', async () => {
    const spy = vi.fn(() => Promise.reject(new Error('not needed')));
    await expect(decideOrigin('https://forge.example', POLICY, { snapshot: spy })).resolves.toEqual(
      {
        allowed: true,
        kind: 'forge',
        origin: 'https://forge.example',
      },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows active client sites only', async () => {
    await expect(
      decideOrigin('https://moonpad.forge-sites.app', POLICY, dir),
    ).resolves.toMatchObject({
      allowed: true,
      kind: 'client',
      slug: 'moonpad',
    });
    await expect(
      decideOrigin('https://sun-pad.forge-sites.app', POLICY, dir),
    ).resolves.toMatchObject({
      allowed: true,
      slug: 'sun-pad',
    });
    await expect(decideOrigin('https://ghost.forge-sites.app', POLICY, dir)).resolves.toEqual({
      allowed: false,
      reason: 'unknown',
    });
  });

  it.each([
    'http://moonpad.forge-sites.app',
    'https://moonpad.forge-sites.app:8443',
    'https://a.moonpad.forge-sites.app',
    'https://moonpad.forge-sites.app.evil.com',
    'https://moonpadforge-sites.app',
    'https://evil-forge-sites.app',
    'https://forge-sites.app',
    'https://moonpad.forge-sites.app/',
    'https://MOONPAD.forge-sites.app',
    'https://forge.example.evil.com',
    'http://forge.example',
    'https://evil.vercel.app',
    'https://forge-moonpad-abc123def-forge-team.vercel.app.evil.com',
    'null',
    'file://',
    'chrome-extension://abcdef',
    '',
  ])('refuses %s', async (origin) => {
    const decision = await decideOrigin(origin, POLICY, dir);
    expect(decision.allowed).toBe(false);
  });

  it('allows sleeping client sites as their own kind (creator fee claim only, D29)', async () => {
    const withSleeping = staticDirectory(['moonpad'], [], ['sleepy-pad']);
    await expect(
      decideOrigin('https://sleepy-pad.forge-sites.app', POLICY, withSleeping),
    ).resolves.toEqual({
      allowed: true,
      kind: 'sleeping',
      origin: 'https://sleepy-pad.forge-sites.app',
      slug: 'sleepy-pad',
    });
    await expect(
      decideOrigin('https://moonpad.forge-sites.app', POLICY, withSleeping),
    ).resolves.toMatchObject({ allowed: true, kind: 'client' });
    // Without the directory saying so, a sleeping slug is unknown (disabled sites stay cut off).
    await expect(decideOrigin('https://sleepy-pad.forge-sites.app', POLICY, dir)).resolves.toEqual({
      allowed: false,
      reason: 'unknown',
    });
    // The same strict origin rules apply to sleeping sites.
    for (const origin of [
      'http://sleepy-pad.forge-sites.app',
      'https://sleepy-pad.forge-sites.app:8443',
      'https://x.sleepy-pad.forge-sites.app',
    ]) {
      await expect(decideOrigin(origin, POLICY, withSleeping)).resolves.toMatchObject({
        allowed: false,
      });
    }
  });

  it('allows the exact origin of a preview waiting for approval', async () => {
    await expect(decideOrigin(PREVIEW, POLICY, dir)).resolves.toMatchObject({
      allowed: true,
      kind: 'preview',
      slug: 'moonpad',
    });
  });

  describe('client sites at their recorded host (launchpads.site_host)', () => {
    const SITE = 'https://lp-moonpad.vercel.app';
    const SLEEPY_SITE = 'https://lp-sleepy-pad-forge.vercel.app';
    const sites = staticDirectory(
      ['moonpad', 'sun-pad'],
      [[PREVIEW, 'moonpad']],
      ['sleepy-pad'],
      [
        [SITE, 'moonpad'],
        [SLEEPY_SITE, 'sleepy-pad'],
        // Recorded for a launchpad that is no longer listed (disabled since).
        ['https://lp-cut-pad.vercel.app', 'cut-pad'],
      ],
    );

    it('allows the exact recorded host with the status rules of its launchpad', async () => {
      await expect(decideOrigin(SITE, POLICY, sites)).resolves.toEqual({
        allowed: true,
        kind: 'client',
        origin: SITE,
        slug: 'moonpad',
      });
      // Sleeping: the creator fee claim only (the handler narrows the methods of this kind).
      await expect(decideOrigin(SLEEPY_SITE, POLICY, sites)).resolves.toEqual({
        allowed: true,
        kind: 'sleeping',
        origin: SLEEPY_SITE,
        slug: 'sleepy-pad',
      });
      // Disabled (neither active nor sleeping): cut off, whatever host it had.
      await expect(decideOrigin('https://lp-cut-pad.vercel.app', POLICY, sites)).resolves.toEqual({
        allowed: false,
        reason: 'unknown',
      });
    });

    it('speaks for its own launchpad only', async () => {
      // The host recorded for moonpad never yields another launchpad, and sun-pad (no recorded
      // host) gets nothing from a vercel.app name that looks like its own.
      await expect(decideOrigin(SITE, POLICY, sites)).resolves.toMatchObject({ slug: 'moonpad' });
      await expect(decideOrigin('https://lp-sun-pad.vercel.app', POLICY, sites)).resolves.toEqual({
        allowed: false,
        reason: 'unknown',
      });
    });

    it.each([
      'https://lp-moonpad-evil.vercel.app',
      'https://lp-moonpad-forge.vercel.app',
      'https://evil-lp-moonpad.vercel.app',
      'https://x.lp-moonpad.vercel.app',
      'https://lp-moonpad.vercel.app.evil.com',
      'https://lp-moonpad.vercel.app:8443',
      'https://lp-moonpad.vercel.app:443',
      'https://lp-moonpad.vercel.app/',
      'https://LP-moonpad.vercel.app',
      'http://lp-moonpad.vercel.app',
      'https://lp-moonpad.vercel.app.',
    ])('refuses the look-alike or non-canonical %s', async (origin) => {
      await expect(decideOrigin(origin, POLICY, sites)).resolves.toMatchObject({
        allowed: false,
      });
    });

    it('works without CLIENTS_DOMAIN (devnet beta) and fails closed without a directory', async () => {
      const policy = { ...POLICY, clientsDomain: null };
      await expect(decideOrigin(SITE, policy, sites)).resolves.toMatchObject({
        allowed: true,
        kind: 'client',
        slug: 'moonpad',
      });
      await expect(decideOrigin(SITE, POLICY, failingDirectory)).resolves.toEqual({
        allowed: false,
        reason: 'directory_unavailable',
      });
      await expect(decideOrigin(SITE, POLICY, null)).resolves.toEqual({
        allowed: false,
        reason: 'directory_unavailable',
      });
      await expect(decideOrigin('null', POLICY, sites)).resolves.toEqual({
        allowed: false,
        reason: 'malformed',
      });
    });

    it('leaves the subdomain and preview rules as they were', async () => {
      await expect(
        decideOrigin('https://moonpad.forge-sites.app', POLICY, sites),
      ).resolves.toMatchObject({ allowed: true, kind: 'client', slug: 'moonpad' });
      await expect(decideOrigin(PREVIEW, POLICY, sites)).resolves.toMatchObject({
        allowed: true,
        kind: 'preview',
        slug: 'moonpad',
      });
      // A recorded host never overrides a subdomain decision: the subdomain's own slug decides.
      const crossed = staticDirectory(
        ['moonpad'],
        [],
        [],
        [['https://ghost.forge-sites.app', 'moonpad']],
      );
      await expect(decideOrigin('https://ghost.forge-sites.app', POLICY, crossed)).resolves.toEqual(
        { allowed: false, reason: 'unknown' },
      );
    });
  });

  it('allows localhost only outside production', async () => {
    const dev = { ...POLICY, allowLocalhost: true };
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3001', 'http://[::1]:3000']) {
      await expect(decideOrigin(origin, dev, dir)).resolves.toMatchObject({
        allowed: true,
        kind: 'local',
      });
      await expect(decideOrigin(origin, POLICY, dir)).resolves.toMatchObject({ allowed: false });
    }
    await expect(decideOrigin('https://localhost:3000', dev, dir)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('fails closed when the directory is unavailable or not configured', async () => {
    await expect(
      decideOrigin('https://moonpad.forge-sites.app', POLICY, failingDirectory),
    ).resolves.toEqual({ allowed: false, reason: 'directory_unavailable' });
    await expect(decideOrigin('https://moonpad.forge-sites.app', POLICY, null)).resolves.toEqual({
      allowed: false,
      reason: 'directory_unavailable',
    });
    // The FORGE site keeps working.
    await expect(
      decideOrigin('https://forge.example', POLICY, failingDirectory),
    ).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('refuses client sites when CLIENTS_DOMAIN is not set', async () => {
    const policy = { ...POLICY, clientsDomain: null };
    await expect(
      decideOrigin('https://moonpad.forge-sites.app', policy, dir),
    ).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('canonicalOrigin only accepts scheme://host[:port]', () => {
    expect(canonicalOrigin('https://a.b')?.origin).toBe('https://a.b');
    expect(canonicalOrigin('https://a.b/')).toBeNull();
    expect(canonicalOrigin('https://a.b/path')).toBeNull();
    expect(canonicalOrigin('https://user@a.b')).toBeNull();
    expect(canonicalOrigin(`https://${'a'.repeat(300)}.b`)).toBeNull();
  });
});

describe('CachedLaunchpadDirectory', () => {
  const snapshot = (slugs: string[]) => ({
    activeSlugs: new Set(slugs),
    sleepingSlugs: new Set<string>(),
    siteOrigins: new Map<string, string>(),
    previewOrigins: new Map(),
  });

  it('caches for the TTL and refreshes once (single flight)', async () => {
    let t = 0;
    const loader = vi.fn(async () => snapshot(['a1a']));
    const dir = new CachedLaunchpadDirectory(loader, { ttlMs: 1000, now: () => t });
    await Promise.all([dir.snapshot(), dir.snapshot(), dir.snapshot()]);
    expect(loader).toHaveBeenCalledTimes(1);
    t = 999;
    await dir.snapshot();
    expect(loader).toHaveBeenCalledTimes(1);
    t = 1000;
    await dir.snapshot();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('serves a stale snapshot while refreshing and when the refresh fails', async () => {
    let t = 0;
    let fail = false;
    const onError = vi.fn();
    const loader = vi.fn(async () => {
      if (fail) throw new Error('db down');
      return snapshot([`s-${t}`]);
    });
    const dir = new CachedLaunchpadDirectory(loader, {
      ttlMs: 1000,
      maxStaleMs: 10_000,
      failureBackoffMs: 500,
      now: () => t,
      onError,
    });
    await dir.snapshot();
    fail = true;
    t = 2000;
    const stale = await dir.snapshot();
    expect([...stale.activeSlugs]).toEqual(['s-0']);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    // Inside the failure backoff: no new load attempt.
    t = 2100;
    await dir.snapshot();
    expect(loader).toHaveBeenCalledTimes(2);
    // Too old: fail closed.
    t = 20_000;
    await expect(dir.snapshot()).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });

  it('throws when nothing was ever loaded', async () => {
    const dir = new CachedLaunchpadDirectory(() => Promise.reject(new Error('no db')), {
      now: () => 0,
    });
    await expect(dir.snapshot()).rejects.toBeInstanceOf(DirectoryUnavailableError);
    // Backoff: the second call does not hit the loader again.
    await expect(dir.snapshot()).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });
});

describe('Supabase snapshot loader', () => {
  type Rows = Record<string, unknown>[];

  /** Minimal PostgREST query builder fake recording the filters it receives. */
  function fakeDb(tables: { launchpads: Rows; jobs: Rows }, failOn?: 'launchpads' | 'jobs') {
    const calls: { table: string; filters: unknown[][] }[] = [];
    const db = {
      from(table: 'launchpads' | 'jobs') {
        const filters: unknown[][] = [];
        calls.push({ table, filters });
        let range: [number, number] | null = null;
        const builder = {
          select: (...a: unknown[]) => (filters.push(['select', ...a]), builder),
          in: (...a: unknown[]) => (filters.push(['in', ...a]), builder),
          eq: (...a: unknown[]) => (filters.push(['eq', ...a]), builder),
          not: (...a: unknown[]) => (filters.push(['not', ...a]), builder),
          order: (...a: unknown[]) => (filters.push(['order', ...a]), builder),
          limit: (...a: unknown[]) => (filters.push(['limit', ...a]), builder),
          range: (from: number, to: number) => ((range = [from, to]), builder),
          then(resolve: (v: { data: Rows | null; error: unknown }) => void) {
            if (failOn === table) return resolve({ data: null, error: { message: 'boom' } });
            const rows = tables[table];
            resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null });
          },
        };
        return builder;
      },
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  it('loads active slugs and preview origins of active launchpads', async () => {
    const { db, calls } = fakeDb({
      launchpads: [
        { id: 'l1', slug: 'moonpad', status: 'live' },
        { id: 'l2', slug: 'sun-pad', status: 'draft' },
        { id: 'l3', slug: 'BAD SLUG', status: 'live' },
      ],
      jobs: [
        { launchpad_id: 'l1', preview_url: `${PREVIEW}/some/path` },
        { launchpad_id: 'l9', preview_url: 'https://orphan.vercel.app' },
        { launchpad_id: 'l2', preview_url: 'http://insecure.vercel.app' },
        { launchpad_id: 'l2', preview_url: 'not a url' },
      ],
    });
    const loaded = await createSupabaseSnapshotLoader(db)();
    expect([...loaded.activeSlugs].sort()).toEqual(['moonpad', 'sun-pad']);
    expect([...loaded.previewOrigins]).toEqual([[PREVIEW, 'moonpad']]);
    expect([...loaded.sleepingSlugs]).toEqual([]);
    expect(calls[0]?.filters).toContainEqual(['in', 'status', ['draft', 'live', 'sleeping']]);
    expect(calls[1]?.filters).toContainEqual(['eq', 'status', 'preview_ready']);
  });

  it('loads sleeping launchpads apart, without their previews', async () => {
    const { db } = fakeDb({
      launchpads: [
        { id: 'l1', slug: 'moonpad', status: 'live' },
        { id: 'l2', slug: 'sleepy-pad', status: 'sleeping' },
        { id: 'l3', slug: 'cut-pad', status: 'disabled' },
        { id: 'l4', slug: 'odd-pad', status: null },
        { id: 'l5', slug: 'BAD SLUG', status: 'sleeping' },
      ],
      jobs: [{ launchpad_id: 'l2', preview_url: `${PREVIEW}/x` }],
    });
    const loaded = await createSupabaseSnapshotLoader(db)();
    expect([...loaded.activeSlugs]).toEqual(['moonpad']);
    expect([...loaded.sleepingSlugs]).toEqual(['sleepy-pad']);
    // A sleeping launchpad's preview is not served (only its live site, for the claim).
    expect([...loaded.previewOrigins]).toEqual([]);
  });

  it('loads the recorded site hosts of active and sleeping launchpads only', async () => {
    const { db, calls } = fakeDb({
      launchpads: [
        { id: 'l1', slug: 'moonpad', status: 'live', site_host: 'lp-moonpad.vercel.app' },
        { id: 'l2', slug: 'sun-pad', status: 'draft', site_host: 'sun-pad.forge-sites.app' },
        { id: 'l3', slug: 'sleepy-pad', status: 'sleeping', site_host: 'lp-sleepy-pad.vercel.app' },
        { id: 'l4', slug: 'cut-pad', status: 'disabled', site_host: 'lp-cut-pad.vercel.app' },
        { id: 'l5', slug: 'no-host', status: 'live', site_host: null },
        { id: 'l6', slug: 'bad-one', status: 'live', site_host: 'https://lp-bad-one.vercel.app' },
        { id: 'l7', slug: 'bad-two', status: 'live', site_host: 'a.b.vercel.app' },
        { id: 'l8', slug: 'bad-three', status: 'live', site_host: 'LP-BAD.vercel.app' },
        { id: 'l9', slug: 'bad-four', status: 'live', site_host: 42 },
        { id: 'la', slug: 'BAD SLUG', status: 'live', site_host: 'lp-bad-slug.vercel.app' },
      ],
      jobs: [],
    });
    const loaded = await createSupabaseSnapshotLoader(db, { clientsDomain: 'forge-sites.app' })();
    expect(Object.fromEntries(loaded.siteOrigins)).toEqual({
      'https://lp-moonpad.vercel.app': 'moonpad',
      'https://sun-pad.forge-sites.app': 'sun-pad',
      'https://lp-sleepy-pad.vercel.app': 'sleepy-pad',
    });
    expect(calls[0]?.filters).toContainEqual(['select', 'id, slug, status, site_host']);
  });

  // Before: any well-formed host was trusted, so a wrong row made a foreign site a client site.
  it('ignores a recorded host the launchpad cannot have, however well formed', async () => {
    const { db } = fakeDb({
      launchpads: [
        { id: 'l1', slug: 'evil-pad', status: 'live', site_host: 'evil.example' },
        { id: 'l2', slug: 'thief-pad', status: 'live', site_host: 'moonpad.forge-sites.app' },
        { id: 'l3', slug: 'deep-pad', status: 'live', site_host: 'www.deep-pad.forge-sites.app' },
        { id: 'l4', slug: 'sun-pad', status: 'sleeping', site_host: 'sun-pad.forge-sites.app' },
        { id: 'l5', slug: 'star-pad', status: 'live', site_host: 'lp-star-pad.vercel.app' },
      ],
      jobs: [],
    });
    const withDomain = await createSupabaseSnapshotLoader(db, {
      clientsDomain: 'forge-sites.app',
    })();
    expect(Object.fromEntries(withDomain.siteOrigins)).toEqual({
      'https://sun-pad.forge-sites.app': 'sun-pad',
      'https://lp-star-pad.vercel.app': 'star-pad',
    });
    // Without CLIENTS_DOMAIN, only the vercel.app aliases are trusted.
    const withoutDomain = await createSupabaseSnapshotLoader(db)();
    expect([...withoutDomain.siteOrigins]).toEqual([
      ['https://lp-star-pad.vercel.app', 'star-pad'],
    ]);
  });

  it('drops a site host listed for two launchpads', async () => {
    const { db } = fakeDb({
      launchpads: [
        { id: 'l1', slug: 'moonpad', status: 'live', site_host: 'lp-shared.vercel.app' },
        { id: 'l2', slug: 'sun-pad', status: 'sleeping', site_host: 'lp-shared.vercel.app' },
        { id: 'l3', slug: 'star-pad', status: 'live', site_host: 'lp-star-pad.vercel.app' },
      ],
      jobs: [],
    });
    const loaded = await createSupabaseSnapshotLoader(db)();
    expect([...loaded.siteOrigins]).toEqual([['https://lp-star-pad.vercel.app', 'star-pad']]);
  });

  it('siteOriginOf keeps site-host shaped values only', () => {
    expect(siteOriginOf('lp-moonpad.vercel.app', 'moonpad', null)).toBe(
      'https://lp-moonpad.vercel.app',
    );
    expect(siteOriginOf('moonpad.sites.example', 'moonpad', 'sites.example')).toBe(
      'https://moonpad.sites.example',
    );
    expect(siteOriginOf('lp-moonpad.vercel.app:443', 'moonpad', null)).toBeNull();
    expect(siteOriginOf('', 'moonpad', null)).toBeNull();
    expect(siteOriginOf(undefined, 'moonpad', null)).toBeNull();
    expect(siteOriginOf('other.sites.example', 'moonpad', 'sites.example')).toBeNull();
  });

  it('pages through launchpads', async () => {
    const launchpads = Array.from({ length: 2500 }, (_, i) => ({
      id: `id-${i}`,
      slug: `pad-${i}`,
      status: i % 2 === 0 ? 'live' : 'sleeping',
    }));
    const { db, calls } = fakeDb({ launchpads, jobs: [] });
    const loaded = await createSupabaseSnapshotLoader(db)();
    expect(loaded.activeSlugs.size).toBe(1250);
    expect(loaded.sleepingSlugs.size).toBe(1250);
    expect(calls.filter((c) => c.table === 'launchpads')).toHaveLength(3);
  });

  it('throws a generic error on a database error (no Supabase text)', async () => {
    const { db } = fakeDb({ launchpads: [], jobs: [] }, 'jobs');
    await expect(createSupabaseSnapshotLoader(db)()).rejects.toThrow(
      'launchpad directory: jobs select failed',
    );
  });

  it('previewOriginOf keeps https origins only', () => {
    expect(previewOriginOf('https://x.vercel.app/a?b=1')).toBe('https://x.vercel.app');
    expect(previewOriginOf('http://x.vercel.app')).toBeNull();
    expect(previewOriginOf(null)).toBeNull();
    expect(previewOriginOf('::')).toBeNull();
  });
});
