/// <reference types="node" />
import { createHash, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertRepoPath,
  createAppJwt,
  createGithubClient,
  encodeBranch,
  gitBlobSha,
  githubOptionsFromEnv,
  repoNameForSlug,
  TREE_LIMITS,
  treeLimits,
  type GithubClient,
} from './github.js';
import { empty, json, stubFetch, type FetchStub, type Route } from './http-mock.js';

const ORG = 'forge-org';
const NOW = 1_800_000_000_000;
const TEMPLATE = `${ORG}/launchpad-template`;

let privateKey = '';
let publicKey = '';
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

// ---------------------------------------------------------------------------------------------
// In-memory fake of the GitHub REST API (just what the client uses)
// ---------------------------------------------------------------------------------------------

interface Entry {
  mode: string;
  sha: string;
}
interface MintBody {
  repositories?: string[];
  permissions?: Record<string, string>;
}
interface FakeRepo {
  private: boolean;
  defaultBranch: string;
  template: string | null;
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Map<string, Entry>>;
  blobs: Map<string, Buffer>;
}

class FakeGithub {
  repos = new Map<string, FakeRepo>();
  nowMs = NOW;
  tokenCounter = 0;
  tokenTtlMs = 3_600_000;
  tokens: string[] = [];
  /** Successful token mints, in order. */
  mints: Array<{ token: string; body: MintBody }> = [];
  /** Statuses to answer on the next ref update (simulate a concurrent push). */
  failNextRefPatch = false;
  generateStatus: 200 | 404 | 422 = 200;
  /** Number of GET ref calls on a freshly generated repo that answer 404 first. */
  readinessDelay = 0;
  /** Number of repo reads (generate response included) that show no template link yet. */
  templateLinkDelay = 0;
  /** Answer 409 "Git Repository is empty" (not 404) while a generated repo is not ready. */
  emptyRepoStatus: 404 | 409 = 404;
  protectionStatus = 200;
  stub: FetchStub;

  constructor(extra: Route[] = []) {
    this.stub = stubFetch([...extra, ...this.routes()]);
  }

  addRepo(name: string, opts: Partial<FakeRepo> = {}): FakeRepo {
    const repo: FakeRepo = {
      private: true,
      defaultBranch: 'main',
      template: TEMPLATE,
      refs: new Map(),
      commits: new Map(),
      trees: new Map(),
      blobs: new Map(),
      ...opts,
    };
    this.repos.set(name, repo);
    const tree = new Map<string, Entry>([
      ['README.md', { mode: '100644', sha: gitBlobSha(Buffer.from('hi')) }],
      ['src/theme/theme.css', { mode: '100644', sha: gitBlobSha(Buffer.from('old')) }],
      ['src/old.ts', { mode: '100644', sha: gitBlobSha(Buffer.from('gone')) }],
    ]);
    const sha = this.hashTree(tree);
    repo.trees.set(sha, tree);
    const c = this.hash(`commit-${name}`);
    repo.commits.set(c, { tree: sha, parents: [], message: 'init' });
    repo.refs.set(`heads/${repo.defaultBranch}`, c);
    return repo;
  }

  private hash(s: string): string {
    return createHash('sha1').update(s).digest('hex');
  }
  private hashTree(t: Map<string, Entry>): string {
    return this.hash(JSON.stringify([...t.entries()].sort()));
  }

  repoOf(path: string): { name: string; repo: FakeRepo } | undefined {
    const m = /^\/repos\/forge-org\/([^/]+)/.exec(path);
    const name = m?.[1];
    const repo = name ? this.repos.get(name) : undefined;
    return name && repo ? { name, repo } : undefined;
  }

  repoJson(name: string, r: FakeRepo): unknown {
    return {
      id: 1000 + name.length,
      name,
      full_name: `${ORG}/${name}`,
      private: r.private,
      default_branch: r.defaultBranch,
      html_url: `https://github.com/${ORG}/${name}`,
      is_template: name === 'launchpad-template',
      template_repository: r.template ? { full_name: r.template } : null,
    };
  }

  /** Whether the call's token may read the template (org-wide, or scoped to include it). */
  canReadTemplate(call: { headers: Record<string, string> }): boolean {
    const token = (call.headers.authorization ?? '').replace(/^Bearer /, '');
    const repos = this.mints.find((m) => m.token === token)?.body?.repositories;
    return repos === undefined || repos.includes('launchpad-template');
  }

  /** Like GitHub right after a generation: the template link appears a few reads later. */
  repoJsonLagging(name: string, r: FakeRepo): unknown {
    if (this.templateLinkDelay <= 0) return this.repoJson(name, r);
    this.templateLinkDelay--;
    return { ...(this.repoJson(name, r) as object), template_repository: null };
  }

