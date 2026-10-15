// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_CONTROL_NOT_FOUND,
  CACHE_CONTROL_OK,
  createCoinMetaHandler,
  MEMORY_TTL_MS,
  type CoinMetaSource,
} from './handler';
import { APPROVED_JOB_STATUSES, COIN_META_PATH, type CoinMetaRecord } from './metadata';
import { createSupabaseCoinMetaSource } from './supabase-source';

const SPEC = {
  version: 1,
  ownerWallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  name: 'MoonPad',
  slug: 'moonpad',
  quote: 'SOL',
  tradingFeeBps: 100,
  coinCreatorSharePct: 25,
  poolCreationFeeSol: 0,
  antiSniper: true,
  theme: {
    primaryColor: '#7C3AED',
    accentColor: '#F59E0B',
    darkMode: true,
    tagline: 'To the moon',
    logoUrl: 'https://cdn.example/logo.png',
    designNotes: 'internal notes for the builder',
  },
  launchpadCoin: {
    name: 'Moon Coin',
    symbol: 'MOON',
    description: 'The coin of MoonPad.',
    imageUrl: 'https://pub-123.r2.dev/moon.png',
    firstBuySol: 1,
  },
};

function record(over: Partial<CoinMetaRecord> = {}): CoinMetaRecord {
  return {
    slug: 'moonpad',
    status: 'draft',
    spec: SPEC,
    createJob: { status: 'approved', failedStage: null },
    siteHost: null,
    ...over,
  };
}

