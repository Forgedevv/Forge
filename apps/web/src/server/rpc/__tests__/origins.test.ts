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
import { createSupabaseSnapshotLoader, previewOriginOf } from '../supabase-directory';

const POLICY: OriginPolicy = {
  appOrigin: 'https://forge.example',
  clientsDomain: 'forge-sites.app',
  allowLocalhost: false,
};
const PREVIEW = 'https://forge-moonpad-abc123def-forge-team.vercel.app';

function staticDirectory(slugs: string[], previews: [string, string][] = []): LaunchpadDirectory {
  const snapshot: DirectorySnapshot = {
    activeSlugs: new Set(slugs),
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

  it('allows the exact origin of a preview waiting for approval', async () => {
    await expect(decideOrigin(PREVIEW, POLICY, dir)).resolves.toMatchObject({
      allowed: true,
      kind: 'preview',
      slug: 'moonpad',
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
        { id: 'l1', slug: 'moonpad' },
        { id: 'l2', slug: 'sun-pad' },
        { id: 'l3', slug: 'BAD SLUG' },
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
    expect(calls[0]?.filters).toContainEqual(['in', 'status', ['draft', 'live']]);
    expect(calls[1]?.filters).toContainEqual(['eq', 'status', 'preview_ready']);
  });

  it('pages through launchpads', async () => {
    const launchpads = Array.from({ length: 2500 }, (_, i) => ({
      id: `id-${i}`,
      slug: `pad-${i}`,
    }));
    const { db, calls } = fakeDb({ launchpads, jobs: [] });
    const loaded = await createSupabaseSnapshotLoader(db)();
    expect(loaded.activeSlugs.size).toBe(2500);
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