  routes(): Route[] {
    const notFound = () => json({ message: 'Not Found' }, 404);
    return [
      {
        method: 'GET',
        path: `/orgs/${ORG}/installation`,
        handler: () =>
          json({
            id: 42,
            repository_selection: 'all',
            permissions: { contents: 'write', administration: 'write' },
          }),
      },
      {
        method: 'POST',
        path: '/app/installations/42/access_tokens',
        handler: (call) => {
          // Like GitHub: a token cannot name a repository that does not exist.
          const wanted = (call.body as { repositories?: string[] } | undefined)?.repositories;
          if (wanted?.some((r) => r !== 'launchpad-template' && !this.repos.has(r))) {
            return json(
              {
                message:
                  'There is at least one repository that does not exist or is not accessible to the parent installation.',
              },
              422,
            );
          }
          const token = `ghs_fake${String(++this.tokenCounter).padStart(8, '0')}abcdefghijklmnop`;
          this.tokens.push(token);
          this.mints.push({ token, body: call.body as MintBody });
          return json(
            { token, expires_at: new Date(this.nowMs + this.tokenTtlMs).toISOString() },
            201,
          );
        },
      },
      {
        method: 'GET',
        path: `/repos/${ORG}/launchpad-template`,
        handler: () =>
          json(
            this.repoJson('launchpad-template', {
              private: false,
              defaultBranch: 'main',
              template: null,
            } as FakeRepo),
          ),
      },
      {
        method: 'POST',
        path: `/repos/${ORG}/launchpad-template/generate`,
        handler: (call) => {
          if (this.generateStatus === 404) return notFound();
          if (this.generateStatus === 422)
            return json({ message: 'name already exists on this account' }, 422);
          const body = call.body as { name: string; private: boolean };
          const repo = this.addRepo(body.name, { private: body.private });
          if (this.readinessDelay > 0) repo.refs.clear();
          return json(this.repoJsonLagging(body.name, repo), 201);
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-[a-z0-9-]+$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          if (!r) return notFound();
          const body = this.repoJsonLagging(r.name, r.repo) as Record<string, unknown>;
          return json(this.canReadTemplate(call) ? body : { ...body, template_repository: null });
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/[^/]+\/git\/ref\/(.+)$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const ref = /\/git\/ref\/(.+)$/.exec(call.path)?.[1] ?? '';
          if (!r) return notFound();
          if (this.readinessDelay > 0 && ref === `heads/${r.repo.defaultBranch}`) {
            this.readinessDelay--;
            if (this.readinessDelay === 0) this.restoreMain(r.repo);
            return this.emptyRepoStatus === 409
              ? json({ message: 'Git Repository is empty.' }, 409)
              : notFound();
          }
          const sha = r.repo.refs.get(ref);
          return sha ? json({ ref: `refs/${ref}`, object: { sha } }) : notFound();
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/[^/]+\/git\/commits\/[0-9a-f]{40}$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const sha = call.path.split('/').pop() ?? '';
          const c = r?.repo.commits.get(sha);
          return c
            ? json({ sha, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) })
            : notFound();
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/[^/]+\/git\/trees\/[0-9a-f]{40}$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const sha = call.path.split('/').pop() ?? '';
          const t = r?.repo.trees.get(sha);
          if (!t) return notFound();
          return json({
            sha,
            truncated: false,
            tree: [...t.entries()].map(([path, e]) => ({
              path,
              mode: e.mode,
              type: 'blob',
              sha: e.sha,
            })),
          });
        },
      },
      {
        method: 'POST',
        path: /^\/repos\/forge-org\/[^/]+\/git\/blobs$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const body = call.body as { content: string; encoding: string };
          if (!r || body.encoding !== 'base64') return json({ message: 'bad' }, 422);
          const buf = Buffer.from(body.content, 'base64');
          const sha = gitBlobSha(buf);
          r.repo.blobs.set(sha, buf);
          return json({ sha }, 201);
        },
      },
      {
        method: 'POST',
        path: /^\/repos\/forge-org\/[^/]+\/git\/trees$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const body = call.body as {
            base_tree: string;
            tree: Array<{ path: string; mode: string; sha: string | null }>;
          };
          const base = r?.repo.trees.get(body.base_tree);
          if (!r || !base) return json({ message: 'bad base' }, 422);
          const next = new Map(base);
          for (const e of body.tree) {
            if (e.sha === null) next.delete(e.path);
            else next.set(e.path, { mode: e.mode, sha: e.sha });
          }
          const sha = this.hashTree(next);
          r.repo.trees.set(sha, next);
          return json({ sha }, 201);
        },
      },
      {
        method: 'POST',
        path: /^\/repos\/forge-org\/[^/]+\/git\/commits$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const body = call.body as { message: string; tree: string; parents: string[] };
          if (!r) return notFound();
          const sha = this.hash(JSON.stringify(body) + r.repo.commits.size);
          r.repo.commits.set(sha, {
            tree: body.tree,
            parents: body.parents,
            message: body.message,
          });
          return json({ sha }, 201);
        },
      },
      {
        method: 'POST',
        path: /^\/repos\/forge-org\/[^/]+\/git\/refs$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const body = call.body as { ref: string; sha: string };
          const key = body.ref.replace(/^refs\//, '');
          if (!r) return notFound();
          if (r.repo.refs.has(key)) return json({ message: 'Reference already exists' }, 422);
          r.repo.refs.set(key, body.sha);
          return json({ ref: body.ref, object: { sha: body.sha } }, 201);
        },
      },
      {
        method: 'PATCH',
        path: /^\/repos\/forge-org\/[^/]+\/git\/refs\/(.+)$/,
        handler: (call) => {
          const r = this.repoOf(call.path);
          const key = /\/git\/refs\/(.+)$/.exec(call.path)?.[1] ?? '';
          const body = call.body as { sha: string; force: boolean };
          if (!r) return notFound();
          if (this.failNextRefPatch) {
            this.failNextRefPatch = false;
            return json({ message: 'Update is not a fast forward' }, 422);
          }
          r.repo.refs.set(key, body.sha);
          return json({ ref: `refs/${key}`, object: { sha: body.sha } });
        },
      },
      {
        method: 'PUT',
        path: /^\/repos\/forge-org\/[^/]+\/branches\/[^/]+\/protection$/,
        handler: () =>
          this.protectionStatus === 200
            ? json({ url: 'x' })
            : json(
                {
                  message:
                    'Upgrade to GitHub Pro or make this repository public to enable this feature.',
                },
                403,
              ),
      },
    ];
  }

  private restoreMain(repo: FakeRepo): void {
    const first = [...repo.commits.keys()][0];
    if (first) repo.refs.set(`heads/${repo.defaultBranch}`, first);
  }
}

function makeClient(gh: FakeGithub, extra: Record<string, unknown> = {}): GithubClient {
  return createGithubClient({
    appId: '12345',
    privateKey,
    org: ORG,
    fetch: gh.stub.fetch,
    now: () => gh.nowMs,
    sleep: async () => {},
    random: () => 0,
    retryBaseMs: 10,
    ...extra,
  });
}

// ---------------------------------------------------------------------------------------------

