/// <reference types="node" />
import { mkdir, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineError } from './errors.js';
import { makeJobsRoot } from './test-fakes.js';
import {
  createWorkdir,
  diffAgainstBaseline,
  readWorkdirTree,
  removeStaleWorkdirs,
  removeWorkdir,
  writeWorkdirFiles,
  type BaselineFile,
} from './workdir.js';

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ root, cleanup } = await makeJobsRoot());
});
afterEach(async () => {
  await cleanup();
});

const file = (p: string, s: string, executable = false) => ({
  path: p,
  content: Buffer.from(s),
  executable,
});

describe('job folders', () => {
  it('creates a fresh folder strictly inside the jobs root', async () => {
    const a = await createWorkdir({ jobsRoot: root, jobId: 'job-1', attempt: 1 });
    const b = await createWorkdir({ jobsRoot: root, jobId: 'job-1', attempt: 1 });
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
    expect(path.basename(a)).toMatch(/^job-job-1-a1-[0-9a-f]{8}$/);
    expect((await stat(a)).isDirectory()).toBe(true);
  });

  it('refuses a job id that could escape the root', async () => {
    await expect(
      createWorkdir({ jobsRoot: root, jobId: '../x', attempt: 1 }),
    ).rejects.toBeInstanceOf(PipelineError);
  });

  it('writes files and refuses unsafe or duplicate paths', async () => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    await writeWorkdirFiles(dir, [file('a.txt', 'a'), file('src/b/c.ts', 'c')]);
    expect(await readdir(path.join(dir, 'src', 'b'))).toEqual(['c.ts']);
    for (const bad of ['../x', '/abs', 'a/../b', '.git/config', 'a\\b', 'C:/x', '']) {
      const fresh = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 2 });
      await expect(writeWorkdirFiles(fresh, [file(bad, 'x')])).rejects.toBeInstanceOf(
        PipelineError,
      );
    }
    const dup = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 3 });
    await expect(writeWorkdirFiles(dup, [file('A.txt', '1'), file('a.txt', '2')])).rejects.toThrow(
      /duplicate/,
    );
  });

  it('never writes over an existing entry', async () => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    await writeWorkdirFiles(dir, [file('a.txt', 'a')]);
    await expect(writeWorkdirFiles(dir, [file('a.txt', 'b')])).rejects.toThrow();
  });

  it('removes only job folders inside the root', async () => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    await writeWorkdirFiles(dir, [file('a/b.txt', 'x')]);
    await removeWorkdir(dir, root);
    expect(await readdir(root)).toEqual([]);
    const other = path.join(root, 'not-a-job');
    await mkdir(other);
    await expect(removeWorkdir(other, root)).rejects.toBeInstanceOf(PipelineError);
    await expect(removeWorkdir(root, root)).rejects.toBeInstanceOf(PipelineError);
    // Absent folder: nothing to do.
    await removeWorkdir(path.join(root, 'job-missing'), root);
  });

  it('removes stale job folders only', async () => {
    const old = await createWorkdir({ jobsRoot: root, jobId: 'old', attempt: 1 });
    const fresh = await createWorkdir({ jobsRoot: root, jobId: 'fresh', attempt: 1 });
    await mkdir(path.join(root, 'keep-me'));
    const past = new Date(Date.now() - 3 * 3_600_000);
    await utimes(old, past, past);
    expect(await removeStaleWorkdirs(root, 3_600_000)).toBe(1);
    const left = (await readdir(root)).sort();
    expect(left).toEqual([path.basename(fresh), 'keep-me'].sort());
  });
});

describe('reading a job folder back', () => {
  it('lists every file with its bytes, including hidden and build folders', async () => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    await writeWorkdirFiles(dir, [file('src/a.ts', 'a'), file('.env', 'X=1')]);
    await mkdir(path.join(dir, 'node_modules', 'evil'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'evil', 'index.js'), 'x');
    await mkdir(path.join(dir, 'empty'));
    const tree = await readWorkdirTree(dir);
    expect(tree.map((e) => e.path)).toEqual(['.env', 'node_modules/evil/index.js', 'src/a.ts']);
    expect(tree[2]).toMatchObject({ mode: '100644' });
    expect(tree[2]!.content.toString()).toBe('a');
  });

  it('reports a symlink as a symlink and never follows it', async (ctx) => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    try {
      await symlink(outside, path.join(dir, 'link'), 'dir');
      await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'file-link'), 'file');
    } catch {
      ctx.skip();
      return;
    }
    const tree = await readWorkdirTree(dir);
    expect(tree.map((e) => [e.path, e.mode])).toEqual([
      ['file-link', '120000'],
      ['link', '120000'],
    ]);
    expect(tree.some((e) => e.content.toString().includes('top secret'))).toBe(false);
  });

  it('enforces the size limits', async () => {
    const dir = await createWorkdir({ jobsRoot: root, jobId: 'j', attempt: 1 });
    await writeWorkdirFiles(dir, [file('a', 'x'.repeat(100)), file('b', 'y'), file('c', 'z')]);
    await expect(readWorkdirTree(dir, { maxFileBytes: 50 })).rejects.toThrow(/too large/);
    await expect(readWorkdirTree(dir, { maxTotalBytes: 50 })).rejects.toThrow(/too large/);
    await expect(readWorkdirTree(dir, { maxFiles: 2 })).rejects.toThrow(/too many/);
  });
});

describe('diff against the baseline', () => {
  const base = new Map<string, BaselineFile>([
    ['same.ts', { content: Buffer.from('same'), executable: false }],
    ['changed.ts', { content: Buffer.from('old'), executable: false }],
    ['gone.ts', { content: Buffer.from('bye'), executable: false }],
    ['mode.sh', { content: Buffer.from('run'), executable: false }],
  ]);

  it('reports added, modified, deleted and mode changes, and skips unchanged files', () => {
    const changes = diffAgainstBaseline(base, [
      { path: 'same.ts', mode: '100644', content: Buffer.from('same') },
      { path: 'changed.ts', mode: '100644', content: Buffer.from('new') },
      { path: 'mode.sh', mode: '100755', content: Buffer.from('run') },
      { path: 'new.ts', mode: '100644', content: Buffer.from('hi') },
      { path: 'link', mode: '120000', content: Buffer.from('/etc') },
    ]);
    expect(changes.map((c) => [c.path, c.status, c.mode ?? null])).toEqual([
      ['changed.ts', 'modified', '100644'],
      ['gone.ts', 'deleted', null],
      ['link', 'added', '120000'],
      ['mode.sh', 'modified', '100755'],
      ['new.ts', 'added', '100644'],
    ]);
    const changed = changes.find((c) => c.path === 'changed.ts')!;
    expect(Buffer.from(changed.oldContent as Uint8Array).toString()).toBe('old');
    expect(Buffer.from(changed.newContent as Uint8Array).toString()).toBe('new');
  });
});
