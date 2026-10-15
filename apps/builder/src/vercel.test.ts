/// <reference types="node" />
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gitBlobSha, type CommitTree, type TreeLimits } from './github.js';
import { empty, json, stubFetch, type RecordedCall, type Route } from './http-mock.js';
import {
  assertClientsDomain,
  cleanupFailureOf,
  createVercelClient,
  API_ONLY_DEPLOYMENT_POLICY,
  clientProjectVars,
  envTypeFor,
  isProductionNotStaged,
  pickProjectEnv,
  PRODUCTION_NOT_STAGED,
  PROJECT_SERVER_SECRETS,
  PROJECT_ENV_ALLOWLIST,
  PROJECT_ENV_FORBIDDEN,
  PROJECT_ENV_REQUIRED,
  projectEnvProblem,
  projectNameForSlug,
  subdomainFor,
  vercelOptionsFromEnv,
  type DeploymentSource,
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
  targets: { production: { id: 'dpl_live' } },
  framework: 'nextjs',
  ...over,
});

const deploymentJson = (state: string, over: Record<string, unknown> = {}) => ({
  id: 'dpl_1',
  url: 'lp-moonpad-abc123-forge.vercel.app',
  readyState: state,
  target: null,
  ...over,
});

/** Commit deployed by the deployment tests, and another one. */
const COMMIT = 'c'.repeat(40);
const OTHER_COMMIT = 'd'.repeat(40);
const PROJECT = { id: 'prj_123', name: 'lp-moonpad' };

const sha1 = (content: Buffer): string => createHash('sha1').update(content).digest('hex');

interface SourceFile {
  path: string;
  content: Buffer;
  executable?: boolean;
}

const SITE_FILES: SourceFile[] = [
  { path: 'package.json', content: Buffer.from('{"name":"lp-moonpad"}\n') },
  { path: 'src/pages/index.tsx', content: Buffer.from('export default () => null;\n') },
  { path: 'scripts/check.sh', content: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true },
];

/** In-memory stand-in for the GitHub client side of a deployment (`DeploymentSource`). */
function fakeSource(files: SourceFile[] = SITE_FILES, opts: { head?: string | null } = {}) {
  const calls = {
    heads: [] as string[],
    trees: [] as Array<{ repo: string; commitSha: string; limits: Partial<TreeLimits> }>,
    blobs: [] as string[][],
  };
  const byBlob = new Map(files.map((f) => [gitBlobSha(f.content), f.content]));
  const source: DeploymentSource = {
    getBranchHead: async (_repo, branch) => {
      calls.heads.push(branch);
      return opts.head === undefined ? COMMIT : opts.head;
    },
    listCommitTree: async (repo, commitSha, limits = {}): Promise<CommitTree> => {
      calls.trees.push({ repo, commitSha, limits });
      return {
        commitSha,
        treeSha: 'e'.repeat(40),
        files: files.map((f) => ({
          path: f.path,
          blobSha: gitBlobSha(f.content),
          size: f.content.byteLength,
          executable: f.executable === true,
        })),
        totalBytes: files.reduce((n, f) => n + f.content.byteLength, 0),
      };
    },
    readBlobs: async (_repo, blobShas) => {
      calls.blobs.push([...blobShas]);
      const out = new Map<string, Buffer>();
      for (const s of blobShas) {
        const content = byBlob.get(s);
        if (content) out.set(s, content);
      }
      return out;
    },
  };
  return { source, calls };
}

/** Lookup of an earlier deployment of the same commit: none by default. */
const noEarlierDeployment: Route = {
  method: 'GET',
  path: '/v6/deployments',
  handler: () => json({ deployments: [], pagination: { count: 0 } }),
};

const missingFiles = (digests: string[]) =>
  json({ error: { code: 'missing_files', message: 'Missing files', missing: digests } }, 400);

const uploadRoute: Route = { method: 'POST', path: '/v2/files', handler: () => json({}) };

/** Expected `files` entry of the deployment body for a source file. */
const fileEntry = (f: SourceFile) => ({
  file: f.path,
  sha: sha1(f.content),
  size: f.content.byteLength,
  mode: f.executable ? 0o100755 : 0o100644,
});

const createdDeployment = (over: Record<string, unknown> = {}) =>
  json(
    deploymentJson('QUEUED', {
      projectId: 'prj_123',
      meta: { githubCommitSha: COMMIT },
      ...over,
    }),
  );

const deploymentPosts = (stub: Harness['stub']): RecordedCall[] =>
  stub.find('POST', '/v13/deployments');

/** Nonce of one creation request (`meta.forgeRequestId`): 16 random bytes, hex. */
const REQUEST_ID = expect.stringMatching(/^[0-9a-f]{32}$/) as unknown;
const requestIdOf = (call: RecordedCall): string | undefined =>
  (call.body as { meta?: { forgeRequestId?: string } } | undefined)?.meta?.forgeRequestId;

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
      'NPM_TOKEN',
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
/** Framework values PATCHed on the project, in order. */
const frameworkPatches = (stub: Harness['stub']): unknown[] =>
  stub
    .find('PATCH', '/v9/projects/prj_123')
    .filter((c) => typeof c.body === 'object' && c.body !== null && 'framework' in c.body)
    .map((c) => (c.body as { framework: unknown }).framework);

/** A project on the Vercel side, as the placeholder routes below see and change it. */
interface PlaceholderState {
  exists: boolean;
  production: string | null;
  framework: string | null;
  /** What the placeholder deployment ends in. */
  placeholder: 'READY' | 'ERROR' | 'BUILDING';
  /** The PATCH that puts `nextjs` back is refused. */
  restoreFails: boolean;
  /** The promotion endpoint moves production. */
  promotes: boolean;
}

const placeholderState = (over: Partial<PlaceholderState> = {}): PlaceholderState => ({
  exists: false,
  production: null,
  framework: 'nextjs',
  placeholder: 'READY',
  restoreFails: false,
  promotes: true,
  ...over,
});

/**
 * An unlinked project and its placeholder deployment `dpl_ph`, like the API: the first deployment
 * of a project with no production deployment takes production once READY; any later one only
 * through the promotion.
 */
