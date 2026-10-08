/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { empty, json, stubFetch, type Route } from './http-mock.js';
import {
  assertClientsDomain,
  createVercelClient,
  envTypeFor,
  pickProjectEnv,
  projectNameForSlug,
  subdomainFor,
  vercelOptionsFromEnv,
  type VercelClient,
} from './vercel.js';

const ORG = 'forge-org';
const DOMAIN = 'forge-sites.app';
const TOKEN = 'vcp_secrettoken0123456789';
const TEAM = 'team_abcdefgh12345678';

interface Harness {
  client: VercelClient;
  stub: ReturnType<typeof stubFetch>;
  sleeps: number[];
  clock: { now: number };
}

function make(routes: Route[], extra: Record<string, unknown> = {}): Harness {
  const stub = stubFetch(routes);
  const sleeps: number[] = [];
  const clock = { now: 1_800_000_000_000 };
  const client = createVercelClient({
    token: TOKEN,
    teamId: TEAM,
    githubOrg: ORG,
    clientsDomain: DOMAIN,
    fetch: stub.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    now: () => clock.now,
    random: () => 0,
    retryBaseMs: 10,
    ...extra,
  });
  return { client, stub, sleeps, clock };
}

const projectJson = (over: Record<string, unknown> = {}) => ({
  id: 'prj_123',
  name: 'lp-moonpad',
  link: { type: 'github', org: ORG, repo: 'lp-moonpad' },
  ...over,
});

const deploymentJson = (state: string, over: Record<string, unknown> = {}) => ({
  id: 'dpl_1',
  url: 'lp-moonpad-abc123-forge.vercel.app',
  readyState: state,
  target: null,
  ...over,
});

describe('names, domain and env selection', () => {
  it('derives project names and subdomains from validated slugs', () => {
    expect(projectNameForSlug('moonpad')).toBe('lp-moonpad');
    expect(subdomainFor('moonpad', DOMAIN)).toBe('moonpad.forge-sites.app');
    expect(() => subdomainFor('Bad_Slug', DOMAIN)).toThrow(/slug/);
    expect(() => subdomainFor('moonpad', 'not a domain')).toThrow(/domain/);
    expect(() => assertClientsDomain('localhost')).toThrow();
    expect(() => assertClientsDomain('evil.com/x')).toThrow();
  });

  it('classifies variables: public ones plain, secrets sensitive', () => {
    expect(envTypeFor('FORGE_MULTISIG_VAULT')).toBe('plain');
    expect(envTypeFor('SOLANA_CLUSTER')).toBe('plain');
    expect(envTypeFor('NEXT_PUBLIC_FORGE_RPC_RELAY_URL')).toBe('plain');
    expect(envTypeFor('JUPITER_API_KEY')).toBe('sensitive');
    expect(envTypeFor('R2_SECRET_ACCESS_KEY')).toBe('sensitive');
    expect(envTypeFor('RPC_URL')).toBe('sensitive');
    expect(envTypeFor('GITHUB_PACKAGES_TOKEN')).toBe('sensitive');
  });

  it('picks only allowlisted variables and reports missing required ones', () => {
    const { vars, missing } = pickProjectEnv({
      SOLANA_CLUSTER: 'devnet',
      RPC_URL: 'https://rpc.example',
      JUPITER_API_KEY: 'k',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      SIGNER_HMAC_SECRET: 'must-not-leak',
      GITHUB_APP_ID: '1',
      FORGE_MULTISIG_VAULT: 'abc',
      R2_BUCKET: '',
    });
    expect(Object.keys(vars).sort()).toEqual([
      'FORGE_MULTISIG_VAULT',
      'JUPITER_API_KEY',
      'RPC_URL',
      'SOLANA_CLUSTER',
    ]);
    expect(missing).toContain('R2_BUCKET');
    expect(missing).toContain('FORGE_PLATFORM_FEE_WALLET');
    expect(missing).not.toContain('RPC_URL');
  });
});

