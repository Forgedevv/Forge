/// <reference types="node" />
import { z } from 'zod';
import { assertRepoPath, encodeBranch, gitBlobSha, type GithubClient } from '../github.js';
import { createHttpClient, ServiceError, type HttpClient, type HttpResponse } from '../http.js';
import type { WorkdirFile } from './workdir.js';

/**
 * Reads the files of a client repository at a branch head or a commit: to prepare a job folder,
 * and to scan exactly what a release brings into the default branch.
 *
 * GitHub's git data API (commit -> recursive tree -> blobs) with an installation token scoped to
 * that single repository (docs/SECURITY.md §3). Blob contents are checked against their git object
 * id, so what is read is exactly the commit that was listed. Symlinks and submodules are refused:
 * a job folder only ever starts with regular files.
 */

export interface RepoTreeEntry {
  path: string;
  /** Git blob id of the content. */
  sha: string;
  executable: boolean;
}

export interface RepoTree {
  /** Commit the tree belongs to. */
  commitSha: string;
  entries: RepoTreeEntry[];
}

export interface RepoSnapshot {
  /** Commit the files were read from. */
  commitSha: string;
  files: WorkdirFile[];
}

export interface RepoSource {
  /** Regular files of `repo` at the head of a branch, or at a commit sha. No content. */
  listTree(repo: string, ref: string): Promise<RepoTree>;
  /** Contents of some entries of a listed tree, checked against their blob ids. */
  readBlobs(repo: string, entries: readonly RepoTreeEntry[]): Promise<Map<string, Buffer>>;
  /** Every file of `repo` at a branch head or a commit sha. */
  snapshot(repo: string, ref: string): Promise<RepoSnapshot>;
}

export const SNAPSHOT_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  concurrency: 6,
} as const;

const SHA_RE = /^[0-9a-f]{40}$/;

const TreeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});
const CommitSchema = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) });
const BlobSchema = z.object({ sha: z.string(), encoding: z.string(), content: z.string() });