describe('names and paths', () => {
  it('derives the repo name from a valid slug', () => {
    expect(repoNameForSlug('moonpad')).toBe('lp-moonpad');
    expect(repoNameForSlug('a1-b2')).toBe('lp-a1-b2');
  });

  it.each([
    'ab',
    'Moon',
    '-moon',
    'moon-',
    'mo--on',
    'moon pad',
    'moon/pad',
    'a'.repeat(33),
    '../x',
    '',
  ])('rejects slug %j', (slug) => {
    expect(() => repoNameForSlug(slug)).toThrow(/slug/);
  });

  it('accepts safe branch names and rejects the rest', () => {
    expect(encodeBranch('forge/3f2b8c1e-9d4a')).toBe('forge/3f2b8c1e-9d4a');
    for (const bad of [
      '',
      '/x',
      'x/',
      'a..b',
      'a//b',
      '.hidden',
      'a/.b',
      'a b',
      'x.lock',
      'a?b',
      'a#b',
    ]) {
      expect(() => encodeBranch(bad)).toThrow(/branch/);
    }
  });

  it('rejects unsafe file paths', () => {
    expect(assertRepoPath('src/theme/a.css')).toBe('src/theme/a.css');
    for (const bad of [
      '',
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      '.git/config',
      'a/.GIT/x',
      'a\\b',
      'a\0b',
      './a',
    ]) {
      expect(() => assertRepoPath(bad)).toThrow(/path/);
    }
  });

  it('computes git blob ids like git', () => {
    // `printf 'hello' | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });
});

describe('githubOptionsFromEnv', () => {
  it('reads the key file named by GITHUB_APP_PRIVATE_KEY_PATH', () => {
    const o = githubOptionsFromEnv(
      { GITHUB_APP_ID: '123', GITHUB_ORG: ORG, GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem' },
      (p) => {
        expect(p).toBe('/k.pem');
        return '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
      },
    );
    expect(o).toMatchObject({ appId: '123', org: ORG });
    expect(o.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('accepts an inline key with escaped newlines', () => {
    const o = githubOptionsFromEnv({
      GITHUB_APP_ID: '123',
      GITHUB_ORG: ORG,
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    expect(o.privateKey.split('\n')).toHaveLength(3);
  });

  it('fails clearly without leaking values', () => {
    expect(() => githubOptionsFromEnv({ GITHUB_ORG: ORG })).toThrow(/GITHUB_APP_ID/);
    expect(() => githubOptionsFromEnv({ GITHUB_APP_ID: '1', GITHUB_ORG: ORG })).toThrow(/PEM/);
    expect(() =>
      githubOptionsFromEnv(
        { GITHUB_APP_ID: '1', GITHUB_ORG: ORG, GITHUB_APP_PRIVATE_KEY_PATH: '/nope' },
        () => {
          throw new Error('ENOENT');
        },
      ),
    ).toThrow(/cannot read/);
  });
});

describe('createAppJwt', () => {
  it('signs RS256 with iss, a backdated iat and a short exp', () => {
    const jwt = createAppJwt('12345', privateKey, 1_700_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '12345' });
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(createPublicKey(publicKey), Buffer.from(s ?? '', 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('installation tokens', () => {
  it('sends the app JWT to find the installation and mint a repo-scoped token', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await client.getBranchHead('lp-moonpad', 'main');

    const inst = gh.stub.find('GET', `/orgs/${ORG}/installation`)[0];
    expect(inst?.headers['authorization']).toMatch(/^Bearer eyJ/);
    const mint = gh.stub.find('POST', '/app/installations/42/access_tokens')[0];
    expect(mint?.body).toEqual({
      repositories: ['lp-moonpad'],
      permissions: { contents: 'read' },
    });
    const ref = gh.stub.find('GET', /\/git\/ref\//)[0];
    expect(ref?.headers['authorization']).toBe(`Bearer ${gh.tokens[0]}`);
    expect(ref?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('caches tokens until shortly before expiry, then mints a new one', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await client.getBranchHead('lp-moonpad', 'main');
    await client.getBranchHead('lp-moonpad', 'main');
    expect(gh.tokens).toHaveLength(1);

    gh.nowMs += 3_600_000 - 60_000; // 1 minute left: inside the refresh margin
    await client.getBranchHead('lp-moonpad', 'main');
    expect(gh.tokens).toHaveLength(2);
    // The installation id is looked up once.
    expect(gh.stub.find('GET', `/orgs/${ORG}/installation`)).toHaveLength(1);
  });

  it('mints one token for concurrent callers', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await Promise.all([
      client.getBranchHead('lp-moonpad', 'main'),
      client.getBranchHead('lp-moonpad', 'main'),
      client.getBranchHead('lp-moonpad', 'main'),
    ]);
    expect(gh.tokens).toHaveLength(1);
  });

  it('uses a separate token per repo', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-one');
    gh.addRepo('lp-two');
    const client = makeClient(gh);
    await client.getBranchHead('lp-one', 'main');
    await client.getBranchHead('lp-two', 'main');
    expect(gh.tokens).toHaveLength(2);
  });

  it('drops the cache and retries once when GitHub rejects a cached token', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    let rejected = false;
    const flaky = stubFetch([
      {
        method: 'GET',
        path: /\/git\/ref\//,
        handler: (call) => {
          if (!rejected && call.headers['authorization'] === `Bearer ${gh.tokens[0]}`) {
            rejected = true;
            return json({ message: 'Bad credentials' }, 401);
          }
          return gh.stub.fetch(`https://api.github.com${call.url}`, {
            method: 'GET',
            headers: call.headers,
          });
        },
      },
      {
        method: 'POST',
        path: '/app/installations/42/access_tokens',
        handler: (call) =>
          gh.stub.fetch(`https://api.github.com${call.url}`, {
            method: 'POST',
            headers: call.headers,
            body: JSON.stringify(call.body),
          }),
      },
      {
        method: 'GET',
        path: `/orgs/${ORG}/installation`,
        handler: (call) =>
          gh.stub.fetch(`https://api.github.com${call.url}`, { headers: call.headers }),
      },
    ]);
    const client = createGithubClient({
      appId: '1',
      privateKey,
      org: ORG,
      fetch: flaky.fetch,
      now: () => gh.nowMs,
      sleep: async () => {},
    });
    const sha = await client.getBranchHead('lp-moonpad', 'main');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(gh.tokens).toHaveLength(2);
  });

  it('exposes a repo token for the builder, without leaking it into the cache key logic', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const t = await makeClient(gh).createRepoToken('lp-moonpad');
    expect(t.token).toBe(gh.tokens[0]);
    expect(t.expiresAt).toBe(NOW + 3_600_000);
  });
});

describe('ensureRepoFromTemplate', () => {
  it('generates a private repo from the template and waits for the default branch', async () => {
    const gh = new FakeGithub();
    gh.readinessDelay = 2;
    const sleeps: number[] = [];
    const client = makeClient(gh, { sleep: async (ms: number) => void sleeps.push(ms) });
    const { repo, created } = await client.ensureRepoFromTemplate({ slug: 'moonpad' });
    expect(created).toBe(true);
    expect(repo).toMatchObject({
      name: 'lp-moonpad',
      fullName: `${ORG}/lp-moonpad`,
      private: true,
    });
    const gen = gh.stub.find('POST', `/repos/${ORG}/launchpad-template/generate`)[0];
    expect(gen?.body).toEqual({
      owner: ORG,
      name: 'lp-moonpad',
      description: 'FORGE launchpad moonpad',
      private: true,
      include_all_branches: false,
    });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second call reuses the repo and does not generate again', async () => {
    const gh = new FakeGithub();
    const client = makeClient(gh);
    await client.ensureRepoFromTemplate({ slug: 'moonpad' });
    const again = await client.ensureRepoFromTemplate({ slug: 'moonpad' });
    expect(again.created).toBe(false);
    expect(gh.stub.find('POST', `/repos/${ORG}/launchpad-template/generate`)).toHaveLength(1);
  });

  it('refuses to reuse a public repo or one that did not come from the template', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-pub', { private: false });
    gh.addRepo('lp-foreign', { template: 'someone/else' });
    const client = makeClient(gh);
    await expect(client.ensureRepoFromTemplate({ slug: 'pub' })).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(client.ensureRepoFromTemplate({ slug: 'foreign' })).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect(gh.stub.find('POST', /generate$/)).toHaveLength(0);
  });

  it('does not fail while GitHub has not linked a fresh repo to its template yet', async () => {
    const gh = new FakeGithub();
    gh.templateLinkDelay = 3;
    const sleeps: number[] = [];
    const client = makeClient(gh, { sleep: async (ms: number) => void sleeps.push(ms) });
    // First call: the generate response has no template link yet.
    expect(await client.ensureRepoFromTemplate({ slug: 'moonpad' })).toMatchObject({
      created: true,
    });
    // A retry right after: the repo exists and still shows no link for two more reads.
    const again = await client.ensureRepoFromTemplate({ slug: 'moonpad' });
    expect(again).toMatchObject({ created: false, repo: { templateFullName: TEMPLATE } });
    expect(sleeps.filter((ms) => ms === 1500).length).toBeGreaterThanOrEqual(2);
    expect(gh.stub.find('POST', `/repos/${ORG}/launchpad-template/generate`)).toHaveLength(1);
  });

  it('reads an existing repo with a token that can see the template link', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const { repo, created } = await makeClient(gh).ensureRepoFromTemplate({ slug: 'moonpad' });
    expect(created).toBe(false);
    expect(repo.templateFullName).toBe(TEMPLATE);
    const scoped = gh.mints.map((m) => m.body?.repositories).filter(Boolean);
    expect(scoped).toContainEqual(['lp-moonpad', 'launchpad-template']);
  });

  it('waits while a generated repo answers 409 "Git Repository is empty"', async () => {
    const gh = new FakeGithub();
    gh.readinessDelay = 2;
    gh.emptyRepoStatus = 409;
    const { created } = await makeClient(gh, { sleep: async () => {} }).ensureRepoFromTemplate({
      slug: 'moonpad',
    });
    expect(created).toBe(true);
  });

  it('refuses an existing repo that never shows a template link', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-bare', { template: null });
    const sleeps: number[] = [];
    const client = makeClient(gh, { sleep: async (ms: number) => void sleeps.push(ms) });
    await expect(client.ensureRepoFromTemplate({ slug: 'bare' })).rejects.toMatchObject({
      kind: 'conflict',
      message: expect.stringContaining('was not generated from'),
    });
    expect(sleeps).toHaveLength(10);
    expect(gh.stub.find('POST', /generate$/)).toHaveLength(0);
  });

  it('recovers when the repo appears between the check and the creation (422)', async () => {
    const gh = new FakeGithub();
    gh.generateStatus = 422;
    const client = makeClient(gh);
    // The repo "appears" right when generate answers 422.
    const route = gh.stub.calls; // keep reference for assertions
    const original = gh.stub.fetch;
    let raced = false;
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await original(input, init);
      if (!raced && res.status === 422) {
        raced = true;
        gh.addRepo('lp-moonpad');
      }
      return res;
    }) as typeof fetch;
    const c2 = createGithubClient({
      appId: '1',
      privateKey,
      org: ORG,
      fetch: wrapped,
      now: () => gh.nowMs,
      sleep: async () => {},
    });
    const out = await c2.ensureRepoFromTemplate({ slug: 'moonpad' });
    expect(out).toMatchObject({ created: false });
    expect(route.length).toBeGreaterThan(0);
    void client;
  });

  it('reports a missing template clearly', async () => {
    const gh = new FakeGithub();
    gh.generateStatus = 404;
    await expect(makeClient(gh).ensureRepoFromTemplate({ slug: 'moonpad' })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('template'),
    });
  });

  it('validates the slug before any request', async () => {
    const gh = new FakeGithub();
    await expect(makeClient(gh).ensureRepoFromTemplate({ slug: 'Bad Slug' })).rejects.toMatchObject(
      {
        kind: 'invalid_input',
      },
    );
    expect(gh.stub.calls).toHaveLength(0);
  });

  it('reads the template repository', async () => {
    const gh = new FakeGithub();
    const t = await makeClient(gh).getTemplateRepo();
    expect(t).toMatchObject({ name: 'launchpad-template', isTemplate: true });
  });
});

describe('resetJobBranch', () => {
  async function setup() {
    const gh = new FakeGithub();
    const repo = gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    const main0 = repo.refs.get('heads/main')!;
    // Attempt 1: a job commit on top of main0.
    const first = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Attempt 1',
      files: [{ path: 'src/content/a.md', content: 'one' }],
    });
    // The default branch moves.
    const moved = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'main',
      message: 'Mode commit',
      files: [{ path: 'README.md', content: 'moved' }],
    });
    return { gh, repo, client, main0, first: first.commitSha, main1: moved.commitSha };
  }

  it('regression: moves a job branch left on an older default branch back to the new base', async () => {
    const { gh, repo, client, main1 } = await setup();
    const patches = gh.stub.find('PATCH', /\/git\/refs\//).length;
    expect(await client.resetJobBranch('lp-moonpad', 'forge/job1', main1)).toEqual({
      reset: true,
    });
    expect(repo.refs.get('heads/forge/job1')).toBe(main1);
    const patch = gh.stub.find('PATCH', /\/git\/refs\//).slice(patches);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.path).toBe('/repos/forge-org/lp-moonpad/git/refs/heads/forge/job1');
    expect(patch[0]!.body).toEqual({ sha: main1, force: true });
    // The next commit then starts from the new base.
    const next = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Attempt 2',
      files: [{ path: 'src/content/a.md', content: 'two' }],
    });
    expect(repo.commits.get(next.commitSha)?.parents).toEqual([main1]);
    expect(repo.refs.get('heads/main')).toBe(main1);
  });

  it('leaves a branch alone when it already starts from the base, sits on it, or is missing', async () => {
    const { gh, client, main0, main1 } = await setup();
    const before = gh.stub.find('PATCH', /\/git\/refs\//).length;
    expect(await client.resetJobBranch('lp-moonpad', 'forge/job1', main0)).toEqual({
      reset: false,
    });
    expect(await client.resetJobBranch('lp-moonpad', 'forge/missing', main1)).toEqual({
      reset: false,
    });
    await client.resetJobBranch('lp-moonpad', 'forge/job1', main1);
    expect(await client.resetJobBranch('lp-moonpad', 'forge/job1', main1)).toEqual({
      reset: false,
    });
    expect(gh.stub.find('PATCH', /\/git\/refs\//).length).toBe(before + 1);
  });

  it('never resets the default branch or a branch that is not a job branch', async () => {
    const { gh, client, main0 } = await setup();
    const before = gh.stub.calls.length;
    for (const branch of ['main', 'release', 'forge', 'forge/', 'forge/a/b', 'x/forge/job1']) {
      await expect(
        client.resetJobBranch('lp-moonpad', branch, main0),
        branch,
      ).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(client.resetJobBranch('lp-moonpad', 'forge/job1', 'nope')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(gh.stub.calls.slice(before).filter((c) => c.method === 'PATCH')).toHaveLength(0);
    // A repo whose default branch is itself named like a job branch.
    gh.addRepo('lp-odd', { defaultBranch: 'forge/main' });
    await expect(client.resetJobBranch('lp-odd', 'forge/main', main0)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });
});

describe('commitFiles', () => {
  async function setup() {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    return { gh, client: makeClient(gh) };
  }

  it('creates the branch from main with only the changed blobs and a single commit', async () => {
    const { gh, client } = await setup();
    const res = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Design for job1',
      files: [
        { path: 'README.md', content: 'hi' }, // unchanged
        { path: 'src/theme/theme.css', content: 'new' }, // modified
        { path: 'src/content/about.md', content: 'about' }, // added
      ],
    });
    expect(res).toMatchObject({
      committed: true,
      branchCreated: true,
      changedPaths: ['src/content/about.md', 'src/theme/theme.css'],
      deletedPaths: [],
    });
    expect(gh.stub.find('POST', /\/git\/blobs$/)).toHaveLength(2);
    const repo = gh.repos.get('lp-moonpad');
    expect(repo?.refs.get('heads/forge/job1')).toBe(res.commitSha);
    const commit = repo?.commits.get(res.commitSha);
    expect(commit?.parents).toEqual([repo?.refs.get('heads/main')]);
    expect(commit?.message).toBe('Design for job1');
    // The agent branch never touches main.
    expect(repo?.commits.get(repo.refs.get('heads/main') ?? '')?.message).toBe('init');
  });

  it('is idempotent: pushing the same files again creates no commit and no blob', async () => {
    const { gh, client } = await setup();
    const input = {
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Design',
      files: [{ path: 'src/theme/theme.css', content: 'new' }],
    };
    const first = await client.commitFiles(input);
    const blobs = gh.stub.find('POST', /\/git\/blobs$/).length;
    const commits = gh.stub.find('POST', /\/git\/commits$/).length;
    const second = await client.commitFiles(input);
    expect(second).toMatchObject({
      committed: false,
      commitSha: first.commitSha,
      branchCreated: false,
    });
    expect(gh.stub.find('POST', /\/git\/blobs$/)).toHaveLength(blobs);
    expect(gh.stub.find('POST', /\/git\/commits$/)).toHaveLength(commits);
  });

  it('adds a second commit on an existing branch with the previous head as parent', async () => {
    const { gh, client } = await setup();
    const first = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'one',
      files: [{ path: 'a.txt', content: '1' }],
    });
    const second = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'two',
      files: [{ path: 'a.txt', content: '2' }],
    });
    expect(second.committed).toBe(true);
    expect(gh.repos.get('lp-moonpad')?.commits.get(second.commitSha)?.parents).toEqual([
      first.commitSha,
    ]);
  });

  it('mirrors the workdir with deleteMissing and supports explicit deletions', async () => {
    const { gh, client } = await setup();
    const res = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'mirror',
      files: [
        { path: 'README.md', content: 'hi' },
        { path: 'src/theme/theme.css', content: 'old' },
      ],
      deleteMissing: true,
    });
    expect(res.deletedPaths).toEqual(['src/old.ts']);
    expect(res.changedPaths).toEqual([]);
    const repo = gh.repos.get('lp-moonpad');
    const tree = repo?.trees.get(repo.commits.get(res.commitSha)?.tree ?? '');
    expect([...(tree?.keys() ?? [])].sort()).toEqual(['README.md', 'src/theme/theme.css']);

    const res2 = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job2',
      message: 'explicit',
      files: [],
      deletePaths: ['README.md', 'not-there.txt'],
    });
    expect(res2.deletedPaths).toEqual(['README.md']);
  });

  it('only creates the branch when nothing changed', async () => {
    const { gh, client } = await setup();
    const res = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'noop',
      files: [{ path: 'README.md', content: 'hi' }],
    });
    expect(res).toMatchObject({ committed: false, branchCreated: true });
    expect(gh.repos.get('lp-moonpad')?.refs.get('heads/forge/job1')).toBe(
      gh.repos.get('lp-moonpad')?.refs.get('heads/main'),
    );
  });

  it('sets the executable bit when asked', async () => {
    const { gh, client } = await setup();
    await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'exec',
      files: [{ path: 'run.sh', content: '#!/bin/sh', executable: true }],
    });
    const tree = gh.stub.find('POST', /\/git\/trees$/)[0]?.body as {
      tree: Array<{ mode: string }>;
    };
    expect(tree.tree[0]?.mode).toBe('100755');
  });

  it('fails with a conflict when the branch moved meanwhile, never forcing', async () => {
    const { gh, client } = await setup();
    await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'one',
      files: [{ path: 'a', content: '1' }],
    });
    gh.failNextRefPatch = true;
    await expect(
      client.commitFiles({
        repo: 'lp-moonpad',
        branch: 'forge/job1',
        message: 'two',
        files: [{ path: 'a', content: '2' }],
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const patch = gh.stub.find('PATCH', /\/git\/refs\//)[0];
    expect(patch?.body).toMatchObject({ force: false });
  });

  it('commits only on top of the expected head (compare-and-swap)', async () => {
    const { gh, client } = await setup();
    const main = gh.repos.get('lp-moonpad')!.refs.get('heads/main')!;
    const ok = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'main',
      message: 'mode',
      files: [{ path: 'a', content: '1' }],
      expectedHeadSha: main,
    });
    expect(ok.committed).toBe(true);
    const commitsBefore = gh.stub.find('POST', /\/git\/commits$/).length;
    // The caller read `main` before the commit above: its write is refused.
    await expect(
      client.commitFiles({
        repo: 'lp-moonpad',
        branch: 'main',
        message: 'stale',
        files: [{ path: 'a', content: '2' }],
        expectedHeadSha: main,
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    // A missing branch does not match either.
    await expect(
      client.commitFiles({
        repo: 'lp-moonpad',
        branch: 'forge/none',
        message: 'x',
        files: [{ path: 'a', content: '2' }],
        expectedHeadSha: main,
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(gh.stub.find('POST', /\/git\/commits$/)).toHaveLength(commitsBefore);
    await expect(
      client.commitFiles({
        repo: 'lp-moonpad',
        branch: 'main',
        message: 'x',
        files: [],
        expectedHeadSha: 'main',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects invalid input before touching the API', async () => {
    const { gh, client } = await setup();
    const base = { repo: 'lp-moonpad', branch: 'forge/job1', message: 'm' };
    await expect(
      client.commitFiles({ ...base, files: [{ path: '../evil', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.commitFiles({ ...base, files: [{ path: '.git/config', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.commitFiles({
        ...base,
        files: [
          { path: 'a', content: '1' },
          { path: 'a', content: '2' },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      client.commitFiles({
        ...base,
        files: [{ path: 'a', content: 'x'.repeat(5 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.commitFiles({ ...base, message: '  ', files: [] })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(client.commitFiles({ ...base, repo: 'forge', files: [] })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(client.commitFiles({ ...base, branch: 'a..b', files: [] })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(
      client.commitFiles({ ...base, files: [{ path: 'a', content: '1' }], deletePaths: ['a'] }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(gh.stub.calls).toHaveLength(0);
  });

  it('reports a missing base branch', async () => {
    const { client } = await setup();
    await expect(
      client.commitFiles({
        repo: 'lp-moonpad',
        branch: 'forge/x',
        baseBranch: 'nope',
        message: 'm',
        files: [{ path: 'a', content: '1' }],
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('retries a transient 5xx while uploading', async () => {
    const gh = new FakeGithub([
      {
        method: 'POST',
        path: /\/git\/blobs$/,
        times: 1,
        handler: () => json({ message: 'unavailable' }, 503),
      },
    ]);
    gh.addRepo('lp-moonpad');
    const res = await makeClient(gh).commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'm',
      files: [{ path: 'a', content: '1' }],
    });
    expect(res.committed).toBe(true);
    expect(gh.stub.find('POST', /\/git\/blobs$/)).toHaveLength(2);
  });
});

describe('compare, read, merge, delete', () => {
  const sha = (c: string) => c.repeat(40);

  const compareBody = (files: unknown[], over: Record<string, unknown> = {}) => ({
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    merge_base_commit: { sha: sha('b') },
    // Paginated commit list: the last one of the page is NOT the head.
    commits: [{ sha: sha('c') }],
    files,
    ...over,
  });

  it('pins the head sha first and reads the files from a single compare call', async () => {
    const file = (n: number) => ({
      filename: `f${n}.ts`,
      status: n === 0 ? 'renamed' : 'modified',
      previous_filename: n === 0 ? 'old.ts' : undefined,
      additions: 1,
      deletions: 2,
      patch: '@@ -1 +1 @@',
      sha: sha('a'),
    });
    const head = sha('d');
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-moonpad\/compare\//,
        handler: () => json(compareBody(Array.from({ length: 101 }, (_, i) => file(i)))),
      },
    ]);
    const repo = gh.addRepo('lp-moonpad');
    repo.refs.set('heads/forge/job1', head);
    const out = await makeClient(gh).compareCommits('lp-moonpad', 'main', 'forge/job1');
    expect(out).toMatchObject({
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      mergeBaseSha: sha('b'),
      headSha: head,
      source: 'compare',
    });
    expect(out.files).toHaveLength(101);
    expect(out.files[0]).toMatchObject({
      path: 'f0.ts',
      status: 'renamed',
      previousPath: 'old.ts',
    });
    const calls = gh.stub.find('GET', /compare/);
    expect(calls).toHaveLength(1);
    // Compared against the pinned sha, not the moving branch name.
    expect(calls[0]?.path).toBe(`/repos/${ORG}/lp-moonpad/compare/main...${head}`);
    expect(calls[0]?.query.get('page')).toBe('1');
  });

  it('compares by sha too and reports the requested head, not the merge base', async () => {
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: `/repos/${ORG}/lp-moonpad/compare/${sha('a')}...${sha('b')}`,
        handler: () =>
          json({
            status: 'identical',
            ahead_by: 0,
            behind_by: 0,
            total_commits: 0,
            merge_base_commit: { sha: sha('a') },
            files: [],
          }),
      },
    ]);
    gh.addRepo('lp-moonpad');
    const out = await makeClient(gh).compareCommits('lp-moonpad', sha('a'), sha('b'));
    expect(out).toMatchObject({ status: 'identical', files: [], headSha: sha('b') });
  });

  it('refuses an unknown head branch', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    await expect(
      makeClient(gh).compareCommits('lp-moonpad', 'main', 'forge/nope'),
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(gh.stub.find('GET', /compare/)).toHaveLength(0);
  });

  it('at the 300-file cap, rebuilds the complete list from the two trees', async () => {
    let mergeBase = '';
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-moonpad\/compare\//,
        handler: () =>
          json(
            compareBody(
              Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added' })),
              { merge_base_commit: { sha: mergeBase } },
            ),
          ),
      },
    ]);
    const repo = gh.addRepo('lp-moonpad');
    mergeBase = repo.refs.get('heads/main') ?? '';
    const client = makeClient(gh);
    const files = Array.from({ length: 320 }, (_, i) => ({
      path: `gen/f${i}.ts`,
      content: `${i}`,
    }));
    const commit = await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Many files',
      files: [{ path: 'README.md', content: 'hi' }, ...files],
      deletePaths: ['src/old.ts'],
    });
    const out = await client.compareCommits('lp-moonpad', 'main', 'forge/job1');
    expect(out.source).toBe('tree');
    expect(out.headSha).toBe(commit.commitSha);
    // 320 added + 1 removed; the unchanged README is not listed.
    expect(out.files).toHaveLength(321);
    expect(out.files.find((f) => f.path === 'src/old.ts')).toMatchObject({ status: 'removed' });
    expect(out.files.find((f) => f.path === 'gen/f319.ts')).toMatchObject({
      status: 'added',
      patch: undefined,
    });
    expect(out.files.some((f) => f.path === 'README.md')).toBe(false);
  });

  it('refuses when the tree used for the fallback is truncated', async () => {
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-moonpad\/compare\//,
        handler: () =>
          json(
            compareBody(
              Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added' })),
            ),
          ),
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-moonpad\/git\/commits\/[0-9a-f]{40}$/,
        handler: () => json({ sha: sha('e'), tree: { sha: sha('f') } }),
      },
      {
        method: 'GET',
        path: /^\/repos\/forge-org\/lp-moonpad\/git\/trees\/[0-9a-f]{40}$/,
        handler: () => json({ sha: sha('f'), truncated: true, tree: [] }),
      },
    ]);
    gh.addRepo('lp-moonpad');
    await expect(
      makeClient(gh).compareCommits('lp-moonpad', sha('a'), sha('d')),
    ).rejects.toMatchObject({ kind: 'unexpected', message: expect.stringContaining('too large') });
  });

  it('reads a file, or null when absent', async () => {
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: `/repos/${ORG}/lp-moonpad/contents/forge.config.json`,
        handler: (call) =>
          call.query.get('ref') === 'main'
            ? json({
                type: 'file',
                encoding: 'base64',
                content: Buffer.from('{"a":1}').toString('base64'),
              })
            : json({ message: 'Not Found' }, 404),
      },
    ]);
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await expect(client.readFile('lp-moonpad', 'forge.config.json', 'main')).resolves.toBe(
      '{"a":1}',
    );
    await expect(client.readFile('lp-moonpad', 'forge.config.json', 'other')).resolves.toBeNull();
    await expect(client.readFile('lp-moonpad', '../x', 'main')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('merges a branch: 201 merged, 204 already merged, 409 conflict', async () => {
    let step = 0;
    const gh = new FakeGithub([
      {
        method: 'POST',
        path: `/repos/${ORG}/lp-moonpad/merges`,
        handler: () => {
          step++;
          if (step === 1) return json({ sha: sha('e') }, 201);
          if (step === 2) return empty(204);
          return json({ message: 'Merge conflict' }, 409);
        },
      },
    ]);
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    const input = { base: 'main', head: 'forge/job1', message: 'Merge forge/job1' };
    await expect(client.mergeBranch('lp-moonpad', input)).resolves.toEqual({
      merged: true,
      sha: sha('e'),
    });
    const body = gh.stub.find('POST', /merges$/)[0]?.body;
    expect(body).toEqual({ base: 'main', head: 'forge/job1', commit_message: 'Merge forge/job1' });
    const noop = await client.mergeBranch('lp-moonpad', input);
    expect(noop.merged).toBe(false);
    expect(noop.sha).toBe(gh.repos.get('lp-moonpad')?.refs.get('heads/main'));
    await expect(client.mergeBranch('lp-moonpad', input)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('deletes a branch, tolerating one that is already gone', async () => {
    const gh = new FakeGithub([
      {
        method: 'DELETE',
        path: /\/git\/refs\/heads\/forge\/job1$/,
        times: 1,
        handler: () => empty(204),
      },
      {
        method: 'DELETE',
        path: /\/git\/refs\/heads\/forge\/job1$/,
        handler: () => json({ message: 'Reference does not exist' }, 422),
      },
    ]);
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await expect(client.deleteBranch('lp-moonpad', 'forge/job1')).resolves.toBe(true);
    await expect(client.deleteBranch('lp-moonpad', 'forge/job1')).resolves.toBe(false);
  });
});

describe('commit trees for deployments (listCommitTree, readBlobs)', () => {
  const ROOT = `/repos/${ORG}/lp-moonpad`;
  const COMMIT = 'c'.repeat(40);
  const TREE = 'e'.repeat(40);
  const files = {
    'package.json': Buffer.from('{"name":"lp-moonpad"}\n'),
    'src/pages/index.tsx': Buffer.from('export default () => null;\n'),
    'scripts/check.sh': Buffer.from('#!/bin/sh\nexit 0\n'),
  };
  const blobs = new Map(Object.values(files).map((c) => [gitBlobSha(c), c]));
  type TreeItem = { path: string; mode: string; type: string; sha: string; size?: number };
  const regular: TreeItem[] = [
    { path: 'scripts', mode: '040000', type: 'tree', sha: 'd'.repeat(40) },
    ...Object.entries(files).map(([path, c]) => ({
      path,
      mode: path.endsWith('.sh') ? '100755' : '100644',
      type: 'blob',
      sha: gitBlobSha(c),
      size: c.byteLength,
    })),
  ];

  function setup(
    tree: TreeItem[] = regular,
    opts: {
      truncated?: boolean;
      commitSha?: string;
      blob?: (sha: string) => Response | Promise<Response>;
    } = {},
  ) {
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: `${ROOT}/git/commits/${COMMIT}`,
        handler: () => json({ sha: opts.commitSha ?? COMMIT, tree: { sha: TREE }, parents: [] }),
      },
      {
        method: 'GET',
        path: `${ROOT}/git/trees/${TREE}`,
        handler: () => json({ sha: TREE, truncated: opts.truncated ?? false, tree }),
      },
      {
        method: 'GET',
        path: new RegExp(`^${ROOT}/git/blobs/[0-9a-f]{40}$`),
        handler: (call) => {
          const sha = call.path.split('/').pop()!;
          if (opts.blob) return opts.blob(sha);
          const content = blobs.get(sha);
          return content
            ? json({
                sha,
                size: content.byteLength,
                encoding: 'base64',
                // GitHub wraps the base64 content in lines.
                content: content.toString('base64').replace(/(.{8})/g, '$1\n'),
              })
            : json({ message: 'Not Found' }, 404);
        },
      },
    ]);
    gh.addRepo('lp-moonpad');
    return { gh, client: makeClient(gh) };
  }

  /** Mint body of the token that authorized a call. */
  const mintFor = (gh: FakeGithub, call: { headers: Record<string, string> } | undefined) =>
    gh.mints.find((m) => `Bearer ${m.token}` === call?.headers['authorization'])?.body;

  it('lists the regular files of a commit with a read-only token scoped to the repo', async () => {
    const { gh, client } = setup();
    const tree = await client.listCommitTree('lp-moonpad', COMMIT);
    expect(tree).toEqual({
      commitSha: COMMIT,
      treeSha: TREE,
      files: [
        {
          path: 'package.json',
          blobSha: gitBlobSha(files['package.json']),
          size: files['package.json'].byteLength,
          executable: false,
        },
        {
          path: 'src/pages/index.tsx',
          blobSha: gitBlobSha(files['src/pages/index.tsx']),
          size: files['src/pages/index.tsx'].byteLength,
          executable: false,
        },
        {
          path: 'scripts/check.sh',
          blobSha: gitBlobSha(files['scripts/check.sh']),
          size: files['scripts/check.sh'].byteLength,
          executable: true,
        },
      ],
      totalBytes: Object.values(files).reduce((n, c) => n + c.byteLength, 0),
    });
    const treeCall = gh.stub.find('GET', `${ROOT}/git/trees/${TREE}`)[0];
    expect(treeCall?.query.get('recursive')).toBe('1');
    for (const call of gh.stub.calls.filter((c) => c.path.startsWith(ROOT))) {
      expect(call.method).toBe('GET');
      expect(mintFor(gh, call)).toEqual({
        repositories: ['lp-moonpad'],
        permissions: { contents: 'read' },
      });
    }
  });

  it('refuses symlinks and submodules instead of skipping them', async () => {
    const symlink = setup([
      ...regular,
      { path: 'public/logo.svg', mode: '120000', type: 'blob', sha: 'a'.repeat(40), size: 9 },
    ]);
    await expect(symlink.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'unexpected',
      message: expect.stringMatching(/symlink.*public\/logo\.svg/) as unknown,
    });
    const submodule = setup([
      ...regular,
      { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'b'.repeat(40) },
    ]);
    await expect(submodule.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'unexpected',
      message: expect.stringMatching(/submodule.*vendor\/lib/) as unknown,
    });
    const odd = setup([
      ...regular,
      { path: 'x', mode: '100664', type: 'blob', sha: 'b'.repeat(40) },
    ]);
    await expect(odd.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'unexpected',
    });
  });

  it('refuses a truncated listing: the tree would be incomplete', async () => {
    const { client } = setup(regular, { truncated: true });
    await expect(client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'unexpected',
      message: expect.stringMatching(/too large.*truncated/) as unknown,
    });
  });

  it.each([
    '../x',
    'a/../b',
    '/etc/passwd',
    'a//b',
    './a',
    'a\\b',
    'a\u0000b',
    'a\nb',
    'pages/\u001b[31m.tsx',
    '.git/config',
    'src/.GIT/hooks',
    '',
  ])('refuses the unsafe path %j', async (path) => {
    const { client } = setup([
      ...regular,
      { path, mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 1 },
    ]);
    const err = (await client
      .listCommitTree('lp-moonpad', COMMIT)
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({
      kind: 'unexpected',
      message: expect.stringMatching(/unsafe path/),
    });
    // The path is quoted: no raw control character reaches a log line.
    expect([...err.message].filter((ch) => ch.charCodeAt(0) < 0x20)).toEqual([]);
  });

  it('refuses an unsafe directory entry too', async () => {
    const { client } = setup([{ path: '..', mode: '040000', type: 'tree', sha: 'd'.repeat(40) }]);
    await expect(client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      message: expect.stringMatching(/unsafe path/) as unknown,
    });
  });

  it('merges limit overrides, keeping the default for an absent or invalid one', () => {
    expect(treeLimits()).toEqual(TREE_LIMITS);
    expect(treeLimits({ maxFiles: undefined, maxFileBytes: -1, maxTotalBytes: 10 })).toEqual({
      ...TREE_LIMITS,
      maxTotalBytes: 10,
    });
    expect(treeLimits({ maxFiles: Number.NaN })).toEqual(TREE_LIMITS);
  });

  it('enforces the file count, file size and total size limits from the listing', async () => {
    const { client, gh } = setup();
    await expect(
      client.listCommitTree('lp-moonpad', COMMIT, { maxFiles: 2 }),
    ).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/too many/) });
    await expect(
      client.listCommitTree('lp-moonpad', COMMIT, { maxFileBytes: 20 }),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringMatching(/package\.json/) as unknown,
    });
    await expect(
      client.listCommitTree('lp-moonpad', COMMIT, { maxTotalBytes: 50 }),
    ).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/total/) });
    // Nothing downloaded to find out.
    expect(gh.stub.find('GET', /\/git\/blobs\//)).toHaveLength(0);
  });

  it('refuses malformed answers: no size, a bad blob id, another commit', async () => {
    const noSize = setup([{ path: 'a', mode: '100644', type: 'blob', sha: 'a'.repeat(40) }]);
    await expect(noSize.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    const badId = setup([{ path: 'a', mode: '100644', type: 'blob', sha: 'xyz', size: 1 }]);
    await expect(badId.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    const other = setup(regular, { commitSha: 'f'.repeat(40) });
    await expect(other.client.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('validates its input before any call, and never reads a denylisted repository', async () => {
    const { client, gh } = setup();
    await expect(client.listCommitTree('lp-moonpad', 'main')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(client.listCommitTree('Forge', COMMIT)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(client.readBlobs('lp-moonpad', ['nope'])).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    const denied = makeClient(gh, { repoDenylist: ['lp-moonpad'] });
    await expect(denied.listCommitTree('lp-moonpad', COMMIT)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(
      denied.readBlobs('lp-moonpad', [gitBlobSha(Buffer.from('x'))]),
    ).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(gh.stub.calls).toHaveLength(0);
  });

  it('reads blobs once each, read-only, checking every content against its id', async () => {
    const { client, gh } = setup();
    const ids = [...blobs.keys()];
    const out = await client.readBlobs('lp-moonpad', [...ids, ids[0]!]);
    expect([...out.keys()].sort()).toEqual([...ids].sort());
    for (const [id, content] of blobs) expect(out.get(id)?.equals(content)).toBe(true);
    const reads = gh.stub.find('GET', /\/git\/blobs\//);
    expect(reads).toHaveLength(3);
    for (const call of reads) {
      expect(mintFor(gh, call)).toEqual({
        repositories: ['lp-moonpad'],
        permissions: { contents: 'read' },
      });
    }
    await expect(client.readBlobs('lp-moonpad', [])).resolves.toEqual(new Map());
  });

  it('refuses a blob whose content does not match its id, or that is too large', async () => {
    const tampered = setup(regular, {
      blob: (sha) =>
        json({ sha, encoding: 'base64', content: Buffer.from('tampered').toString('base64') }),
    });
    await expect(
      tampered.client.readBlobs('lp-moonpad', [gitBlobSha(files['package.json'])]),
    ).rejects.toMatchObject({ kind: 'invalid_response', message: expect.stringMatching(/match/) });
    const plain = setup(regular, { blob: (sha) => json({ sha, encoding: 'utf-8', content: 'x' }) });
    await expect(
      plain.client.readBlobs('lp-moonpad', [gitBlobSha(files['package.json'])]),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    const { client } = setup();
    await expect(
      client.readBlobs('lp-moonpad', [gitBlobSha(files['package.json'])], { maxBlobBytes: 8 }),
    ).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/too large/) });
  });

  it('reads blobs with bounded concurrency and stops at the first failure', async () => {
    const many = Array.from({ length: 30 }, (_, i) => Buffer.from(`blob ${i}`));
    const byId = new Map(many.map((c) => [gitBlobSha(c), c]));
    let inflight = 0;
    let peak = 0;
    const { client } = setup(regular, {
      blob: async (sha) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        const content = byId.get(sha)!;
        return json({ sha, encoding: 'base64', content: content.toString('base64') });
      },
    });
    const out = await client.readBlobs('lp-moonpad', [...byId.keys()]);
    expect(out.size).toBe(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);

    let served = 0;
    const failing = setup(regular, {
      blob: (sha) => {
        served++;
        return served === 1
          ? json({ message: 'Not Found' }, 404)
          : json({ sha, encoding: 'base64', content: byId.get(sha)!.toString('base64') });
      },
    });
    await expect(failing.client.readBlobs('lp-moonpad', [...byId.keys()])).rejects.toMatchObject({
      kind: 'not_found',
    });
    // The other workers stop after their current read instead of fetching all 30.
    expect(served).toBeLessThan(30);
  });
});

describe('protectDefaultBranch', () => {
  it('applies the minimal rule set with a repo-scoped administration token', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const out = await makeClient(gh).protectDefaultBranch('lp-moonpad');
    expect(out).toEqual({ applied: true });
    const put = gh.stub.find('PUT', /protection$/)[0];
    expect(put?.path).toBe(`/repos/${ORG}/lp-moonpad/branches/main/protection`);
    expect(put?.body).toEqual({
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
    const mint = gh.stub.find('POST', '/app/installations/42/access_tokens').at(-1);
    expect(mint?.body).toEqual({
      repositories: ['lp-moonpad'],
      permissions: { administration: 'write' },
    });
  });

  it('degrades to applied:false when the plan does not offer it', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    gh.protectionStatus = 403;
    await expect(makeClient(gh).protectDefaultBranch('lp-moonpad')).resolves.toEqual({
      applied: false,
      reason: 'plan',
    });
  });

  it('degrades to applied:false when the App lacks the permission', async () => {
    const gh = new FakeGithub([
      {
        method: 'POST',
        path: '/app/installations/42/access_tokens',
        handler: (call) => {
          const perms = (call.body as { permissions?: Record<string, string> }).permissions;
          if (perms?.['administration']) {
            return json(
              { message: 'The permissions requested are not granted to this installation.' },
              422,
            );
          }
          return json(
            {
              token: 'ghs_ok0123456789abcdefghij',
              expires_at: new Date(NOW + 3_600_000).toISOString(),
            },
            201,
          );
        },
      },
    ]);
    gh.addRepo('lp-moonpad');
    await expect(makeClient(gh).protectDefaultBranch('lp-moonpad')).resolves.toEqual({
      applied: false,
      reason: 'permission',
    });
  });
});

describe('least-privilege tokens', () => {
  /** Mint body of the token that authorized a call. */
  const mintFor = (gh: FakeGithub, call: { headers: Record<string, string> } | undefined) =>
    gh.mints.find((m) => `Bearer ${m.token}` === call?.headers['authorization'])?.body;

  it('getRepo reads an existing repo with a repo-scoped metadata-only token', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    await expect(makeClient(gh).getRepo('lp-moonpad')).resolves.toMatchObject({
      name: 'lp-moonpad',
    });
    const get = gh.stub.find('GET', `/repos/${ORG}/lp-moonpad`)[0];
    expect(mintFor(gh, get)).toEqual({
      repositories: ['lp-moonpad'],
      permissions: { metadata: 'read' },
    });
  });

  it('getRepo checks a missing repo with an org-wide metadata-only token, never a full one', async () => {
    const gh = new FakeGithub();
    await expect(makeClient(gh).getRepo('lp-nope')).resolves.toBeNull();
    const get = gh.stub.find('GET', `/repos/${ORG}/lp-nope`)[0];
    expect(mintFor(gh, get)).toEqual({ permissions: { metadata: 'read' } });
    expect(gh.mints.every((m) => m.body.permissions !== undefined)).toBe(true);
  });

  it('commitFiles and protectDefaultBranch only use tokens scoped to the client repo', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-moonpad');
    const client = makeClient(gh);
    await client.commitFiles({
      repo: 'lp-moonpad',
      branch: 'forge/job1',
      message: 'Design',
      files: [{ path: 'src/a.ts', content: 'a' }],
    });
    await client.protectDefaultBranch('lp-moonpad');
    expect(gh.mints.length).toBeGreaterThan(0);
    for (const m of gh.mints) {
      expect(m.body.repositories).toEqual(['lp-moonpad']);
      expect(Object.keys(m.body.permissions ?? {})).toHaveLength(1);
    }
    // Protection alone gets administration; writes contents:write; the repo lookup metadata only.
    for (const call of gh.stub.calls.filter((c) => c.path.startsWith(`/repos/${ORG}/`))) {
      const perms = mintFor(gh, call)?.permissions;
      if (call.method === 'PUT') expect(perms).toEqual({ administration: 'write' });
      else if (call.method === 'POST' || call.method === 'PATCH') {
        expect(perms).toEqual({ contents: 'write' });
      } else expect(perms?.['administration']).toBeUndefined();
    }
    for (const call of gh.stub.find('GET', `/repos/${ORG}/lp-moonpad`)) {
      expect(mintFor(gh, call)?.permissions).toEqual({ metadata: 'read' });
    }
    expect(gh.stub.find('GET', `/repos/${ORG}/lp-moonpad`).length).toBeGreaterThan(0);
  });
});

describe('repository denylist', () => {
  it('refuses the FORGE monorepo as template, whatever the case', () => {
    for (const templateRepo of ['Forge', 'forge', 'FORGE']) {
      const gh = new FakeGithub();
      expect(() => makeClient(gh, { templateRepo })).toThrow(/protected/);
    }
  });

  it('refuses extra denylisted repos before any request or token mint', async () => {
    const gh = new FakeGithub();
    gh.addRepo('lp-secret');
    const client = makeClient(gh, { repoDenylist: ['lp-secret'] });
    await expect(client.getRepo('lp-secret')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.createRepoToken('LP-SECRET'.toLowerCase())).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    await expect(
      client.commitFiles({
        repo: 'lp-secret',
        branch: 'main',
        message: 'x',
        files: [{ path: 'a', content: 'a' }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.protectDefaultBranch('lp-secret')).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(gh.stub.calls).toHaveLength(0);
    // The default entry cannot be removed by configuration.
    expect(() => makeClient(gh, { repoDenylist: [], templateRepo: 'Forge' })).toThrow(/protected/);
  });

  it('reads extra entries from GITHUB_REPO_DENYLIST', () => {
    const env = {
      GITHUB_APP_ID: '12345',
      GITHUB_ORG: ORG,
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_REPO_DENYLIST: 'lp-secret, other-repo',
    };
    expect(githubOptionsFromEnv(env).repoDenylist).toEqual(['lp-secret', 'other-repo']);
    expect(() => githubOptionsFromEnv({ ...env, GITHUB_REPO_DENYLIST: 'a/b' })).toThrow(
      /GITHUB_REPO_DENYLIST/,
    );
  });
});

describe('read-only installation info', () => {
  it('returns the installation id, selection and permissions', async () => {
    const gh = new FakeGithub();
    await expect(makeClient(gh).getInstallation()).resolves.toEqual({
      id: 42,
      repositorySelection: 'all',
      permissions: { contents: 'write', administration: 'write' },
    });
  });
});

describe('logging hygiene', () => {
  it('onRetry events never carry credentials', async () => {
    const events: unknown[] = [];
    const gh = new FakeGithub([
      {
        method: 'GET',
        path: /\/git\/ref\//,
        times: 1,
        handler: () => json({ message: 'down' }, 502),
      },
    ]);
    gh.addRepo('lp-moonpad');
    await makeClient(gh, { onRetry: (e: unknown) => events.push(e) }).getBranchHead(
      'lp-moonpad',
      'main',
    );
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events);
    for (const t of gh.tokens) expect(serialized).not.toContain(t);
    expect(serialized).not.toContain('eyJ');
  });
});