describe('vercelOptionsFromEnv', () => {
  it('reads token, team and org', () => {
    expect(
      vercelOptionsFromEnv({
        VERCEL_TOKEN: TOKEN,
        VERCEL_TEAM_ID: TEAM,
        GITHUB_ORG: ORG,
        CLIENTS_DOMAIN: DOMAIN,
      }),
    ).toEqual({ token: TOKEN, teamId: TEAM, githubOrg: ORG, clientsDomain: DOMAIN });
    expect(
      vercelOptionsFromEnv({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM: 'f-orge', GITHUB_ORG: ORG }),
    ).toMatchObject({
      teamSlug: 'f-orge',
    });
  });

  it('names the bad variables without echoing values', () => {
    let msg = '';
    try {
      vercelOptionsFromEnv({ VERCEL_TOKEN: 'short', GITHUB_ORG: ORG });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('VERCEL_TOKEN');
    expect(msg).not.toContain('short');
    expect(() =>
      vercelOptionsFromEnv({ VERCEL_TOKEN: TOKEN, GITHUB_ORG: ORG, CLIENTS_DOMAIN: 'x' }),
    ).toThrow(/domain/);
  });
});

describe('reads and scope', () => {
  it('sends the bearer token and the team scope on every call', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects',
        handler: () => json({ projects: [{ id: 'prj_1', name: 'lp-a' }] }),
      },
    ]);
    await expect(client.listProjects()).resolves.toEqual([{ id: 'prj_1', name: 'lp-a' }]);
    const call = stub.calls[0];
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.query.get('teamId')).toBe(TEAM);
    expect(call?.query.get('limit')).toBe('100');
  });

  it('falls back to the team slug', async () => {
    const { client, stub } = make(
      [{ method: 'GET', path: '/v9/projects', handler: () => json({ projects: [] }) }],
      { teamId: undefined, teamSlug: 'f-orge' },
    );
    await client.listProjects(5);
    expect(stub.calls[0]?.query.get('slug')).toBe('f-orge');
    expect(stub.calls[0]?.query.get('teamId')).toBeNull();
    expect(stub.calls[0]?.query.get('limit')).toBe('5');
  });

  it('lists teams without a scope', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v2/teams',
        handler: () => json({ teams: [{ id: TEAM, slug: 'f-orge', name: 'F-orge' }] }),
      },
    ]);
    await expect(client.listTeams()).resolves.toEqual([
      { id: TEAM, slug: 'f-orge', name: 'F-orge' },
    ]);
    expect(stub.calls[0]?.query.get('teamId')).toBeNull();
  });

  it('returns null for a missing project and rejects unsafe names', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-nope',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
    ]);
    await expect(client.getProject('lp-nope')).resolves.toBeNull();
    await expect(client.getProject('../teams')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.getProject('a/b')).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});

