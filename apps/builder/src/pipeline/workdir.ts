/// <reference types="node" />
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chown, lstat, mkdir, open, readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, GitMode } from '../scan/index.js';
import { PipelineError } from './errors.js';

/**
 * Job folders on the host. A folder is mounted into the sandbox at /workspace, where code written
 * from user input runs; afterwards everything in it is hostile input. It is read back with `lstat`
 * and `O_NOFOLLOW` only: a symlink is reported as a symlink (the scan refuses it), never followed.
 */

/** Prefix of every job folder inside the jobs root (stale folders are matched on it). */
export const WORKDIR_PREFIX = 'job-';

export interface WorkdirLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const WORKDIR_LIMITS: Readonly<WorkdirLimits> = {
  /** Files read back after the agent (a template has a few hundred). */
  maxFiles: 5_000,
  /** One file larger than this fails the read (the scan caps text and binaries far below). */
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 150 * 1024 * 1024,
  maxDepth: 32,
};

/** A file to write into a fresh job folder. */
export interface WorkdirFile {
  /** Repository-relative POSIX path. */
  path: string;
  content: Buffer;
  executable: boolean;
}

/** An entry read back from a job folder. */
export interface TreeEntry {
  path: string;
  /** `100644` file, `100755` executable, `120000` symlink, `special` anything else. */
  mode: GitMode;
  /** File bytes, symlink target, or empty for a special entry. */
  content: Buffer;
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertRelativePath(p: string): void {
  if (
    typeof p !== 'string' ||
    p.length === 0 ||
    p.length > 500 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.includes('\0') ||
    /^[A-Za-z]:/.test(p) ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')
  ) {
    throw new PipelineError(`unsafe file path in the repository: ${String(p).slice(0, 80)}`);
  }
}

/** True when `child` is strictly inside `root` (both already resolved). */
function strictlyInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface CreateWorkdirOptions {
  jobsRoot: string;
  jobId: string;
  attempt: number;
  /** Owner of the folder when the builder runs as root (the sandbox writes as this uid). */
  uid?: number;
  gid?: number;
}

/** Creates a fresh, empty job folder strictly inside the jobs root. */
export async function createWorkdir(opts: CreateWorkdirOptions): Promise<string> {
  if (!JOB_ID_RE.test(opts.jobId)) throw new PipelineError('invalid job id');
  const root = await realpath(opts.jobsRoot);
  const name = `${WORKDIR_PREFIX}${opts.jobId}-a${Math.max(0, Math.trunc(opts.attempt))}-${randomBytes(4).toString('hex')}`;
  const dir = path.join(root, name);
  if (!strictlyInside(root, dir)) throw new PipelineError('job folder escapes the jobs root');
  // Not recursive: the root must exist, and an existing folder of that name is an error.
  await mkdir(dir, { mode: 0o700 });
  await maybeChown(dir, opts);
  return dir;
}

async function maybeChown(target: string, opts: { uid?: number; gid?: number }): Promise<void> {
  const getuid = process.getuid?.bind(process);
  if (!getuid || getuid() !== 0 || opts.uid === undefined) return;
  await chown(target, opts.uid, opts.gid ?? opts.uid);
}

/** Removes a job folder. Refuses anything that is not a real folder strictly inside the root. */
export async function removeWorkdir(dir: string, jobsRoot: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new PipelineError('refusing to remove a job folder that is not a real directory');
  }
  const [root, real] = await Promise.all([realpath(jobsRoot), realpath(dir)]);
  if (!strictlyInside(root, real) || !path.basename(real).startsWith(WORKDIR_PREFIX)) {
    throw new PipelineError('refusing to remove a folder outside the jobs root');
  }
  // `rm` does not follow symlinks inside the tree: it removes the links themselves.
  await rm(real, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Removes job folders left behind by a crash (older than `olderThanMs`). Only direct children of
 * the root whose name has the job prefix are considered. Returns the number removed.
 */
export async function removeStaleWorkdirs(
  jobsRoot: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  const root = await realpath(jobsRoot);
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKDIR_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    const st = await lstat(dir).catch(() => null);
    if (!st || now - st.mtimeMs < olderThanMs) continue;
    await removeWorkdir(dir, root);
    removed += 1;
  }
  return removed;
}

/** Writes the files into a fresh job folder (never overwrites, never through a symlink). */
export async function writeWorkdirFiles(
  dir: string,
  files: readonly WorkdirFile[],
  owner: { uid?: number; gid?: number } = {},
): Promise<void> {
  const seen = new Set<string>();
  const createdDirs = new Set<string>();
  for (const file of files) {
    assertRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new PipelineError(`duplicate path: ${file.path.slice(0, 80)}`);
    seen.add(key);
    const segments = file.path.split('/');
    let current = dir;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      if (createdDirs.has(current)) continue;
      try {
        await mkdir(current, { mode: 0o755 });
        await maybeChown(current, owner);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const st = await lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          throw new PipelineError(`path conflict at ${file.path.slice(0, 80)}`);
        }
      }
      createdDirs.add(current);
    }
    const target = path.join(dir, ...segments);
    // `wx`: fails if anything exists there; O_NOFOLLOW: never writes through a link.
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(target, flags, file.executable ? 0o755 : 0o644);
    try {
      await handle.writeFile(file.content);
    } finally {
      await handle.close();
    }
    await maybeChown(target, owner);
  }
}

