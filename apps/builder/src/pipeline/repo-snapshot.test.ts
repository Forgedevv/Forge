import { describe, expect, it } from 'vitest';
import { gitBlobSha } from '../github.js';
import { json, stubFetch, type Route } from '../http-mock.js';
import { createGithubRepoSource } from './repo-snapshot.js';

const ORG = 'forge-org';
const ROOT = `/repos/${ORG}/lp-moonpad`;
const HEAD = 'c'.repeat(40);
const TREE = 't'.repeat(40);

function blob(content: Buffer) {
  return { sha: gitBlobSha(content), content: content.toString('base64'), encoding: 'base64' };
}

const files = {
  'package.json': Buffer.from('{"name":"x"}\n'),
  'src/a.ts': Buffer.from('export const a = 1;\n'),
  'bin/run.sh': Buffer.from('#!/bin/sh\n'),
};

function routes(
  entries: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>,
  extra: { truncated?: boolean; corrupt?: boolean } = {},
): Route[] {
  const bySha = new Map(Object.values(files).map((c) => [gitBlobSha(c), c]));
  return [
    {
      method: 'GET',
      path: `${ROOT}/git/commits/${HEAD}`,
      handler: () => json({ sha: HEAD, tree: { sha: TREE } }),
    },
    {
      method: 'GET',
      path: `${ROOT}/git/trees/${TREE}`,
      handler: () => json({ sha: TREE, truncated: extra.truncated ?? false, tree: entries }),
    },
    {
      method: 'GET',
      path: new RegExp(`^${ROOT}/git/blobs/`),
      handler: (call) => {
        const sha = call.path.split('/').pop()!;
        const content = bySha.get(sha)!;
        return json(extra.corrupt ? blob(Buffer.from('tampered')) : { ...blob(content), sha });
      },
    },
  ];
}

const entries = Object.entries(files).map(([p, c]) => ({
  path: p,
  mode: p.endsWith('.sh') ? '100755' : '100644',
  type: 'blob',
  sha: gitBlobSha(c),
  size: c.byteLength,
}));

function source(stub: ReturnType<typeof stubFetch>, head: string | null = HEAD) {
  const tokens: string[] = [];
  const src = createGithubRepoSource({
    org: ORG,
    fetch: stub.fetch,
    sleep: async () => undefined,
    github: {
      getBranchHead: async () => head,
      createRepoToken: async (repo) => {
        tokens.push(repo);
        return { token: 'ghs_repo_scoped_token_value', expiresAt: Date.now() + 3_600_000 };
      },
    },
  });
  return { src, tokens };
}

describe('repository snapshot', () => {
  it('reads every file of the branch head with a repo-scoped token', async () => {
    const stub = stubFetch(
      routes([{ path: 'src', mode: '040000', type: 'tree', sha: 'd'.repeat(40) }, ...entries]),
    );
    const { src, tokens } = source(stub);
    const snap = await src.snapshot('lp-moonpad', 'main');
    expect(snap.commitSha).toBe(HEAD);
    expect(snap.files.map((f) => [f.path, f.executable])).toEqual([
      ['package.json', false],
      ['src/a.ts', false],
      ['bin/run.sh', true],
    ]);
    expect(snap.files[1]!.content.toString()).toBe('export const a = 1;\n');
    expect(new Set(tokens)).toEqual(new Set(['lp-moonpad']));
    expect(
      stub.calls.every((c) => c.headers.authorization === 'Bearer ghs_repo_scoped_token_value'),
    ).toBe(true);
  });

  it('refuses symlinks, submodules, truncated trees and corrupted blobs', async () => {
    const symlink = stubFetch(
      routes([...entries, { path: 'link', mode: '120000', type: 'blob', sha: 'e'.repeat(40) }]),
    );
    await expect(source(symlink).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(/symlink/);
    const submodule = stubFetch(
      routes([...entries, { path: 'sub', mode: '160000', type: 'commit', sha: 'f'.repeat(40) }]),
    );
    await expect(source(submodule).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(/submodule/);
    const truncated = stubFetch(routes(entries, { truncated: true }));
    await expect(source(truncated).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(/too large/);
    const corrupt = stubFetch(routes(entries, { corrupt: true }));
    await expect(source(corrupt).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(
      /does not match/,
    );
  });

  it('refuses unsafe paths, missing branches and non-client repositories', async () => {
    const unsafe = stubFetch(
      routes([{ path: '../x', mode: '100644', type: 'blob', sha: entries[0]!.sha }]),
    );
    await expect(source(unsafe).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(
      /invalid file path/,
    );
    await expect(source(stubFetch([]), null).src.snapshot('lp-moonpad', 'main')).rejects.toThrow(
      /not found/,
    );
    await expect(source(stubFetch([])).src.snapshot('Forge', 'main')).rejects.toThrow(
      /invalid client repository/,
    );
  });
});