describe('ensureProject', () => {
  it('creates a project linked to the repo and opens previews to the client', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      { method: 'POST', path: '/v10/projects', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.created).toBe(true);
    expect(out.project).toMatchObject({ id: 'prj_123', linkedRepo: `${ORG}/lp-moonpad` });
    expect(stub.find('POST', '/v10/projects')[0]?.body).toEqual({
      name: 'lp-moonpad',
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: `${ORG}/lp-moonpad` },
    });
    expect(stub.find('PATCH', '/v9/projects/prj_123')[0]?.body).toEqual({ ssoProtection: null });
  });

  it('can restrict previews to Vercel Authentication scopes', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    await client.ensureProject({ slug: 'moonpad', protection: 'all_except_custom_domains' });
    expect(stub.find('PATCH', '/v9/projects/prj_123')[0]?.body).toEqual({
      ssoProtection: { deploymentType: 'all_except_custom_domains' },
    });
  });

  it('is idempotent: an existing project is reused, not created again', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    const a = await client.ensureProject({ slug: 'moonpad' });
    const b = await client.ensureProject({ slug: 'moonpad' });
    expect(a.created).toBe(false);
    expect(b.project.id).toBe('prj_123');
    expect(stub.find('POST', '/v10/projects')).toHaveLength(0);
  });

  it('recovers from a name conflict (concurrent or replayed creation)', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        times: 1,
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
      {
        method: 'POST',
        path: '/v10/projects',
        handler: () => json({ error: { code: 'conflict', message: 'exists' } }, 409),
      },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    await expect(client.ensureProject({ slug: 'moonpad' })).resolves.toMatchObject({
      created: false,
    });
  });

  it('links an existing project that has no git repository', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ link: null })),
      },
      { method: 'POST', path: '/v9/projects/prj_123/link', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    await client.ensureProject({ slug: 'moonpad' });
    expect(stub.find('POST', '/v9/projects/prj_123/link')[0]?.body).toEqual({
      type: 'github',
      repo: `${ORG}/lp-moonpad`,
    });
  });

  it('refuses a project linked to another repository', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ link: { type: 'github', org: ORG, repo: 'lp-other' } })),
      },
    ]);
    await expect(client.ensureProject({ slug: 'moonpad' })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('maps a missing Vercel GitHub integration to a typed error', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      {
        method: 'POST',
        path: '/v10/projects',
        handler: () =>
          json(
            {
              error: {
                code: 'bad_request',
                message: 'To link a GitHub repository, you need to install the Vercel GitHub App.',
              },
            },
            400,
          ),
      },
    ]);
    await expect(client.ensureProject({ slug: 'moonpad' })).rejects.toMatchObject({
      kind: 'validation',
      status: 400,
      apiCode: 'bad_request',
    });
  });
});