function setup(
  rows: Record<string, CoinMetaRecord> = { moonpad: record() },
  domain = 'forge-sites.app',
) {
  let t = 1_000_000;
  const calls: string[] = [];
  const errors: string[] = [];
  const source: CoinMetaSource & { failure: Error | null } = {
    failure: null,
    async find(slug) {
      calls.push(slug);
      if (this.failure) throw this.failure;
      return rows[slug] ?? null;
    },
  };
  const handler = createCoinMetaHandler({
    source: () => source,
    clientsDomain: () => domain || null,
    now: () => t,
    onError: (event) => errors.push(event),
  });
  return {
    handler,
    calls,
    errors,
    source,
    rows,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('GET /api/coin-meta/:slug', () => {
  it('serves exactly the Metaplex fields of an approved launchpad coin', async () => {
    const { handler } = setup();
    const res = await handler('moonpad');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROL_OK);
    expect(CACHE_CONTROL_OK).toBe('public, max-age=300, s-maxage=86400');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      name: 'Moon Coin',
      symbol: 'MOON',
      description: 'The coin of MoonPad.',
      image: 'https://pub-123.r2.dev/moon.png',
      external_url: 'https://moonpad.forge-sites.app',
    });
  });

  it('serves the coin from approval on, including a failure after approval', async () => {
    for (const status of APPROVED_JOB_STATUSES) {
      const { handler } = setup({ moonpad: record({ createJob: { status, failedStage: null } }) });
      expect((await handler('moonpad')).status, status).toBe(200);
    }
    for (const failedStage of ['onchain', 'deploy'] as const) {
      const { handler } = setup({
        moonpad: record({ createJob: { status: 'failed', failedStage } }),
      });
      expect((await handler('moonpad')).status, failedStage).toBe(200);
    }
    for (const status of ['live', 'sleeping'] as const) {
      const { handler } = setup({ moonpad: record({ status, createJob: null }) });
      expect((await handler('moonpad')).status, status).toBe(200);
    }
  });

  it('answers 404 for unknown, not yet approved and disabled launchpads', async () => {
    const cases: [string, CoinMetaRecord | null][] = [
      ['unknown', null],
      ['no job', record({ createJob: null })],
      ...(['spec_ready', 'paid', 'building', 'preview_ready', 'refunded'] as const).map(
        (status): [string, CoinMetaRecord] => [
          status,
          record({ createJob: { status, failedStage: null } }),
        ],
      ),
      ['failed build', record({ createJob: { status: 'failed', failedStage: 'build' } })],
      [
        'disabled',
        record({ status: 'disabled', createJob: { status: 'live', failedStage: null } }),
      ],
    ];
    for (const [label, row] of cases) {
      const { handler } = setup(row ? { moonpad: row } : {});
      const res = await handler('moonpad');
      expect(res.status, label).toBe(404);
      expect(res.headers.get('cache-control'), label).toBe(CACHE_CONTROL_NOT_FOUND);
      expect(await res.json(), label).toEqual({
        code: 'NOT_FOUND',
        message: 'Coin metadata not found.',
      });
    }
  });

  it('refuses malformed slugs before any read', async () => {
    const { handler, calls } = setup();
    for (const slug of [
      'MoonPad',
      'mo',
      'a'.repeat(33),
      'moon--pad',
      '-moonpad',
      'moon pad',
      '../moonpad',
      'moonpad.json',
      `released-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    ]) {
      expect((await handler(slug)).status, slug).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('only exposes https images, falling back to the https logo', async () => {
    const withCoin = (imageUrl: string, logoUrl?: string) =>
      record({
        spec: {
          ...SPEC,
          theme: { ...SPEC.theme, logoUrl },
          launchpadCoin: { ...SPEC.launchpadCoin, imageUrl },
        },
      });
    const read = async (row: CoinMetaRecord) =>
      (await (await setup({ moonpad: row }).handler('moonpad')).json()) as Record<string, unknown>;
    expect(
      (await read(withCoin('http://cdn.example/a.png', 'https://cdn.example/logo.png'))).image,
    ).toBe('https://cdn.example/logo.png');
    expect(
      await read(withCoin('javascript:alert(1)', 'http://cdn.example/logo.png')),
    ).not.toHaveProperty('image');
  });

  it('omits external_url without CLIENTS_DOMAIN and never leaks spec internals', async () => {
    const { handler } = setup({ moonpad: record() }, '');
    const body = (await (await handler('moonpad')).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['description', 'image', 'name', 'symbol']);
    expect(JSON.stringify(body)).not.toMatch(/ownerWallet|designNotes|firstBuy|9xQe/);
  });

  it('links external_url to the recorded site host first, with or without CLIENTS_DOMAIN', async () => {
    const site = record({ siteHost: 'lp-moonpad.vercel.app' });
    for (const domain of ['forge-sites.app', '']) {
      const { handler } = setup({ moonpad: site }, domain);
      const body = (await (await handler('moonpad')).json()) as Record<string, unknown>;
      expect(body.external_url).toBe('https://lp-moonpad.vercel.app');
    }
    // A malformed stored host is never linked: back to the subdomain.
    const { handler } = setup({ moonpad: record({ siteHost: 'https://evil.example' }) });
    const body = (await (await handler('moonpad')).json()) as Record<string, unknown>;
    expect(body.external_url).toBe('https://moonpad.forge-sites.app');
  });

  // Before: any well-formed host was linked, even one of another domain or launchpad.
  it('never links a recorded host the launchpad cannot have', async () => {
    for (const siteHost of ['evil.example', 'other-pad.forge-sites.app']) {
      const { handler } = setup({ moonpad: record({ siteHost }) });
      const body = (await (await handler('moonpad')).json()) as Record<string, unknown>;
      expect(body.external_url, siteHost).toBe('https://moonpad.forge-sites.app');
    }
    const { handler } = setup({ moonpad: record({ siteHost: 'moonpad.forge-sites.app' }) });
    const body = (await (await handler('moonpad')).json()) as Record<string, unknown>;
    expect(body.external_url).toBe('https://moonpad.forge-sites.app');
  });

  it('answers 404 (and reports it) for an approved launchpad whose spec has no usable coin', async () => {
    const { handler, errors } = setup({
      moonpad: record({ spec: { launchpadCoin: { name: '' } } }),
    });
    expect((await handler('moonpad')).status).toBe(404);
    expect(errors).toEqual(['unusable_spec']);
  });

  it('caches answers in memory for a short TTL', async () => {
    const { handler, calls, advance, rows } = setup();
    await handler('moonpad');
    await handler('moonpad');
    await handler('sunpad');
    await handler('sunpad');
    expect(calls).toEqual(['moonpad', 'sunpad']);
    rows.sunpad = record({ slug: 'sunpad' });
    advance(MEMORY_TTL_MS);
    expect((await handler('sunpad')).status).toBe(200);
    expect(calls).toEqual(['moonpad', 'sunpad', 'sunpad']);
  });

  it('answers 503 without detail when the database cannot be read, and caches nothing', async () => {
    const { handler, source, errors, calls } = setup();
    source.failure = new Error('connection to db.secret-host failed');
    const res = await handler('moonpad');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toContain('secret-host');
    expect(errors).toEqual(['read_failed']);
    source.failure = null;
    expect((await handler('moonpad')).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('keeps the metadata URI of a 32-byte slug within the launch transaction budget', () => {
    // SIGNER_COIN_METADATA_URL=https://<site host>/api/coin-meta/{slug}
    const uri = `https://forge.example${COIN_META_PATH}${'a'.repeat(32)}`;
    expect(COIN_META_PATH).toBe('/api/coin-meta/');
    expect(Buffer.byteLength(uri)).toBeLessThanOrEqual(106);
  });
});

describe('createSupabaseCoinMetaSource', () => {
  function fakeDb(results: { data?: unknown; error?: { code?: string; message?: string } }[]) {
    const calls: { table: string; ops: [string, unknown[]][] }[] = [];
    let next = 0;
    const db = {
      from(table: string) {
        const entry = { table, ops: [] as [string, unknown[]][] };
        calls.push(entry);
        const result = results[next++] ?? {};
        const builder: unknown = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'then') {
                return (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(
                    resolve,
                  );
              }
              return (...args: unknown[]) => {
                entry.ops.push([String(prop), args]);
                return builder;
              };
            },
          },
        );
        return builder;
      },
    };
    return { source: createSupabaseCoinMetaSource(db as unknown as SupabaseClient), calls };
  }

  it('reads the launchpad by slug and its creation job, selecting only what it needs', async () => {
    const { source, calls } = fakeDb([
      { data: { id: 'lp1', slug: 'moonpad', status: 'draft', spec: SPEC } },
      { data: [{ status: 'onchain_setup', failed_stage: null }] },
    ]);
    await expect(source.find('moonpad')).resolves.toEqual({
      slug: 'moonpad',
      status: 'draft',
      spec: SPEC,
      createJob: { status: 'onchain_setup', failedStage: null },
      siteHost: null,
    });
    expect(calls[0]).toEqual({
      table: 'launchpads',
      ops: [
        ['select', ['id, slug, status, spec, site_host']],
        ['eq', ['slug', 'moonpad']],
        ['maybeSingle', []],
      ],
    });
    // The newest creation job: a launchpad started again keeps its refunded attempts too.
    expect(calls[1]!.ops).toEqual([
      ['select', ['status, failed_stage']],
      ['eq', ['launchpad_id', 'lp1']],
      ['eq', ['type', 'create_launchpad']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ]);
  });

  it('reads the recorded site host, shape checked', async () => {
    const row = { id: 'lp1', slug: 'moonpad', status: 'live', spec: SPEC };
    const read = (siteHost: unknown) =>
      fakeDb([{ data: { ...row, site_host: siteHost } }, { data: [] }]).source.find('moonpad');
    await expect(read('lp-moonpad.vercel.app')).resolves.toMatchObject({
      siteHost: 'lp-moonpad.vercel.app',
    });
    await expect(read('lp-moonpad.vercel.app/x')).resolves.toMatchObject({ siteHost: null });
    await expect(read(null)).resolves.toMatchObject({ siteHost: null });
  });

  it('returns null for an unknown slug and hides database messages', async () => {
    await expect(fakeDb([{ data: null }]).source.find('moonpad')).resolves.toBeNull();
    const error = await fakeDb([{ error: { code: '57014', message: 'secret detail' } }])
      .source.find('moonpad')
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ name: 'CoinMetaReadError', dbCode: '57014' });
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('app/api/coin-meta/[slug]/route', { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is public: 404 for a malformed slug, 503 without database configuration', async () => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { GET } = await import('../../../app/api/coin-meta/[slug]/route');
    const request = new Request('https://forge.example/api/coin-meta/x');
    const bad = await GET(request, { params: Promise.resolve({ slug: 'Bad Slug' }) });
    expect(bad.status).toBe(404);
    const unconfigured = await GET(request, { params: Promise.resolve({ slug: 'moonpad' }) });
    expect(unconfigured.status).toBe(503);
    expect(JSON.stringify(logged.mock.calls)).toContain('SUPABASE_URL is not set');
  });
});