export interface GithubRepoSourceOptions {
  org: string;
  github: Pick<GithubClient, 'createRepoToken' | 'getBranchHead'>;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

function parse<S extends z.ZodType>(schema: S, res: HttpResponse, what: string): z.infer<S> {
  const parsed = schema.safeParse(res.json);
  if (!parsed.success) {
    throw new ServiceError('github', 'invalid_response', `unexpected GitHub response for ${what}`, {
      status: res.status,
    });
  }
  return parsed.data;
}

function assertClientRepo(repo: string): void {
  if (typeof repo !== 'string' || !/^lp-[a-z0-9]+(-[a-z0-9]+)*$/.test(repo)) {
    throw new ServiceError('github', 'invalid_input', 'invalid client repository name');
  }
}

/** Builds a snapshot from `listTree` + `readBlobs` (shared by the fakes). */
export async function snapshotFrom(
  source: Pick<RepoSource, 'listTree' | 'readBlobs'>,
  repo: string,
  ref: string,
): Promise<RepoSnapshot> {
  const tree = await source.listTree(repo, ref);
  const contents = await source.readBlobs(repo, tree.entries);
  return {
    commitSha: tree.commitSha,
    files: tree.entries.map((e) => {
      const content = contents.get(e.path);
      if (!content) throw new ServiceError('github', 'unexpected', `missing blob for ${e.path}`);
      return { path: e.path, content, executable: e.executable };
    }),
  };
}

export function createGithubRepoSource(opts: GithubRepoSourceOptions): RepoSource {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opts.org)) {
    throw new ServiceError('github', 'invalid_input', 'invalid GitHub organization');
  }
  const http: HttpClient = createHttpClient({
    service: 'github',
    baseUrl: opts.apiBaseUrl ?? 'https://api.github.com',
    defaultHeaders: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'forge-builder',
    },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const root = (repo: string): string =>
    `/repos/${encodeURIComponent(opts.org)}/${encodeURIComponent(repo)}`;
  // The token is cached by the GitHub client until shortly before it expires.
  const auth = (repo: string) => async (): Promise<string> =>
    `Bearer ${(await opts.github.createRepoToken(repo)).token}`;

  async function listTree(repo: string, ref: string): Promise<RepoTree> {
    assertClientRepo(repo);
    let head: string | null;
    if (SHA_RE.test(ref)) {
      head = ref;
    } else {
      encodeBranch(ref);
      head = await opts.github.getBranchHead(repo, ref);
    }
    if (head === null) {
      throw new ServiceError('github', 'not_found', `branch ${ref} not found`, { status: 404 });
    }
    const authorization = auth(repo);
    const commit = parse(
      CommitSchema,
      await http.request({
        method: 'GET',
        path: `${root(repo)}/git/commits/${head}`,
        authorization,
      }),
      'commit',
    );
    const tree = parse(
      TreeSchema,
      await http.request({
        method: 'GET',
        path: `${root(repo)}/git/trees/${commit.tree.sha}`,
        query: { recursive: '1' },
        authorization,
      }),
      'tree',
    );
    if (tree.truncated) {
      throw new ServiceError('github', 'unexpected', 'repository tree too large to read');
    }
    const entries: RepoTreeEntry[] = [];
    let total = 0;
    for (const entry of tree.tree) {
      if (entry.type === 'tree') continue;
      assertRepoPath(entry.path);
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        const what =
          entry.mode === '120000'
            ? 'symlink'
            : entry.type === 'commit'
              ? 'submodule'
              : `entry (mode ${entry.mode})`;
        throw new ServiceError(
          'github',
          'unexpected',
          `unsupported ${what} in the repository: ${entry.path.slice(0, 80)}`,
        );
      }
      if (!SHA_RE.test(entry.sha)) {
        throw new ServiceError('github', 'invalid_response', 'invalid blob id in the tree');
      }
      if ((entry.size ?? 0) > SNAPSHOT_LIMITS.maxFileBytes) {
        throw new ServiceError(
          'github',
          'unexpected',
          `file too large: ${entry.path.slice(0, 80)}`,
        );
      }
      total += entry.size ?? 0;
      if (total > SNAPSHOT_LIMITS.maxTotalBytes) {
        throw new ServiceError('github', 'unexpected', 'repository too large to read');
      }
      entries.push({ path: entry.path, sha: entry.sha, executable: entry.mode === '100755' });
      if (entries.length > SNAPSHOT_LIMITS.maxFiles) {
        throw new ServiceError('github', 'unexpected', 'too many files in the repository');
      }
    }
    return { commitSha: head, entries };
  }

  async function readBlobs(
    repo: string,
    entries: readonly RepoTreeEntry[],
  ): Promise<Map<string, Buffer>> {
    assertClientRepo(repo);
    const authorization = auth(repo);
    const out = new Map<string, Buffer>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const blob = entries[cursor++];
        if (!blob) break;
        if (!SHA_RE.test(blob.sha)) {
          throw new ServiceError('github', 'invalid_input', 'invalid blob id');
        }
        const body = parse(
          BlobSchema,
          await http.request({
            method: 'GET',
            path: `${root(repo)}/git/blobs/${blob.sha}`,
            authorization,
          }),
          'blob',
        );
        if (body.encoding !== 'base64') {
          throw new ServiceError('github', 'invalid_response', 'unexpected blob encoding');
        }
        const content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
        if (content.byteLength > SNAPSHOT_LIMITS.maxFileBytes) {
          throw new ServiceError('github', 'unexpected', `file too large: ${blob.path}`);
        }
        if (gitBlobSha(content) !== blob.sha) {
          throw new ServiceError(
            'github',
            'invalid_response',
            'blob content does not match its id',
          );
        }
        out.set(blob.path, content);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SNAPSHOT_LIMITS.concurrency, entries.length) }, worker),
    );
    return out;
  }

  const source: RepoSource = {
    listTree,
    readBlobs,
    snapshot: (repo, ref) => snapshotFrom(source, repo, ref),
  };
  return source;
}