/** Reads a regular file without following a symlink at the last component. */
async function readRegularFile(file: string, expectedSize: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new PipelineError('file changed type while being read');
    if (st.size !== expectedSize) throw new PipelineError('file changed size while being read');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Lists every entry of a job folder, recursively, without following symlinks. Nothing is skipped:
 * it is read right after the agent and before any install or build, so everything in it (a
 * `node_modules` or `.next` folder included) was written by the agent and must go to the scan.
 */
export async function readWorkdirTree(
  dir: string,
  limits: Partial<WorkdirLimits> = {},
  /**
   * Entries left out (path relative to `dir`). Never used by the pipeline: only the local site
   * test tool skips what it creates itself (linked node_modules, next dev output).
   */
  skip?: (relPath: string) => boolean,
): Promise<TreeEntry[]> {
  const max = { ...WORKDIR_LIMITS, ...limits };
  const rootStat = await lstat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PipelineError('job folder is not a real directory');
  }
  const out: TreeEntry[] = [];
  let total = 0;

  async function walk(abs: string, rel: string, depth: number): Promise<void> {
    if (depth > max.maxDepth) throw new PipelineError('job folder is nested too deeply');
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip?.(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) {
        const target = await readlink(childAbs).catch(() => '');
        out.push({ path: childRel, mode: '120000', content: Buffer.from(target, 'utf8') });
      } else if (st.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (st.size > max.maxFileBytes) {
          throw new PipelineError(`file too large in the job folder: ${childRel.slice(0, 80)}`);
        }
        total += st.size;
        if (total > max.maxTotalBytes) throw new PipelineError('job folder is too large');
        const executable = process.platform !== 'win32' && (st.mode & 0o111) !== 0;
        out.push({
          path: childRel,
          mode: executable ? '100755' : '100644',
          content: await readRegularFile(childAbs, st.size),
        });
      } else {
        out.push({ path: childRel, mode: 'special', content: Buffer.alloc(0) });
      }
      if (out.length > max.maxFiles) throw new PipelineError('too many files in the job folder');
    }
  }

  await walk(dir, '', 0);
  return out;
}

/** Baseline entry (what the builder wrote before the agent ran). */
export interface BaselineFile {
  content: Buffer;
  executable: boolean;
}

/**
 * Changed files between the baseline and the folder as the agent left it, in the scan's format.
 * A rename shows as a deletion plus an addition. Unchanged files are omitted.
 */
export function diffAgainstBaseline(
  baseline: ReadonlyMap<string, BaselineFile>,
  tree: readonly TreeEntry[],
): ChangedFile[] {
  const changes: ChangedFile[] = [];
  const present = new Set<string>();
  for (const entry of tree) {
    present.add(entry.path);
    const before = baseline.get(entry.path);
    if (!before) {
      changes.push({
        path: entry.path,
        status: 'added',
        oldContent: null,
        newContent: entry.content,
        mode: entry.mode,
      });
      continue;
    }
    const oldMode: GitMode = before.executable ? '100755' : '100644';
    if (entry.mode === oldMode && before.content.equals(entry.content)) continue;
    changes.push({
      path: entry.path,
      status: 'modified',
      oldContent: before.content,
      newContent: entry.content,
      mode: entry.mode,
      oldMode,
    });
  }
  for (const [p, before] of baseline) {
    if (present.has(p)) continue;
    changes.push({ path: p, status: 'deleted', oldContent: before.content, newContent: null });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
