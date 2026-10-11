/// <reference types="node" />
import { z } from 'zod';
import { assertRepoPath, encodeBranch, gitBlobSha, type GithubClient } from '../github.js';
import { createHttpClient, ServiceError, type HttpClient, type HttpResponse } from '../http.js';
import type { WorkdirFile } from './workdir.js';

/**
 * Reads every file of a client repository at a branch head, to prepare a job folder.
 *
 * GitHub's git data API (commit -> recursive tree -> blobs) with an installation token scoped to
 * that single repository (docs/SECURITY.md §3). Blob contents are checked against their git object
 * id, so what is written in the job folder is exactly the commit that was read. Symlinks and
 * submodules are refused: the job folder only ever starts with regular files.
 */

export interface RepoSnapshot {
  /** Commit the files were read from. */
  commitSha: string;
  files: WorkdirFile[];
}

export interface RepoSource {
  /** Files of `repo` at the head of `branch`. */
  snapshot(repo: string, branch: string): Promise<RepoSnapshot>;
}

export const SNAPSHOT_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  concurrency: 6,
} as const;

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

  return {
    async snapshot(repo, branch) {
      if (typeof repo !== 'string' || !/^lp-[a-z0-9]+(-[a-z0-9]+)*$/.test(repo)) {
        throw new ServiceError('github', 'invalid_input', 'invalid client repository name');
      }
      encodeBranch(branch);
      const head = await opts.github.getBranchHead(repo, branch);
      if (head === null) {
        throw new ServiceError('github', 'not_found', `branch ${branch} not found`, {
          status: 404,
        });
      }
      const root = `/repos/${encodeURIComponent(opts.org)}/${encodeURIComponent(repo)}`;
      // Re-read the token on each call: it is cached by the GitHub client until near expiry.
      const authorization = async (): Promise<string> =>
        `Bearer ${(await opts.github.createRepoToken(repo)).token}`;

      const commit = parse(
        CommitSchema,
        await http.request({ method: 'GET', path: `${root}/git/commits/${head}`, authorization }),
        'commit',
      );
      const tree = parse(
        TreeSchema,
        await http.request({
          method: 'GET',
          path: `${root}/git/trees/${commit.tree.sha}`,
          query: { recursive: '1' },
          authorization,
        }),
        'tree',
      );
      if (tree.truncated) {
        throw new ServiceError('github', 'unexpected', 'repository tree too large to read');
      }

      const blobs: Array<{ path: string; sha: string; executable: boolean }> = [];
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
        blobs.push({ path: entry.path, sha: entry.sha, executable: entry.mode === '100755' });
        if (blobs.length > SNAPSHOT_LIMITS.maxFiles) {
          throw new ServiceError('github', 'unexpected', 'too many files in the repository');
        }
      }

      const files: WorkdirFile[] = new Array(blobs.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < blobs.length) {
          const index = cursor++;
          const blob = blobs[index];
          if (!blob) break;
          const body = parse(
            BlobSchema,
            await http.request({
              method: 'GET',
              path: `${root}/git/blobs/${encodeURIComponent(blob.sha)}`,
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
          files[index] = { path: blob.path, content, executable: blob.executable };
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SNAPSHOT_LIMITS.concurrency, blobs.length) }, worker),
      );
      return { commitSha: head, files };
    },
  };
}