function placeholderRoutes(state: PlaceholderState): Route[] {
  const project = () =>
    projectJson({
      link: undefined,
      targets: state.production ? { production: { id: state.production } } : null,
      framework: state.framework,
    });
  return [
    {
      method: 'GET',
      path: '/v9/projects/lp-moonpad',
      handler: () =>
        state.exists ? json(project()) : json({ error: { code: 'not_found', message: 'x' } }, 404),
    },
    {
      method: 'POST',
      path: '/v10/projects',
      handler: () => {
        state.exists = true;
        return json(project());
      },
    },
    {
      method: 'PATCH',
      path: '/v9/projects/prj_123',
      handler: (call) => {
        const body = call.body as { framework?: string | null };
        if ('framework' in body) {
          if (body.framework === 'nextjs' && state.restoreFails) {
            return json({ error: { code: 'bad_request', message: 'refused' } }, 400);
          }
          state.framework = body.framework ?? null;
        }
        return json(project());
      },
    },
    { method: 'GET', path: '/v9/projects/prj_123', handler: () => json(project()) },
    { method: 'POST', path: '/v2/files', handler: () => json({}) },
    {
      method: 'POST',
      path: '/v13/deployments',
      handler: () => json(deploymentJson('BUILDING', { id: 'dpl_ph', target: 'production' })),
    },
    {
      method: 'GET',
      path: '/v13/deployments/dpl_ph',
      handler: () => {
        if (state.placeholder === 'READY') state.production ??= 'dpl_ph';
        return json(deploymentJson(state.placeholder, { id: 'dpl_ph', target: 'production' }));
      },
    },
    {
      method: 'POST',
      path: '/v10/projects/prj_123/promote/dpl_ph',
      handler: () => {
        if (state.promotes) state.production = 'dpl_ph';
        return empty(201);
      },
    },
  ];
}

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

  it('keeps deployments explicit: createDeployment uploads files, never a git source', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        { method: 'POST', path: '/v13/deployments', handler: () => createdDeployment() },
      ],
      { source },
    );
    await client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main' });
    const posts = deploymentPosts(stub);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).not.toHaveProperty('gitSource');
    expect(posts[0]?.body).toHaveProperty('files');
  });
});

