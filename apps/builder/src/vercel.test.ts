/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { empty, json, stubFetch, type Route } from './http-mock.js';
import {
  assertClientsDomain,
  createVercelClient,
  API_ONLY_DEPLOYMENT_POLICY,
  clientProjectVars,
  envTypeFor,
  pickProjectEnv,
  PROJECT_SERVER_SECRETS,
  PROJECT_ENV_ALLOWLIST,
  PROJECT_ENV_FORBIDDEN,
  PROJECT_ENV_REQUIRED,
  projectEnvProblem,
  projectNameForSlug,
  subdomainFor,
  vercelOptionsFromEnv,
  type VercelClient,
} from './vercel.js';

const ORG = 'forge-org';
const RELAY_SECRET = 'relay-secret-for-tests-0123456789abcdef';
/** The formula, computed independently of relay-token.ts. */
const expectedToken = (slug: string): string =>
  `v1.${slug}.${createHmac('sha256', RELAY_SECRET).update(`forge-rpc-relay:v1:${slug}`).digest('hex')}`;
const DOMAIN = 'forge-sites.app';
const TOKEN = 'vcp_secrettoken0123456789';
const TEAM = 'team_abcdefgh12345678';
/** A syntactically valid base58 address (public, test only). */
const ADDR = 'So11111111111111111111111111111111111111112';

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

  it('classifies variables: every allowed one is public (plain)', () => {
    expect(envTypeFor('FORGE_MULTISIG_VAULT')).toBe('plain');
    expect(envTypeFor('SOLANA_CLUSTER')).toBe('plain');
    expect(envTypeFor('NEXT_PUBLIC_FORGE_RPC_RELAY_URL')).toBe('plain');
    expect(envTypeFor('JUPITER_API_KEY')).toBe('sensitive');
    expect(envTypeFor('R2_SECRET_ACCESS_KEY')).toBe('sensitive');
    expect(envTypeFor('RPC_URL')).toBe('sensitive');
    expect(envTypeFor('GITHUB_PACKAGES_TOKEN')).toBe('sensitive');
  });

  it('regression: no secret can ever be allowlisted for a client project', () => {
    for (const key of [
      'RPC_URL',
      'JUPITER_API_KEY',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
      'GITHUB_PACKAGES_TOKEN',
      'NODE_AUTH_TOKEN',
      'RPC_RELAY_TOKEN_SECRET',
    ]) {
      expect(PROJECT_ENV_ALLOWLIST.has(key)).toBe(false);
      expect(PROJECT_ENV_FORBIDDEN.has(key)).toBe(true);
    }
    for (const key of PROJECT_ENV_ALLOWLIST) {
      // Only the public pool config key, and the single server-only relay token, may carry a
      // credential-like word in their name.
      if (/KEY|SECRET|TOKEN|PRIVATE|PASSWORD/.test(key)) {
        expect(key).toMatch(/^(NEXT_PUBLIC_)?POOL_CONFIG_KEY$|^FORGE_RPC_RELAY_TOKEN$/);
      }
    }
    // The single allowed server-only secret: sensitive, never NEXT_PUBLIC.
    expect([...PROJECT_SERVER_SECRETS]).toEqual(['FORGE_RPC_RELAY_TOKEN']);
    for (const key of PROJECT_ENV_ALLOWLIST) {
      const secret = PROJECT_SERVER_SECRETS.has(key);
      expect(envTypeFor(key), key).toBe(secret ? 'sensitive' : 'plain');
      if (secret) expect(key.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
    for (const key of PROJECT_ENV_REQUIRED) expect(PROJECT_ENV_ALLOWLIST.has(key)).toBe(true);
  });

  it('picks only public variables, derives NEXT_PUBLIC twins and reports missing ones', () => {
    const { vars, missing, invalid } = pickProjectEnv({
      SOLANA_CLUSTER: 'devnet',
      RPC_URL: 'https://devnet.helius-rpc.com/?api-key=must-not-leak',
      JUPITER_API_KEY: 'must-not-leak',
      R2_ACCESS_KEY_ID: 'must-not-leak',
      R2_SECRET_ACCESS_KEY: 'must-not-leak',
      GITHUB_PACKAGES_TOKEN: 'must-not-leak',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      SIGNER_HMAC_SECRET: 'must-not-leak',
      GITHUB_APP_ID: '1',
      FORGE_MULTISIG_VAULT: ADDR,
      FORGE_JUPITER_REFERRAL_ACCOUNT: ADDR,
      NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://relay.forge.example/rpc',
      R2_PUBLIC_URL: '',
    });
    expect(Object.keys(vars).sort()).toEqual([
      'FORGE_JUPITER_REFERRAL_ACCOUNT',
      'FORGE_MULTISIG_VAULT',
      'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
      'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
      'NEXT_PUBLIC_SOLANA_CLUSTER',
      'SOLANA_CLUSTER',
    ]);
    expect(JSON.stringify(vars)).not.toContain('must-not-leak');
    expect(vars['NEXT_PUBLIC_SOLANA_CLUSTER']).toBe('devnet');
    expect(missing).toContain('R2_PUBLIC_URL');
    expect(missing).toContain('FORGE_PLATFORM_FEE_WALLET');
    expect(missing).not.toContain('RPC_URL');
    expect(invalid).toEqual([]);
  });

  it('refuses a relay URL that is the raw RPC provider or carries a key', () => {
    const base = { SOLANA_CLUSTER: 'devnet', FORGE_MULTISIG_VAULT: ADDR };
    const sameHost = pickProjectEnv({
      ...base,
      RPC_URL: 'https://devnet.helius-rpc.com/?api-key=abc',
      NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://devnet.helius-rpc.com/',
    });
    expect(sameHost.invalid).toEqual(['NEXT_PUBLIC_FORGE_RPC_RELAY_URL']);
    expect(sameHost.vars['NEXT_PUBLIC_FORGE_RPC_RELAY_URL']).toBeUndefined();
    expect(sameHost.missing).not.toContain('NEXT_PUBLIC_FORGE_RPC_RELAY_URL');
    for (const url of [
      'https://relay.example/?api-key=abc',
      'https://user:pass@relay.example/',
      'https://relay.example/v1/token/abc',
      'http://relay.example/',
      'not a url',
    ]) {
      expect(projectEnvProblem('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', url)).toMatch(/invalid/);
    }
    expect(projectEnvProblem('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', 'https://relay.example/rpc')).toBe(
      undefined,
    );
    expect(projectEnvProblem('FORGE_MULTISIG_VAULT', 'not-an-address')).toMatch(/invalid/);
    expect(projectEnvProblem('NEXT_PUBLIC_POOL_CONFIG_KEY', `${ADDR},${ADDR}`)).toBe(undefined);
    expect(projectEnvProblem('SOLANA_CLUSTER', 'testnet')).toMatch(/invalid/);
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

/** Project read back after the deployment policy PATCH: git deployments off. */
const readBack: Route = {
  method: 'GET',
  path: '/v9/projects/prj_123',
  handler: () => json(projectJson({ deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY })),
};
const protectionPatch = (stub: Harness['stub']) =>
  stub
    .find('PATCH', '/v9/projects/prj_123')
    .find((c) => typeof c.body === 'object' && c.body !== null && 'ssoProtection' in c.body);
const policyPatches = (stub: Harness['stub']) =>
  stub
    .find('PATCH', '/v9/projects/prj_123')
    .filter((c) => typeof c.body === 'object' && c.body !== null && 'deploymentPolicy' in c.body);

describe('ensureProject: git-triggered deployments', () => {
  it('turns them off on a new project and verifies the stored policy before protection', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      { method: 'POST', path: '/v10/projects', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      readBack,
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.gitDeploymentsDisabled).toBe(true);
    const patches = stub.find('PATCH', '/v9/projects/prj_123');
    expect(patches[0]?.body).toEqual({
      deploymentPolicy: {
        deploymentSources: [
          {
            enabled: true,
            environments: [
              { type: 'system', target: 'production' },
              { type: 'system', target: 'preview' },
            ],
            sources: ['rest-api'],
          },
        ],
      },
    });
    // Verified by a read-back, then protection.
    const order = stub.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('GET /v9/projects/prj_123')).toBeGreaterThan(
      order.indexOf('PATCH /v9/projects/prj_123'),
    );
    expect(patches[1]?.body).toEqual({ ssoProtection: null });
  });

  it('refuses the project when the policy does not hold after the update', async () => {
    for (const stored of [
      undefined,
      { deploymentSources: [] },
      {
        deploymentSources: [
          {
            enabled: true,
            environments: [{ type: 'system', target: 'production' }],
            sources: ['rest-api'],
          },
        ],
      },
      {
        deploymentSources: [
          {
            enabled: true,
            environments: [
              { type: 'system', target: 'production' },
              { type: 'system', target: 'preview' },
            ],
            sources: ['rest-api', 'git'],
          },
        ],
      },
      {
        deploymentSources: [
          {
            enabled: false,
            environments: [
              { type: 'system', target: 'production' },
              { type: 'system', target: 'preview' },
            ],
            sources: ['rest-api'],
          },
        ],
      },
    ]) {
      const { client, stub } = make([
        { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
        { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
        {
          method: 'GET',
          path: '/v9/projects/prj_123',
          handler: () => json(projectJson(stored ? { deploymentPolicy: stored } : {})),
        },
      ]);
      await expect(client.ensureProject({ slug: 'moonpad' })).rejects.toMatchObject({
        kind: 'unexpected',
        message: expect.stringContaining('git-triggered deployments') as unknown,
      });
      // Never reaches protection (the pipeline stops before anything is pushed).
      expect(protectionPatch(stub)).toBeUndefined();
    }
  });

  it('does not patch again when the stored policy already holds', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY })),
      },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.gitDeploymentsDisabled).toBe(true);
    expect(policyPatches(stub)).toHaveLength(0);
    expect(protectionPatch(stub)).toBeDefined();
  });

  it('keeps deployments explicit: createDeployment still posts a git source', async () => {
    const { client, stub } = make([
      { method: 'POST', path: '/v13/deployments', handler: () => json(deploymentJson('QUEUED')) },
    ]);
    await client.createDeployment({
      project: { id: 'prj_123', name: 'lp-moonpad' },
      repo: 'lp-moonpad',
      ref: 'main',
    });
    expect(stub.find('POST', '/v13/deployments')).toHaveLength(1);
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
      readBack,
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.created).toBe(true);
    expect(out.project).toMatchObject({ id: 'prj_123', linkedRepo: `${ORG}/lp-moonpad` });
    expect(stub.find('POST', '/v10/projects')[0]?.body).toEqual({
      name: 'lp-moonpad',
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: `${ORG}/lp-moonpad` },
    });
    expect(protectionPatch(stub)?.body).toEqual({ ssoProtection: null });
  });

  it('can restrict previews to Vercel Authentication scopes', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      readBack,
    ]);
    await client.ensureProject({ slug: 'moonpad', protection: 'all_except_custom_domains' });
    expect(protectionPatch(stub)?.body).toEqual({
      ssoProtection: { deploymentType: 'all_except_custom_domains' },
    });
  });

  it('is idempotent: an existing project is reused, not created again', async () => {
    const { client, stub } = make([
      { method: 'GET', path: '/v9/projects/lp-moonpad', handler: () => json(projectJson()) },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      readBack,
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
      readBack,
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
      readBack,
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

  it('sends the relay token as a sensitive server-only variable, never NEXT_PUBLIC', async () => {
    const { client, stub } = make(route(() => json({ created: [], failed: [] })));
    const vars = clientProjectVars(
      { SOLANA_CLUSTER: 'devnet', FORGE_RPC_RELAY_TOKEN: 'v1.otherpad.copied' },
      { slug: 'moonpad', relayTokenSecret: RELAY_SECRET },
    );
    await client.setEnv('prj_123', vars);
    const body = stub.calls[0]?.body as Array<{ key: string; value: string; type: string }>;
    const token = body.find((e) => e.key === 'FORGE_RPC_RELAY_TOKEN');
    expect(token).toMatchObject({ type: 'sensitive', value: expectedToken('moonpad') });
    expect(body.find((e) => e.key === 'SOLANA_CLUSTER')?.type).toBe('plain');
    expect(body.some((e) => e.key.startsWith('NEXT_PUBLIC_') && e.value === token?.value)).toBe(
      false,
    );
    expect(
      body.some((e) => /RPC_RELAY_TOKEN/.test(e.key) && e.key !== 'FORGE_RPC_RELAY_TOKEN'),
    ).toBe(false);
  });

  it('refuses a malformed relay token, a NEXT_PUBLIC twin of it, or its secret', async () => {
    const { client, stub } = make(route(() => json({})));
    for (const vars of [
      { FORGE_RPC_RELAY_TOKEN: 'not-a-token' } as Record<string, string>,
      { NEXT_PUBLIC_FORGE_RPC_RELAY_TOKEN: expectedToken('moonpad') },
      { RPC_RELAY_TOKEN_SECRET: RELAY_SECRET },
    ]) {
      const err = (await client.setEnv('prj_123', vars).catch((e: unknown) => e)) as Error;
      expect(err).toMatchObject({ kind: 'invalid_input' });
      expect(err.message).not.toContain(RELAY_SECRET);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('upserts variables for production and preview with the right types', async () => {
    const { client, stub } = make(route(() => json({ created: [], failed: [] })));
    const out = await client.setEnv('prj_123', {
      SOLANA_CLUSTER: 'devnet',
      FORGE_MULTISIG_VAULT: ADDR,
      NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://relay.example',
    });
    expect(out.count).toBe(3);
    const call = stub.calls[0];
    expect(call?.query.get('upsert')).toBe('true');
    expect(call?.body).toEqual([
      { key: 'SOLANA_CLUSTER', value: 'devnet', type: 'plain', target: ['production', 'preview'] },
      {
        key: 'FORGE_MULTISIG_VAULT',
        value: ADDR,
        type: 'plain',
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
    await expect(client.setEnv('prj_123', { SOLANA_CLUSTER: '' })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('regression: refuses every secret by name, before any request, without echoing it', async () => {
    const { client, stub } = make(route(() => json({})));
    for (const key of [
      'RPC_URL',
      'JUPITER_API_KEY',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_ACCOUNT_ID',
      'GITHUB_PACKAGES_TOKEN',
    ]) {
      const err = (await client
        .setEnv('prj_123', { SOLANA_CLUSTER: 'devnet', [key]: 'https://x.example/?api-key=abc' })
        .catch((e: unknown) => e)) as Error;
      expect(err).toMatchObject({ kind: 'invalid_input' });
      expect(err.message).toContain(key);
      expect(err.message).toContain('secret');
      expect(err.message).not.toContain('api-key');
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a public variable whose value looks like a credential', async () => {
    const { client, stub } = make(route(() => json({})));
    await expect(
      client.setEnv('prj_123', {
        NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://devnet.helius-rpc.com/?api-key=abc',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(stub.calls).toHaveLength(0);
  });

  it('does nothing for an empty set and surfaces rejected variables without values', async () => {
    const { client, stub } = make(
      route(() =>
        json({ created: [], failed: [{ error: { key: 'NEXT_PUBLIC_R2_PUBLIC_URL', code: 'x' } }] }),
      ),
    );
    await expect(client.setEnv('prj_123', {})).resolves.toEqual({ count: 0 });
    expect(stub.calls).toHaveLength(0);
    const err = (await client
      .setEnv('prj_123', { NEXT_PUBLIC_R2_PUBLIC_URL: 'https://cdn.example/bucket-path' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ kind: 'validation' });
    expect(err.message).toContain('NEXT_PUBLIC_R2_PUBLIC_URL');
    expect(err.message).not.toContain('bucket-path');
  });

  it('pruneEnv removes every variable that is not allowlisted (secrets set by older code)', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v10/projects/prj_123/env',
        handler: () =>
          json({
            envs: [
              { id: 'env_1', key: 'RPC_URL' },
              { id: 'env_2', key: 'SOLANA_CLUSTER' },
              { id: 'env_3', key: 'R2_SECRET_ACCESS_KEY' },
              { id: 'env_4', key: 'GITHUB_PACKAGES_TOKEN' },
              { id: 'env_5', key: 'NEXT_PUBLIC_FORGE_RPC_RELAY_URL' },
              { id: 'env_6', key: 'RPC_URL' },
            ],
          }),
      },
      { method: 'DELETE', path: /^\/v9\/projects\/prj_123\/env\/env_\d$/, handler: () => json({}) },
    ]);
    await expect(client.pruneEnv('prj_123')).resolves.toEqual({
      removed: ['GITHUB_PACKAGES_TOKEN', 'R2_SECRET_ACCESS_KEY', 'RPC_URL'],
    });
    expect(stub.find('DELETE', /env/).map((c) => c.path)).toEqual([
      '/v9/projects/prj_123/env/env_1',
      '/v9/projects/prj_123/env/env_3',
      '/v9/projects/prj_123/env/env_4',
      '/v9/projects/prj_123/env/env_6',
    ]);
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

  it('reports the commit and the project of a deployment', async () => {
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const { client } = make([
      {
        method: 'GET',
        path: '/v13/deployments/dpl_1',
        handler: () =>
          json(
            deploymentJson('READY', {
              projectId: 'prj_123',
              gitSource: { type: 'github', ref: 'main', sha },
              meta: { githubCommitSha: other },
            }),
          ),
      },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_2',
        handler: () => json(deploymentJson('READY', { meta: { githubCommitSha: other } })),
      },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_3',
        handler: () => json(deploymentJson('READY', { gitSource: { sha: 'main' } })),
      },
    ]);
    // gitSource first, then the git metadata; anything that is not a full sha is ignored.
    expect(await client.getDeployment('dpl_1')).toMatchObject({
      commitSha: sha,
      projectId: 'prj_123',
    });
    expect(await client.getDeployment('dpl_2')).toMatchObject({
      commitSha: other,
      projectId: undefined,
    });
    expect((await client.getDeployment('dpl_3')).commitSha).toBeUndefined();
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