describe('setEnv', () => {
  const route = (handler: Route['handler']): Route[] => [
    { method: 'POST', path: '/v10/projects/prj_123/env', handler },
  ];

  it('upserts variables for production and preview with the right types', async () => {
    const { client, stub } = make(route(() => json({ created: [], failed: [] })));
    const out = await client.setEnv('prj_123', {
      SOLANA_CLUSTER: 'devnet',
      JUPITER_API_KEY: 'secret-value',
      NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://relay.example',
    });
    expect(out.count).toBe(3);
    const call = stub.calls[0];
    expect(call?.query.get('upsert')).toBe('true');
    expect(call?.body).toEqual([
      { key: 'SOLANA_CLUSTER', value: 'devnet', type: 'plain', target: ['production', 'preview'] },
      {
        key: 'JUPITER_API_KEY',
        value: 'secret-value',
        type: 'sensitive',
        target: ['production', 'preview'],
      },
      {
        key: 'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
        value: 'https://relay.example',
        type: 'plain',
        target: ['production', 'preview'],
      },
    ]);
  });

  it('refuses variables outside the allowlist before any request', async () => {
    const { client, stub } = make(route(() => json({})));
    for (const key of [
      'ANTHROPIC_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SIGNER_HMAC_SECRET',
      'lower',
      'VERCEL_TOKEN',
    ]) {
      await expect(client.setEnv('prj_123', { [key]: 'x' })).rejects.toMatchObject({
        kind: 'invalid_input',
      });
    }
    await expect(client.setEnv('prj_123', { RPC_URL: '' })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('does nothing for an empty set and surfaces rejected variables without values', async () => {
    const { client, stub } = make(
      route(() => json({ created: [], failed: [{ error: { key: 'RPC_URL', code: 'x' } }] })),
    );
    await expect(client.setEnv('prj_123', {})).resolves.toEqual({ count: 0 });
    expect(stub.calls).toHaveLength(0);
    const err = (await client
      .setEnv('prj_123', { RPC_URL: 'https://secret-rpc.example/?api-key=abc' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ kind: 'validation' });
    expect(err.message).toContain('RPC_URL');
    expect(err.message).not.toContain('api-key');
  });

  it('is replayable after a transient failure', async () => {
    const { client, stub } = make([
      { method: 'POST', path: '/v10/projects/prj_123/env', times: 1, handler: () => json({}, 503) },
      { method: 'POST', path: '/v10/projects/prj_123/env', handler: () => json({ created: [] }) },
    ]);
    await client.setEnv('prj_123', { SOLANA_CLUSTER: 'devnet' });
    expect(stub.calls).toHaveLength(2);
  });
});

describe('deployments', () => {
  it('creates a preview deployment from a git ref and commit', async () => {
    const sha = 'a'.repeat(40);
    const { client, stub } = make([
      { method: 'POST', path: '/v13/deployments', handler: () => json(deploymentJson('QUEUED')) },
    ]);
    const d = await client.createDeployment({
      project: { id: 'prj_123', name: 'lp-moonpad' },
      repo: 'lp-moonpad',
      ref: 'forge/job1',
      sha,
    });
    expect(d).toMatchObject({
      id: 'dpl_1',
      url: 'https://lp-moonpad-abc123-forge.vercel.app',
      readyState: 'QUEUED',
      target: 'preview',
    });
    const call = stub.calls[0];
    expect(call?.query.get('teamId')).toBe(TEAM);
    expect(call?.query.get('forceNew')).toBeNull();
    expect(call?.body).toEqual({
      name: 'lp-moonpad',
      project: 'prj_123',
      gitSource: { type: 'github', org: ORG, repo: 'lp-moonpad', ref: 'forge/job1', sha },
    });
  });

  it('can target production directly', async () => {
    const { client, stub } = make([
      {
        method: 'POST',
        path: '/v13/deployments',
        handler: () => json(deploymentJson('QUEUED', { target: 'production' })),
      },
    ]);
    const d = await client.createDeployment({
      project: { id: 'prj_123', name: 'lp-moonpad' },
      repo: 'lp-moonpad',
      ref: 'main',
      target: 'production',
    });
    expect(d.target).toBe('production');
    expect((stub.calls[0]?.body as Record<string, unknown>)['target']).toBe('production');
  });

  it('validates inputs', async () => {
    const { client, stub } = make([]);
    const project = { id: 'prj_123', name: 'lp-moonpad' };
    await expect(
      client.createDeployment({ project, repo: 'forge', ref: 'main' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.createDeployment({ project, repo: 'lp-moonpad', ref: 'a..b' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.createDeployment({ project, repo: 'lp-moonpad', ref: 'main', sha: 'xyz' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(stub.calls).toHaveLength(0);
  });

  it('polls until READY', async () => {
    const states = ['QUEUED', 'INITIALIZING', 'BUILDING', 'READY'];
    let i = 0;
    const { client, sleeps } = make([
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () => json(deploymentJson(states[Math.min(i++, 3)] ?? 'READY')),
      },
    ]);
    const d = await client.waitForDeployment('dpl_1', { pollMs: 1000, timeoutMs: 60_000 });
    expect(d.readyState).toBe('READY');
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it('turns ERROR and CANCELED into deployment_failed', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () =>
          json(
            deploymentJson('ERROR', {
              errorCode: 'BUILD_FAILED',
              errorMessage: 'Command "next build" exited with 1',
            }),
          ),
      },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_2',
        handler: () => json(deploymentJson('CANCELED', { id: 'dpl_2' })),
      },
    ]);
    await expect(client.waitForDeployment('dpl_1')).rejects.toMatchObject({
      kind: 'deployment_failed',
      apiCode: 'BUILD_FAILED',
      message: expect.stringContaining('next build'),
    });
    await expect(client.waitForDeployment('dpl_2')).rejects.toMatchObject({
      kind: 'deployment_failed',
    });
  });

  it('times out when the deployment never becomes ready', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () => json(deploymentJson('BUILDING')),
      },
    ]);
    await expect(
      client.waitForDeployment('dpl_1', { pollMs: 1000, timeoutMs: 3500 }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('accepts a deployment URL and strips the scheme', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: /^\/v13\/deployments\//,
        handler: () => json(deploymentJson('READY')),
      },
    ]);
    await client.getDeployment('https://lp-moonpad-abc123-forge.vercel.app');
    expect(stub.calls[0]?.path).toBe('/v13/deployments/lp-moonpad-abc123-forge.vercel.app');
  });
});

describe('promoteToProduction', () => {
  it('promotes a READY preview and waits until it serves production', async () => {
    let promoted = false;
    let polls = 0;
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/prj_123',
        handler: () => {
          polls++;
          return json(
            projectJson({
              targets: { production: promoted && polls > 3 ? { id: 'dpl_1' } : { id: 'dpl_old' } },
            }),
          );
        },
      },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () => json(deploymentJson('READY')),
      },
      {
        method: 'POST',
        path: '/v10/projects/prj_123/promote/dpl_1',
        handler: () => {
          promoted = true;
          return empty(201);
        },
      },
    ]);
    await expect(client.promoteToProduction('prj_123', 'dpl_1', { pollMs: 100 })).resolves.toEqual({
      promoted: true,
    });
    expect(stub.find('POST', '/v10/projects/prj_123/promote/dpl_1')).toHaveLength(1);
  });

  it('is idempotent: nothing to do when the deployment already serves production', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/prj_123',
        handler: () => json(projectJson({ targets: { production: { id: 'dpl_1' } } })),
      },
    ]);
    await expect(client.promoteToProduction('prj_123', 'dpl_1')).resolves.toEqual({
      promoted: false,
    });
    expect(stub.find('POST', /promote/)).toHaveLength(0);
  });

  it('refuses to promote a deployment that is not READY', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () => json(deploymentJson('BUILDING')),
      },
    ]);
    await expect(client.promoteToProduction('prj_123', 'dpl_1')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(stub.find('POST', /promote/)).toHaveLength(0);
  });

  it('times out when the promotion is never applied', async () => {
    const { client } = make([
      { method: 'GET', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () => json(deploymentJson('READY')),
      },
      { method: 'POST', path: '/v10/projects/prj_123/promote/dpl_1', handler: () => empty(201) },
    ]);
    await expect(
      client.promoteToProduction('prj_123', 'dpl_1', { pollMs: 1000, timeoutMs: 2500 }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('attachSubdomain', () => {
  const domainJson = (verified = true) => ({ name: 'moonpad.forge-sites.app', verified });

  it('attaches <slug>.<clients domain> to the project', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      { method: 'POST', path: '/v10/projects/prj_123/domains', handler: () => json(domainJson()) },
    ]);
    await expect(client.attachSubdomain('prj_123', 'moonpad')).resolves.toEqual({
      domain: 'moonpad.forge-sites.app',
      verified: true,
      verification: [],
      created: true,
    });
    expect(stub.find('POST', '/v10/projects/prj_123/domains')[0]?.body).toEqual({
      name: 'moonpad.forge-sites.app',
    });
  });

  it('is idempotent: an already attached domain is returned without a new POST', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
        handler: () => json(domainJson()),
      },
    ]);
    const out = await client.attachSubdomain('prj_123', 'moonpad');
    expect(out.created).toBe(false);
    expect(stub.find('POST', /domains/)).toHaveLength(0);
  });

  it('reports DNS verification records when the domain is not verified', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: /domains\/moonpad/,
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      {
        method: 'POST',
        path: '/v10/projects/prj_123/domains',
        handler: () =>
          json({
            ...domainJson(false),
            verification: [
              {
                type: 'TXT',
                domain: '_vercel.forge-sites.app',
                value: 'vc-domain-verify=x',
                reason: 'pending',
              },
            ],
          }),
      },
    ]);
    const out = await client.attachSubdomain('prj_123', 'moonpad');
    expect(out.verified).toBe(false);
    expect(out.verification).toEqual([
      { type: 'TXT', domain: '_vercel.forge-sites.app', value: 'vc-domain-verify=x' },
    ]);
  });

  it('detects a domain held by another project', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: /domains\/moonpad/,
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      {
        method: 'POST',
        path: '/v10/projects/prj_123/domains',
        handler: () => json({ error: { code: 'domain_already_in_use', message: 'in use' } }, 409),
      },
    ]);
    await expect(client.attachSubdomain('prj_123', 'moonpad')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('recovers from a replayed POST that already succeeded (409 then present)', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: /domains\/moonpad/,
        times: 1,
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      { method: 'GET', path: /domains\/moonpad/, handler: () => json(domainJson()) },
      {
        method: 'POST',
        path: '/v10/projects/prj_123/domains',
        handler: () => json({ error: { code: 'domain_already_in_use', message: 'in use' } }, 409),
      },
    ]);
    await expect(client.attachSubdomain('prj_123', 'moonpad')).resolves.toMatchObject({
      created: false,
      verified: true,
    });
  });

  it('needs a configured clients domain and a valid slug', async () => {
    const { client, stub } = make([], { clientsDomain: undefined });
    await expect(client.attachSubdomain('prj_123', 'moonpad')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    const withDomain = make([]);
    await expect(withDomain.client.attachSubdomain('prj_123', '../x')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(stub.calls).toHaveLength(0);
    expect(withDomain.stub.calls).toHaveLength(0);
  });

  it('detaches a domain, tolerating one that is already gone', async () => {
    const { client } = make([
      {
        method: 'DELETE',
        path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
        times: 1,
        handler: () => json({}),
      },
      {
        method: 'DELETE',
        path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
    ]);
    await expect(client.detachDomain('prj_123', 'moonpad.forge-sites.app')).resolves.toBe(true);
    await expect(client.detachDomain('prj_123', 'moonpad.forge-sites.app')).resolves.toBe(false);
  });
});

describe('disable and delete', () => {
  it('pauses and unpauses a project', async () => {
    const { client, stub } = make([
      {
        method: 'POST',
        path: '/v1/projects/prj_123/pause',
        handler: () => json(projectJson({ paused: true })),
      },
      { method: 'POST', path: '/v1/projects/prj_123/unpause', handler: () => json(projectJson()) },
    ]);
    await client.pauseProject('prj_123');
    await client.unpauseProject('prj_123');
    expect(stub.calls.map((c) => c.path)).toEqual([
      '/v1/projects/prj_123/pause',
      '/v1/projects/prj_123/unpause',
    ]);
    expect(stub.calls[0]?.query.get('teamId')).toBe(TEAM);
  });

  it('deletes a project, and reports false when it was already deleted', async () => {
    const { client } = make([
      { method: 'DELETE', path: '/v9/projects/prj_123', times: 1, handler: () => empty(204) },
      {
        method: 'DELETE',
        path: '/v9/projects/prj_123',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
    ]);
    await expect(client.deleteProject('prj_123')).resolves.toBe(true);
    await expect(client.deleteProject('prj_123')).resolves.toBe(false);
  });
});

describe('robustness', () => {
  it('waits for Retry-After on 429 and then succeeds', async () => {
    const { client, sleeps } = make([
      {
        method: 'GET',
        path: '/v9/projects',
        times: 1,
        handler: () =>
          json({ error: { code: 'rate_limited', message: 'slow down' } }, 429, {
            'retry-after': '3',
          }),
      },
      { method: 'GET', path: '/v9/projects', handler: () => json({ projects: [] }) },
    ]);
    await client.listProjects();
    expect(sleeps).toEqual([3000]);
  });

  it('maps auth failures and never leaks the token', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects',
        handler: () =>
          json({ error: { code: 'forbidden', message: `Not authorized, token ${TOKEN}` } }, 403),
      },
    ]);
    const err = (await client.listProjects().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ service: 'vercel', kind: 'forbidden', apiCode: 'forbidden' });
    expect(JSON.stringify({ m: err.message, n: err.name })).not.toContain(TOKEN.slice(4));
  });

  it('retries server errors on reads', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/lp-moonpad', times: 2, handler: () => json({}, 500) },
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
    ]);
    await expect(client.getProject('lp-moonpad')).resolves.toMatchObject({ id: 'prj_123' });
    expect(stub.calls).toHaveLength(3);
  });

  it('rejects an invalid token at construction', () => {
    expect(() => createVercelClient({ token: 'x', githubOrg: ORG })).toThrow(/token/);
  });
});