describe('ensureProject', () => {
  it('puts a static placeholder in production first, so the first preview is not public', async () => {
    let production: string | null = null;
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      {
        method: 'POST',
        path: '/v10/projects',
        handler: () => json(projectJson({ link: undefined, targets: null })),
      },
      {
        method: 'PATCH',
        path: '/v9/projects/prj_123',
        handler: () => json(projectJson({ link: undefined, targets: null })),
      },
      { method: 'POST', path: '/v2/files', handler: () => json({}) },
      {
        method: 'POST',
        path: '/v13/deployments',
        handler: () => json(deploymentJson('BUILDING', { id: 'dpl_ph', target: 'production' })),
      },
      {
        method: 'GET',
        path: '/v13/deployments/dpl_ph',
        handler: () => {
          production = 'dpl_ph';
          return json(deploymentJson('READY', { id: 'dpl_ph', target: 'production' }));
        },
      },
      {
        method: 'GET',
        path: '/v9/projects/prj_123',
        handler: () =>
          json(
            projectJson({
              link: undefined,
              targets: production ? { production: { id: production } } : null,
            }),
          ),
      },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.productionDeploymentId).toBe('dpl_ph');
    const created = stub.find('POST', '/v13/deployments');
    expect(created).toHaveLength(1);
    const body = created[0]!.body as {
      target: string;
      files: Array<{ file: string }>;
      projectSettings?: unknown;
    };
    expect(body.target).toBe('production');
    expect(body.files.map((f) => f.file)).toEqual(['index.html']);
    expect(body.projectSettings).toBeUndefined();
    // The project goes to no framework for the static page, then back to nextjs.
    const frameworks = stub
      .find('PATCH', '/v9/projects/prj_123')
      .map((c) => (c.body as { framework?: unknown }).framework)
      .filter((f) => f !== undefined);
    expect(frameworks).toEqual([null, 'nextjs']);
    // Content-addressed upload of the placeholder page itself.
    const upload = stub.find('POST', '/v2/files')[0]!;
    expect(upload.headers['x-vercel-digest']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('puts the framework back when the placeholder ends in ERROR or never gets ready', async () => {
    for (const placeholder of ['ERROR', 'BUILDING'] as const) {
      const state = placeholderState({ placeholder });
      const { client, stub } = make(placeholderRoutes(state));
      const error = await client.ensureProject({ slug: 'moonpad' }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        kind: placeholder === 'ERROR' ? 'deployment_failed' : 'timeout',
      });
      expect(frameworkPatches(stub)).toEqual([null, 'nextjs']);
      expect(state.framework).toBe('nextjs');
      expect(cleanupFailureOf(error)).toBeUndefined();
    }
  });

  it('keeps the placeholder failure when putting the framework back fails too', async () => {
    const state = placeholderState({ placeholder: 'ERROR', restoreFails: true });
    const { client, stub } = make(placeholderRoutes(state));
    const error = await client.ensureProject({ slug: 'moonpad' }).catch((e: unknown) => e);
    // The original failure, not the restore's.
    expect(error).toMatchObject({ kind: 'deployment_failed', message: /dpl_ph ended in ERROR/ });
    expect(cleanupFailureOf(error)).toMatchObject({
      what: 'framework restore',
      error: { kind: 'validation', status: 400 },
    });
    expect(frameworkPatches(stub)).toEqual([null, 'nextjs']);
    expect(state.framework).toBeNull();
  });

  it('repairs a framework left off by an earlier run on the next run', async () => {
    // The placeholder went live, but putting the framework back failed.
    const state = placeholderState({ restoreFails: true });
    const { client, stub } = make(placeholderRoutes(state));
    await expect(client.ensureProject({ slug: 'moonpad' })).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(state).toMatchObject({ production: 'dpl_ph', framework: null });
    // Next run: the project has production, only its framework is wrong.
    state.restoreFails = false;
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.framework).toBe('nextjs');
    expect(state.framework).toBe('nextjs');
    expect(frameworkPatches(stub)).toEqual([null, 'nextjs', 'nextjs']);
    expect(stub.find('POST', '/v13/deployments')).toHaveLength(1);
  });

  it('puts the framework back on any project where it differs', async () => {
    for (const framework of [null, 'vite']) {
      const { client, stub } = make([
        {
          method: 'GET',
          path: '/v9/projects/lp-moonpad',
          handler: () => json(projectJson({ link: undefined, framework })),
        },
        {
          method: 'PATCH',
          path: '/v9/projects/prj_123',
          handler: () => json(projectJson({ link: undefined })),
        },
      ]);
      const out = await client.ensureProject({ slug: 'moonpad' });
      expect(out.project.framework).toBe('nextjs');
      expect(frameworkPatches(stub)).toEqual(['nextjs']);
      expect(stub.find('POST', '/v13/deployments')).toHaveLength(0);
    }
  });

  it('does not deploy a placeholder when the project already has production', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ link: undefined })),
      },
      {
        method: 'PATCH',
        path: '/v9/projects/prj_123',
        handler: () => json(projectJson({ link: undefined })),
      },
    ]);
    await client.ensureProject({ slug: 'moonpad' });
    expect(stub.find('POST', '/v13/deployments')).toHaveLength(0);
    expect(stub.find('POST', '/v2/files')).toHaveLength(0);
  });

  it('creates a project without a git link and opens previews to the client', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
      {
        method: 'POST',
        path: '/v10/projects',
        handler: () => json(projectJson({ link: undefined })),
      },
      {
        method: 'PATCH',
        path: '/v9/projects/prj_123',
        handler: () => json(projectJson({ link: undefined })),
      },
      {
        method: 'GET',
        path: '/v9/projects/prj_123',
        handler: () =>
          json(projectJson({ link: undefined, deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY })),
      },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.created).toBe(true);
    expect(out.project).toMatchObject({
      id: 'prj_123',
      linkedRepo: undefined,
      gitDeploymentsDisabled: true,
    });
    // No `gitRepository`: Vercel never needs access to the GitHub organization.
    expect(stub.find('POST', '/v10/projects')[0]?.body).toEqual({
      name: 'lp-moonpad',
      framework: 'nextjs',
    });
    expect(stub.find('POST', /\/link$/)).toHaveLength(0);
    // Unlinked: no git webhook can deploy it, so no deployment policy is needed (Hobby has none).
    expect(policyPatches(stub)).toHaveLength(0);
    expect(protectionPatch(stub)?.body).toEqual({ ssoProtection: null });
  });

  it('works on the Hobby plan, which has no deployment policy, for an unlinked project', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ link: undefined })),
      },
      {
        method: 'PATCH',
        path: '/v9/projects/prj_123',
        handler: (call) =>
          (call.body as { deploymentPolicy?: unknown }).deploymentPolicy
            ? json(
                {
                  error: {
                    code: 'forbidden',
                    message:
                      'Deployment policies are not available for Hobby, upgrade to Pro or Enterprise.',
                  },
                },
                403,
              )
            : json(projectJson({ link: undefined })),
      },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.gitDeploymentsDisabled).toBe(true);
    expect(policyPatches(stub)).toHaveLength(0);
  });

  it('refuses a linked project whose deployment policy cannot be set (Hobby)', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ deploymentPolicy: undefined })),
      },
      {
        method: 'PATCH',
        path: '/v9/projects/prj_123',
        handler: () =>
          json(
            {
              error: {
                code: 'forbidden',
                message:
                  'Deployment policies are not available for Hobby, upgrade to Pro or Enterprise.',
              },
            },
            403,
          ),
      },
    ]);
    await expect(client.ensureProject({ slug: 'moonpad' })).rejects.toMatchObject({
      kind: expect.stringMatching(/auth|forbidden|unexpected/),
    });
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

  it('reuses an existing project that has no git repository without linking it', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ link: null })),
      },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      {
        method: 'GET',
        path: '/v9/projects/prj_123',
        handler: () =>
          json(projectJson({ link: null, deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY })),
      },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out).toMatchObject({ created: false, project: { linkedRepo: undefined } });
    expect(stub.find('POST', /\/link$/)).toHaveLength(0);
    expect(protectionPatch(stub)).toBeDefined();
  });

  it('still reuses a project created earlier with a link to its own repository', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v9/projects/lp-moonpad',
        handler: () => json(projectJson({ deploymentPolicy: API_ONLY_DEPLOYMENT_POLICY })),
      },
      { method: 'PATCH', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
    ]);
    const out = await client.ensureProject({ slug: 'moonpad' });
    expect(out.project.linkedRepo).toBe(`${ORG}/lp-moonpad`);
    expect(stub.find('POST', /./)).toHaveLength(0);
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

  it('maps a refused project creation to a typed error', async () => {
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
          json({ error: { code: 'bad_request', message: 'Invalid request: name' } }, 400),
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

describe('deployments from files', () => {
  const [pkg, page, script] = SITE_FILES as [SourceFile, SourceFile, SourceFile];

  it('creates a preview from the exact files of the commit, uploading only what Vercel lacks', async () => {
    const { source, calls } = fakeSource();
    let posts = 0;
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => (++posts === 1 ? missingFiles([sha1(page.content)]) : createdDeployment()),
        },
        uploadRoute,
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'forge/job1',
      sha: COMMIT,
    });
    expect(d).toMatchObject({
      id: 'dpl_1',
      url: 'https://lp-moonpad-abc123-forge.vercel.app',
      readyState: 'QUEUED',
      target: 'preview',
      commitSha: COMMIT,
    });

    // The exact tree of that commit, read from the client repo.
    expect(calls.trees).toEqual([
      { repo: 'lp-moonpad', commitSha: COMMIT, limits: expect.any(Object) as unknown },
    ]);
    expect(calls.heads).toEqual([]);

    // Created twice: the first answer lists the missing file, which alone is uploaded.
    const created = deploymentPosts(stub);
    expect(created).toHaveLength(2);
    const expectedBody = {
      name: 'lp-moonpad',
      project: 'prj_123',
      files: SITE_FILES.map(fileEntry),
      projectSettings: { framework: 'nextjs' },
      meta: {
        githubCommitSha: COMMIT,
        githubCommitRef: 'forge/job1',
        githubRepo: 'lp-moonpad',
        githubOrg: ORG,
        forgeRequestId: REQUEST_ID,
      },
    };
    expect(created[0]?.body).toEqual(expectedBody);
    expect(created[1]?.body).toEqual(expectedBody);
    // Every request carries its own nonce.
    expect(requestIdOf(created[0]!)).not.toBe(requestIdOf(created[1]!));
    expect(created[0]?.query.get('teamId')).toBe(TEAM);
    // Reuse is decided per commit by the lookup, never by Vercel's own deduplication.
    expect(created[0]?.query.get('forceNew')).toBe('1');
    expect(created[0]?.query.get('skipAutoDetectionConfirmation')).toBe('1');

    const uploads = stub.find('POST', '/v2/files');
    expect(uploads).toHaveLength(1);
    const upload = uploads[0]!;
    expect(upload.headers['x-vercel-digest']).toBe(sha1(page.content));
    expect(upload.headers['content-length']).toBe(String(page.content.byteLength));
    expect(upload.headers['content-type']).toBe('application/octet-stream');
    expect(upload.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(upload.query.get('teamId')).toBe(TEAM);
    expect(Buffer.from(upload.raw ?? new Uint8Array()).equals(page.content)).toBe(true);
    // Upload, then the second creation.
    const order = stub.calls.map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([
      'GET /v6/deployments',
      'POST /v13/deployments',
      'POST /v2/files',
      'POST /v13/deployments',
    ]);
  });

  it('looks for an earlier deployment of the same commit, project and target first', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        { method: 'POST', path: '/v13/deployments', handler: () => createdDeployment() },
      ],
      { source },
    );
    await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    const lookup = stub.find('GET', '/v6/deployments')[0]!;
    expect(lookup.query.get('projectId')).toBe('prj_123');
    expect(lookup.query.get('target')).toBe('preview');
    expect(lookup.query.get('meta-githubCommitSha')).toBe(COMMIT);
    expect(lookup.query.get('teamId')).toBe(TEAM);
    // Vercel already had every file: nothing uploaded, created once.
    expect(stub.find('POST', '/v2/files')).toHaveLength(0);
    expect(deploymentPosts(stub)).toHaveLength(1);
  });

  it('regression: stages production deployments (domains only move with the explicit promotion)', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            createdDeployment({ target: 'production', autoAssignCustomDomains: false }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    expect(d).toMatchObject({ target: 'production', commitSha: COMMIT });
    expect(deploymentPosts(stub)[0]?.body).toEqual({
      name: 'lp-moonpad',
      project: 'prj_123',
      target: 'production',
      autoAssignCustomDomains: false,
      files: SITE_FILES.map(fileEntry),
      projectSettings: { framework: 'nextjs' },
      meta: {
        githubCommitSha: COMMIT,
        githubCommitRef: 'main',
        githubRepo: 'lp-moonpad',
        githubOrg: ORG,
        forgeRequestId: REQUEST_ID,
      },
    });
    expect(stub.find('GET', '/v6/deployments')[0]?.query.get('target')).toBe('production');
    // Nothing else: no alias or promotion is requested by the creation.
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v6/deployments',
      'POST /v13/deployments',
    ]);
  });

  it('cancels and refuses a production deployment that Vercel did not stage', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            createdDeployment({
              readyState: 'BUILDING',
              target: 'production',
              autoAssignCustomDomains: true,
            }),
        },
        { method: 'PATCH', path: '/v12/deployments/dpl_1/cancel', handler: () => json({}) },
      ],
      { source },
    );
    await expect(
      client.createDeployment({
        project: PROJECT,
        repo: 'lp-moonpad',
        ref: 'main',
        sha: COMMIT,
        target: 'production',
      }),
    ).rejects.toMatchObject({ kind: 'unexpected', message: expect.stringMatching(/not staged/) });
    expect(stub.find('PATCH', '/v12/deployments/dpl_1/cancel')).toHaveLength(1);
  });

  it('cancels and refuses a production deployment whose staging Vercel does not confirm', async () => {
    // No `autoAssignCustomDomains` echo: nothing says the domains wait for the promotion.
    for (const echo of [{}, { autoAssignCustomDomains: null }]) {
      const { source } = fakeSource();
      const { client, stub } = make(
        [
          noEarlierDeployment,
          {
            method: 'POST',
            path: '/v13/deployments',
            handler: () =>
              createdDeployment({ readyState: 'BUILDING', target: 'production', ...echo }),
          },
          { method: 'PATCH', path: '/v12/deployments/dpl_1/cancel', handler: () => json({}) },
        ],
        { source },
      );
      await expect(
        client.createDeployment({
          project: PROJECT,
          repo: 'lp-moonpad',
          ref: 'main',
          sha: COMMIT,
          target: 'production',
        }),
      ).rejects.toMatchObject({ kind: 'unexpected', message: expect.stringMatching(/not staged/) });
      expect(stub.find('PATCH', '/v12/deployments/dpl_1/cancel')).toHaveLength(1);
    }
  });

  it('refuses a staged production deployment that took production before its promotion', async () => {
    const { source } = fakeSource();
    let production = 'dpl_live';
    const staged = { target: 'production', autoAssignCustomDomains: false };
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => createdDeployment({ readyState: 'BUILDING', ...staged }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_1',
          handler: () => {
            // Vercel gave it production by itself once READY.
            production = 'dpl_1';
            return createdDeployment({ readyState: 'READY', ...staged });
          },
        },
        {
          method: 'GET',
          path: '/v9/projects/prj_123',
          handler: () => json(projectJson({ targets: { production: { id: production } } })),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    const error = await client.waitForDeployment(d.id).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: 'unexpected',
      apiCode: PRODUCTION_NOT_STAGED,
      message: expect.stringMatching(/before its promotion/) as unknown,
    });
    expect(isProductionNotStaged(error)).toBe(true);
    expect(isProductionNotStaged(new Error('other'))).toBe(false);
    expect(stub.find('POST', /promote/)).toHaveLength(0);
  });

  it('lets a staged deployment wait for its promotion, and never re-checks a promoted one', async () => {
    const { source } = fakeSource();
    const staged = { target: 'production', autoAssignCustomDomains: false };
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => createdDeployment({ readyState: 'QUEUED', ...staged }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_1',
          handler: () => createdDeployment({ readyState: 'READY', ...staged }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_9',
          handler: () => createdDeployment({ id: 'dpl_9', readyState: 'READY', ...staged }),
        },
        { method: 'GET', path: '/v9/projects/prj_123', handler: () => json(projectJson()) },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    await expect(client.waitForDeployment(d.id)).resolves.toMatchObject({ readyState: 'READY' });
    expect(stub.find('GET', '/v9/projects/prj_123')).toHaveLength(1);
    // Checked once: waiting again (or for a deployment this client never saw building, which an
    // earlier run may have promoted) reads no project.
    await client.waitForDeployment(d.id);
    await client.waitForDeployment('dpl_9');
    expect(stub.find('GET', '/v9/projects/prj_123')).toHaveLength(1);
  });

  it('only reuses a production deployment still building when Vercel confirms it is staged', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: () => json({ deployments: [{ uid: 'dpl_9' }] }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_9',
          // No echo on the record: not adopted.
          handler: () =>
            createdDeployment({ id: 'dpl_9', readyState: 'BUILDING', target: 'production' }),
        },
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            createdDeployment({
              id: 'dpl_new',
              target: 'production',
              autoAssignCustomDomains: false,
            }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    expect(d.id).toBe('dpl_new');
    expect(deploymentPosts(stub)).toHaveLength(1);
  });

  it('refuses a deployment that does not report its project (fails closed)', async () => {
    const { source } = fakeSource();
    const { client } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => createdDeployment({ projectId: undefined }),
        },
      ],
      { source },
    );
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).rejects.toMatchObject({
      kind: 'unexpected',
      message: expect.stringMatching(/does not report its project/) as unknown,
    });
  });

  it('accepts a finished deployment Vercel returns for identical files', async () => {
    // Already READY: nothing more can happen to it, the promotion stays explicit.
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            createdDeployment({
              readyState: 'READY',
              target: 'production',
              autoAssignCustomDomains: true,
            }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    expect(d.readyState).toBe('READY');
    expect(stub.find('PATCH', /cancel/)).toHaveLength(0);
  });

  it('idempotent: reuses a deployment of the same commit and target that has not failed', async () => {
    const { source, calls } = fakeSource();
    const { client, stub } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: () =>
            json({
              deployments: [
                // Newest first: a failed attempt, one of another commit, then the one to reuse.
                { uid: 'dpl_err', readyState: 'ERROR', meta: { githubCommitSha: COMMIT } },
                { uid: 'dpl_old', readyState: 'READY', meta: { githubCommitSha: OTHER_COMMIT } },
                { uid: 'dpl_9', readyState: 'BUILDING', meta: { githubCommitSha: COMMIT } },
              ],
            }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_9',
          handler: () =>
            json(
              deploymentJson('BUILDING', {
                id: 'dpl_9',
                projectId: 'prj_123',
                meta: { githubCommitSha: COMMIT },
              }),
            ),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'forge/job1',
      sha: COMMIT,
    });
    expect(d).toMatchObject({ id: 'dpl_9', commitSha: COMMIT, readyState: 'BUILDING' });
    expect(deploymentPosts(stub)).toHaveLength(0);
    expect(stub.find('POST', '/v2/files')).toHaveLength(0);
    expect(stub.find('GET', /\/v13\/deployments\/dpl_(err|old)$/)).toHaveLength(0);
    // Nothing read from GitHub either.
    expect(calls.trees).toEqual([]);
    expect(calls.blobs).toEqual([]);
  });

  it('never reuses a deployment of another project or commit, a failed one or an unstaged one', async () => {
    const candidates: Record<string, Record<string, unknown>> = {
      dpl_a: deploymentJson('READY', {
        id: 'dpl_a',
        projectId: 'prj_other',
        target: 'production',
        meta: { githubCommitSha: COMMIT },
      }),
      dpl_b: deploymentJson('READY', {
        id: 'dpl_b',
        projectId: 'prj_123',
        target: 'production',
        meta: { githubCommitSha: OTHER_COMMIT },
      }),
      dpl_c: deploymentJson('CANCELED', {
        id: 'dpl_c',
        projectId: 'prj_123',
        target: 'production',
        meta: { githubCommitSha: COMMIT },
      }),
      dpl_d: deploymentJson('BUILDING', {
        id: 'dpl_d',
        projectId: 'prj_123',
        target: 'production',
        autoAssignCustomDomains: true,
        meta: { githubCommitSha: COMMIT },
      }),
      dpl_e: deploymentJson('READY', {
        id: 'dpl_e',
        projectId: 'prj_123',
        target: null,
        meta: { githubCommitSha: COMMIT },
      }),
      dpl_f: deploymentJson('READY', { id: 'dpl_f', target: 'production', meta: {} }),
    };
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          // The list carries no meta: every candidate is checked on its full record.
          handler: () => json({ deployments: Object.keys(candidates).map((uid) => ({ uid })) }),
        },
        {
          method: 'GET',
          path: /^\/v13\/deployments\/dpl_[a-f]$/,
          handler: (call) => json(candidates[call.path.split('/').pop()!]),
        },
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            createdDeployment({
              id: 'dpl_new',
              target: 'production',
              autoAssignCustomDomains: false,
            }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
      target: 'production',
    });
    expect(d.id).toBe('dpl_new');
    expect(deploymentPosts(stub)).toHaveLength(1);
  });

  it('falls back to an unfiltered lookup when Vercel refuses the metadata filter', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: (call) =>
            call.query.has('meta-githubCommitSha')
              ? json({ error: { code: 'bad_request', message: 'Invalid query' } }, 400)
              : json({
                  deployments: [
                    { uid: 'dpl_9', readyState: 'READY', meta: { githubCommitSha: COMMIT } },
                  ],
                }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_9',
          handler: () =>
            json(
              deploymentJson('READY', {
                id: 'dpl_9',
                projectId: 'prj_123',
                meta: { githubCommitSha: COMMIT },
              }),
            ),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(d.id).toBe('dpl_9');
    const lookups = stub.find('GET', '/v6/deployments');
    expect(lookups).toHaveLength(2);
    expect(lookups[1]?.query.get('projectId')).toBe('prj_123');
    expect(deploymentPosts(stub)).toHaveLength(0);
  });

  it('does not replay a creation blindly after an ambiguous failure', async () => {
    const { source } = fakeSource();
    let lost: string | undefined;
    const { client, stub, sleeps } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: (call) => {
            const byRequest = call.query.get('meta-forgeRequestId');
            const listed = lost !== undefined && (byRequest === null || byRequest === lost);
            return json({
              deployments: listed
                ? [
                    {
                      uid: 'dpl_1',
                      readyState: 'QUEUED',
                      meta: { githubCommitSha: COMMIT, forgeRequestId: lost },
                    },
                  ]
                : [],
            });
          },
        },
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: (call) => {
            // Vercel created it, but the answer was lost.
            lost = requestIdOf(call);
            return json({ error: { code: 'internal', message: 'oops' } }, 502);
          },
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_1',
          handler: () =>
            createdDeployment({ meta: { githubCommitSha: COMMIT, forgeRequestId: lost } }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(d.id).toBe('dpl_1');
    expect(deploymentPosts(stub)).toHaveLength(1);
    // The lost request is looked up by its own nonce (any target), and found at once.
    const lookups = stub.find('GET', '/v6/deployments');
    expect(lookups.map((c) => c.query.get('meta-forgeRequestId'))).toEqual([null, lost]);
    expect(lookups[1]?.query.get('target')).toBeNull();
    expect(lookups[1]?.query.get('projectId')).toBe('prj_123');
    expect(sleeps).toEqual([]);
  });

  it('finds a lost creation by its nonce when Vercel lists it a moment late', async () => {
    const { source } = fakeSource();
    let lost: string | undefined;
    let nonceReads = 0;
    const { client, stub, sleeps } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: (call) => {
            const byRequest = call.query.get('meta-forgeRequestId');
            // The commit filter never lists it in time; the nonce lists it on its second read.
            const listed = byRequest !== null && byRequest === lost && ++nonceReads >= 2;
            return json({ deployments: listed ? [{ uid: 'dpl_1' }] : [] });
          },
        },
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: (call) => {
            lost = requestIdOf(call);
            return json({ error: { message: 'gateway timeout' } }, 504);
          },
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_1',
          handler: () =>
            createdDeployment({ meta: { githubCommitSha: COMMIT, forgeRequestId: lost } }),
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(d.id).toBe('dpl_1');
    // No second deployment: the lookup waited a moment and found the first one.
    expect(deploymentPosts(stub)).toHaveLength(1);
    expect(sleeps).toEqual([2_000]);
  });

  it('never adopts a deployment of another request or another project by its nonce', async () => {
    const { source } = fakeSource();
    let posts = 0;
    let first: string | undefined;
    const { client, stub } = make(
      [
        {
          method: 'GET',
          path: '/v6/deployments',
          handler: (call) =>
            json({
              deployments:
                call.query.get('meta-forgeRequestId') !== null
                  ? [{ uid: 'dpl_other' }, { uid: 'dpl_foreign' }]
                  : [],
            }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_other',
          handler: () =>
            createdDeployment({
              id: 'dpl_other',
              meta: { githubCommitSha: COMMIT, forgeRequestId: 'f'.repeat(32) },
            }),
        },
        {
          method: 'GET',
          path: '/v13/deployments/dpl_foreign',
          handler: () =>
            createdDeployment({
              id: 'dpl_foreign',
              projectId: 'prj_other',
              meta: { githubCommitSha: COMMIT, forgeRequestId: first },
            }),
        },
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: (call) => {
            first ??= requestIdOf(call);
            return ++posts === 1 ? json({ error: { message: 'down' } }, 503) : createdDeployment();
          },
        },
      ],
      { source },
    );
    const d = await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(d.id).toBe('dpl_1');
    expect(deploymentPosts(stub)).toHaveLength(2);
  });

  it('tries once more after an ambiguous failure that created nothing', async () => {
    const { source } = fakeSource();
    let posts = 0;
    const { client, stub, sleeps } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            ++posts === 1 ? json({ error: { message: 'down' } }, 503) : createdDeployment(),
        },
      ],
      { source },
    );
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).resolves.toMatchObject({ id: 'dpl_1' });
    const created = deploymentPosts(stub);
    expect(created).toHaveLength(2);
    // Before the second request: the first one's nonce, read a bounded number of times a moment
    // apart, then the commit lookup again. The second request carries a nonce of its own.
    const nonce = requestIdOf(created[0]!);
    expect(
      stub.find('GET', '/v6/deployments').map((c) => c.query.get('meta-forgeRequestId')),
    ).toEqual([null, nonce, nonce, nonce, null]);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(requestIdOf(created[1]!)).not.toBe(nonce);

    // Only once: a second ambiguous failure is reported.
    posts = 0;
    const failing = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => json({ error: { message: 'down' } }, 503),
        },
      ],
      { source },
    );
    await expect(
      failing.client.createDeployment({
        project: PROJECT,
        repo: 'lp-moonpad',
        ref: 'main',
        sha: COMMIT,
      }),
    ).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(deploymentPosts(failing.stub)).toHaveLength(2);
  });

  it('uploads each missing file once, with bounded concurrency, then retries once', async () => {
    const files: SourceFile[] = Array.from({ length: 20 }, (_, i) => ({
      path: `public/f${i}.txt`,
      content: Buffer.from(`file ${i}\n`),
    }));
    // Same content at two paths: one upload.
    files.push({ path: 'public/copy.txt', content: Buffer.from('file 0\n') });
    const { source } = fakeSource(files);
    let posts = 0;
    let inflight = 0;
    let peak = 0;
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            ++posts === 1
              ? missingFiles([...new Set(files.map((f) => sha1(f.content)))])
              : createdDeployment(),
        },
        {
          method: 'POST',
          path: '/v2/files',
          handler: async () => {
            inflight++;
            peak = Math.max(peak, inflight);
            await new Promise((r) => setTimeout(r, 2));
            inflight--;
            return json({});
          },
        },
      ],
      { source, uploadConcurrency: 4 },
    );
    await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    const uploads = stub.find('POST', '/v2/files');
    expect(uploads).toHaveLength(20);
    expect(new Set(uploads.map((u) => u.headers['x-vercel-digest'])).size).toBe(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(deploymentPosts(stub)).toHaveLength(2);
  });

  it('retries a file upload on a server error (content-addressed, safe to replay)', async () => {
    const { source } = fakeSource();
    let posts = 0;
    let uploads = 0;
    const { client, stub, sleeps } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => (++posts === 1 ? missingFiles([sha1(pkg.content)]) : createdDeployment()),
        },
        {
          method: 'POST',
          path: '/v2/files',
          handler: () => (++uploads === 1 ? json({ error: { message: 'busy' } }, 500) : json({})),
        },
      ],
      { source },
    );
    await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(stub.find('POST', '/v2/files')).toHaveLength(2);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('fails clearly when Vercel still reports missing files after the upload', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => missingFiles([sha1(script.content)]),
        },
        uploadRoute,
      ],
      { source },
    );
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).rejects.toMatchObject({
      kind: 'unexpected',
      apiCode: 'missing_files',
      message: expect.stringMatching(/still/) as unknown,
    });
    expect(deploymentPosts(stub)).toHaveLength(2);
    expect(stub.find('POST', '/v2/files')).toHaveLength(1);
  });

  it('refuses to upload a file Vercel asks for that is not part of the deployment', async () => {
    const { source } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => missingFiles(['f'.repeat(40)]),
        },
        uploadRoute,
      ],
      { source },
    );
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(stub.find('POST', '/v2/files')).toHaveLength(0);
  });

  it('surfaces any other refusal of the creation as a typed error', async () => {
    const { source } = fakeSource();
    const { client } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () =>
            json({ error: { code: 'bad_request', message: `Invalid files, token ${TOKEN}` } }, 400),
        },
      ],
      { source },
    );
    const err = (await client
      .createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT })
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ kind: 'validation', status: 400, apiCode: 'bad_request' });
    expect(err.message).not.toContain(TOKEN.slice(4));
  });

  it('reads each file from GitHub once per client: later deployments reuse the digests', async () => {
    const changed: SourceFile = { path: 'src/pages/index.tsx', content: Buffer.from('changed\n') };
    const first = fakeSource();
    const second = fakeSource([pkg, changed, script]);
    let source: DeploymentSource = first.source;
    const proxy: DeploymentSource = {
      getBranchHead: (r, b) => source.getBranchHead(r, b),
      listCommitTree: (r, s, l) => source.listCommitTree(r, s, l),
      readBlobs: (r, b, o) => source.readBlobs(r, b, o),
    };
    let posts = 0;
    const { client, stub } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => {
            posts++;
            // First commit: Vercel has nothing. Second commit: it lacks the package.json (an
            // expired upload) and the changed page.
            if (posts === 1) return missingFiles(SITE_FILES.map((f) => sha1(f.content)));
            if (posts === 3) return missingFiles([sha1(pkg.content), sha1(changed.content)]);
            return createdDeployment({
              meta: { githubCommitSha: posts === 2 ? COMMIT : OTHER_COMMIT },
            });
          },
        },
        uploadRoute,
      ],
      { source: proxy },
    );
    await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: COMMIT,
    });
    expect(first.calls.blobs).toHaveLength(1);
    expect(new Set(first.calls.blobs[0])).toEqual(
      new Set(SITE_FILES.map((f) => gitBlobSha(f.content))),
    );

    source = second.source;
    await client.createDeployment({
      project: PROJECT,
      repo: 'lp-moonpad',
      ref: 'main',
      sha: OTHER_COMMIT,
    });
    // The changed page first (unknown digest), then the package.json Vercel asked for.
    expect(second.calls.blobs).toEqual([[gitBlobSha(changed.content)], [gitBlobSha(pkg.content)]]);
    const uploads = stub.find('POST', '/v2/files').slice(3);
    expect(uploads.map((u) => u.headers['x-vercel-digest']).sort()).toEqual(
      [sha1(pkg.content), sha1(changed.content)].sort(),
    );
  });

  it('resolves the ref to its head commit when no sha is given', async () => {
    const { source, calls } = fakeSource();
    const { client, stub } = make(
      [
        noEarlierDeployment,
        { method: 'POST', path: '/v13/deployments', handler: () => createdDeployment() },
      ],
      { source },
    );
    const d = await client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main' });
    expect(d.commitSha).toBe(COMMIT);
    expect(calls.heads).toEqual(['main']);
    expect(calls.trees[0]?.commitSha).toBe(COMMIT);
    expect((deploymentPosts(stub)[0]?.body as { meta: unknown }).meta).toMatchObject({
      githubCommitSha: COMMIT,
      githubCommitRef: 'main',
    });

    const missing = fakeSource(SITE_FILES, { head: null });
    const none = make([], { source: missing.source });
    await expect(
      none.client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'forge/gone' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(none.stub.calls).toHaveLength(0);
  });

  it('refuses a deployment that reports another commit than the one uploaded', async () => {
    const { source } = fakeSource();
    const { client } = make(
      [
        noEarlierDeployment,
        {
          method: 'POST',
          path: '/v13/deployments',
          handler: () => createdDeployment({ meta: { githubCommitSha: OTHER_COMMIT } }),
        },
      ],
      { source },
    );
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).rejects.toMatchObject({ kind: 'unexpected', message: expect.stringMatching(/commit/) });
  });

  it('enforces the file count and size limits before reading or uploading anything', async () => {
    const big: SourceFile[] = [
      ...SITE_FILES,
      { path: 'public/big.bin', content: Buffer.alloc(2048, 1) },
    ];
    for (const [limits, message] of [
      [{ maxFiles: 3 }, /too many files/],
      [{ maxTotalBytes: 1024 }, /too large/],
      [{ maxFileBytes: 1024 }, /public\/big\.bin/],
    ] as const) {
      const { source, calls } = fakeSource(big);
      const { client, stub } = make([noEarlierDeployment], {
        source,
        deploymentLimits: limits,
      });
      await expect(
        client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
      ).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(message) });
      // The limits also reach the GitHub listing.
      expect(calls.trees[0]?.limits).toMatchObject(limits);
      expect(calls.blobs).toEqual([]);
      expect(deploymentPosts(stub)).toHaveLength(0);
    }
  });

  it('needs a repository source', async () => {
    const { client, stub } = make([]);
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: COMMIT }),
    ).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/source/) });
    expect(stub.calls).toHaveLength(0);
  });

  it('validates inputs', async () => {
    const { source, calls } = fakeSource();
    const { client, stub } = make([], { source });
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'forge', ref: 'main' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'a..b' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.createDeployment({ project: PROJECT, repo: 'lp-moonpad', ref: 'main', sha: 'xyz' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.createDeployment({
        project: { id: '../x', name: 'lp-moonpad' },
        repo: 'lp-moonpad',
        ref: 'main',
        sha: COMMIT,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(stub.calls).toHaveLength(0);
    expect(calls).toEqual({ heads: [], trees: [], blobs: [] });
  });
});

describe('deployments', () => {
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

describe('restorePlaceholder and cancelDeployment', () => {
  it('puts the placeholder back in production, promoted when Vercel does not assign it', async () => {
    // Another deployment took production: a new production deployment does not move it by itself.
    const state = placeholderState({ exists: true, production: 'dpl_public' });
    const { client, stub } = make(placeholderRoutes(state));
    await expect(client.restorePlaceholder('prj_123')).resolves.toEqual({ deploymentId: 'dpl_ph' });
    expect(state.production).toBe('dpl_ph');
    expect(stub.find('POST', '/v10/projects/prj_123/promote/dpl_ph')).toHaveLength(1);
    const body = stub.find('POST', '/v13/deployments')[0]?.body as {
      files: Array<{ file: string }>;
    };
    expect(body.files.map((f) => f.file)).toEqual(['index.html']);
    expect(frameworkPatches(stub)).toEqual([null, 'nextjs']);
    // Verified on the project itself, after the promotion.
    const order = stub.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.at(-1)).toBe('GET /v9/projects/prj_123');
  });

  it('fails when production never moves to the placeholder', async () => {
    const state = placeholderState({ exists: true, production: 'dpl_public', promotes: false });
    const { client } = make(placeholderRoutes(state));
    await expect(client.restorePlaceholder('prj_123')).rejects.toMatchObject({ kind: 'timeout' });
    expect(state.production).toBe('dpl_public');
  });

  it('needs an existing project', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v9/projects/prj_gone',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
    ]);
    await expect(client.restorePlaceholder('prj_gone')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('cancels a deployment, tolerating one that already ended or is gone', async () => {
    const { client, stub } = make([
      { method: 'PATCH', path: '/v12/deployments/dpl_1/cancel', handler: () => json({}) },
      {
        method: 'PATCH',
        path: '/v12/deployments/dpl_2/cancel',
        handler: () => json({ error: { code: 'bad_request', message: 'already ready' } }, 400),
      },
      {
        method: 'PATCH',
        path: '/v12/deployments/dpl_3/cancel',
        handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
      },
    ]);
    for (const id of ['dpl_1', 'dpl_2', 'dpl_3']) {
      await expect(client.cancelDeployment(id)).resolves.toBeUndefined();
    }
    expect(stub.find('PATCH', /\/cancel$/)).toHaveLength(3);
    await expect(client.cancelDeployment('../x')).rejects.toMatchObject({ kind: 'invalid_input' });
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

  it('refuses an answer about any other domain than the one asked for', async () => {
    for (const name of [
      'evil.forge-sites.app',
      'moonpad.forge-sites.app.evil.test',
      'Moonpad.forge-sites.app',
      'moonpad.vercel.app',
    ]) {
      // Already attached (GET), or just added (POST).
      const read = make([
        {
          method: 'GET',
          path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
          handler: () => json({ name, verified: true }),
        },
      ]);
      await expect(read.client.attachSubdomain('prj_123', 'moonpad')).rejects.toMatchObject({
        kind: 'invalid_response',
      });
      const added = make([
        {
          method: 'GET',
          path: '/v9/projects/prj_123/domains/moonpad.forge-sites.app',
          handler: () => json({ error: { code: 'not_found', message: 'x' } }, 404),
        },
        {
          method: 'POST',
          path: '/v10/projects/prj_123/domains',
          handler: () => json({ name, verified: true }),
        },
      ]);
      await expect(added.client.attachSubdomain('prj_123', 'moonpad')).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    }
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

  it('lists the production hosts of one deployment of the project, team scoped', async () => {
    const { client, stub } = make([
      {
        method: 'GET',
        path: '/v4/aliases',
        handler: () =>
          json({
            aliases: [
              { alias: 'lp-moonpad.vercel.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
              {
                alias: 'LP-Moonpad-Forge.vercel.app',
                projectId: 'prj_123',
                deploymentId: 'dpl_live',
                redirect: null,
              },
              { alias: 'lp-moonpad.vercel.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
            ],
            pagination: { count: 3, next: null, prev: null },
          }),
      },
    ]);
    await expect(client.listProductionHosts('prj_123', 'dpl_live')).resolves.toEqual([
      'lp-moonpad-forge.vercel.app',
      'lp-moonpad.vercel.app',
    ]);
    const [call] = stub.find('GET', '/v4/aliases');
    expect(call?.query.get('projectId')).toBe('prj_123');
    expect(call?.query.get('teamId')).toBe(TEAM);
    expect(call?.query.get('limit')).toBe('20');
    expect(call?.query.has('until')).toBe(false);
  });

  it('keeps only aliases whose record names our project and our deployment', async () => {
    const { client } = make([
      {
        method: 'GET',
        path: '/v4/aliases',
        handler: () =>
          json({
            aliases: [
              // A look-alike project of someone else (the filter is never trusted alone).
              { alias: 'lp-moonpad-evil.vercel.app', projectId: 'prj_evil', deploymentId: 'dpl_x' },
              {
                alias: 'lp-moonpad-evil2.vercel.app',
                projectId: 'prj_evil',
                deploymentId: 'dpl_live',
              },
              { alias: 'lp-moonpad-nopr.vercel.app', projectId: null, deploymentId: 'dpl_live' },
              { alias: 'lp-moonpad-nopr2.vercel.app', deploymentId: 'dpl_live' },
              // Ours, but pointing at another (older) deployment.
              { alias: 'lp-moonpad-old.vercel.app', projectId: 'prj_123', deploymentId: 'dpl_old' },
              { alias: 'lp-moonpad-none.vercel.app', projectId: 'prj_123', deploymentId: null },
              // Ours, but only a redirect.
              {
                alias: 'lp-moonpad-redir.vercel.app',
                projectId: 'prj_123',
                deploymentId: 'dpl_live',
                redirect: 'lp-moonpad.vercel.app',
              },
              // Ours, but not a site host.
              { alias: 'a.b.vercel.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
              { alias: 'https://x.vercel.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
              { alias: 'x.vercel.app:443', projectId: 'prj_123', deploymentId: 'dpl_live' },
              { alias: 'vercel.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
              { alias: 'moonpad.forge-sites.app', projectId: 'prj_123', deploymentId: 'dpl_live' },
            ],
          }),
      },
    ]);
    await expect(client.listProductionHosts('prj_123', 'dpl_live')).resolves.toEqual([
      'moonpad.forge-sites.app',
    ]);
  });

  it('follows the pages of the alias list, within a bound', async () => {
    const page = (n: number, next: number | null) =>
      json({
        aliases: [
          { alias: `lp-moonpad-${n}.vercel.app`, projectId: 'prj_123', deploymentId: 'dpl_live' },
        ],
        pagination: { count: 1, next, prev: null },
      });
    const paged = make([
      { method: 'GET', path: '/v4/aliases', times: 1, handler: () => page(1, 1700) },
      { method: 'GET', path: '/v4/aliases', times: 1, handler: () => page(2, null) },
    ]);
    await expect(paged.client.listProductionHosts('prj_123', 'dpl_live')).resolves.toEqual([
      'lp-moonpad-1.vercel.app',
      'lp-moonpad-2.vercel.app',
    ]);
    expect(paged.stub.find('GET', '/v4/aliases')[1]?.query.get('until')).toBe('1700');

    let n = 0;
    const endless = make([
      { method: 'GET', path: '/v4/aliases', handler: () => page(++n, 1000 - n) },
    ]);
    await expect(endless.client.listProductionHosts('prj_123', 'dpl_live')).resolves.toHaveLength(
      10,
    );
    expect(endless.stub.find('GET', '/v4/aliases')).toHaveLength(10);
  });

  it('waits, within a bound, for the aliases to reach the promoted deployment', async () => {
    const answer = (deploymentId: string) =>
      json({
        aliases: [{ alias: 'lp-moonpad.vercel.app', projectId: 'prj_123', deploymentId }],
        pagination: { count: 1, next: null, prev: null },
      });
    const moving = make([
      { method: 'GET', path: '/v4/aliases', times: 2, handler: () => answer('dpl_old') },
      { method: 'GET', path: '/v4/aliases', handler: () => answer('dpl_live') },
    ]);
    await expect(
      moving.client.listProductionHosts('prj_123', 'dpl_live', {
        timeoutMs: 60_000,
        pollMs: 2_000,
      }),
    ).resolves.toEqual(['lp-moonpad.vercel.app']);
    expect(moving.sleeps).toEqual([2_000, 2_000]);

    const never = make([{ method: 'GET', path: '/v4/aliases', handler: () => answer('dpl_old') }]);
    await expect(
      never.client.listProductionHosts('prj_123', 'dpl_live', { timeoutMs: 10_000, pollMs: 3_000 }),
    ).resolves.toEqual([]);
    expect(never.stub.find('GET', '/v4/aliases')).toHaveLength(4);
    // Without a timeout: one read, no wait.
    const once = make([{ method: 'GET', path: '/v4/aliases', handler: () => answer('dpl_old') }]);
    await expect(once.client.listProductionHosts('prj_123', 'dpl_live')).resolves.toEqual([]);
    expect(once.stub.find('GET', '/v4/aliases')).toHaveLength(1);
    expect(once.sleeps).toEqual([]);
  });

  it('refuses an unexpected alias answer and invalid ids', async () => {
    const { client } = make([
      { method: 'GET', path: '/v4/aliases', handler: () => json({ aliases: 'none' }) },
    ]);
    await expect(client.listProductionHosts('prj_123', 'dpl_live')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    const none = make([]);
    await expect(none.client.listProductionHosts('../prj', 'dpl_live')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(none.client.listProductionHosts('prj_123', 'dpl/x')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(none.stub.calls).toHaveLength(0);
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
