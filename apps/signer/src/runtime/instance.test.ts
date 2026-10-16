import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTANCE_LOCK_FILE,
  InstanceLockError,
  acquireInstanceLock,
  processAlive,
} from './instance.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-instance-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const alive = new Set<number>();
const isAlive = (pid: number) => alive.has(pid);
const file = () => path.join(dir, INSTANCE_LOCK_FILE);

describe('instance lock', () => {
  it('is exclusive while its holder lives, and names the holder', async () => {
    alive.add(100);
    const lock = await acquireInstanceLock(dir, { pid: 100, isAlive, command: 'signer' });
    expect(lock.path).toBe(file());
    expect(await fs.readFile(file(), 'utf8')).toBe('100\nsigner\n');

    let error: unknown;
    try {
      await acquireInstanceLock(dir, { pid: 200, isAlive });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InstanceLockError);
    expect((error as InstanceLockError).holderPid).toBe(100);
    expect((error as Error).message).toMatch(/pid 100/);
    expect(await fs.readFile(file(), 'utf8')).toBe('100\nsigner\n'); // untouched

    await lock.release();
    await expect(fs.access(file())).rejects.toThrow();
    const next = await acquireInstanceLock(dir, { pid: 200, isAlive });
    expect(next.pid).toBe(200);
  });

  it('takes over a stale lock (holder gone, or our own pid after a restart with pid reuse)', async () => {
    await fs.writeFile(file(), '100\nsigner\n');
    alive.delete(100);
    const lock = await acquireInstanceLock(dir, { pid: 200, isAlive });
    expect(await fs.readFile(file(), 'utf8')).toBe('200\nsigner\n');
    await lock.release();

    await fs.writeFile(file(), '300\nsigner\n');
    alive.add(300);
    const own = await acquireInstanceLock(dir, { pid: 300, isAlive });
    expect(own.pid).toBe(300);
    await own.release();

    // Garbage in the file: nobody can be asked, it is taken over.
    await fs.writeFile(file(), 'not a pid\n');
    const taken = await acquireInstanceLock(dir, { pid: 400, isAlive });
    expect(await fs.readFile(file(), 'utf8')).toBe('400\nsigner\n');
    await taken.release();
  });

  it('refuses a second acquisition in the same process, whatever pid the file holds', async () => {
    const lock = await acquireInstanceLock(dir, { pid: 100, isAlive });
    await expect(acquireInstanceLock(dir, { pid: 100, isAlive })).rejects.toThrow(
      /another signer instance/,
    );
    await lock.release();
    const again = await acquireInstanceLock(dir, { pid: 100, isAlive });
    await again.release();
  });

  it('release never removes a lock that another process took over', async () => {
    const lock = await acquireInstanceLock(dir, { pid: 100, isAlive });
    await fs.writeFile(file(), '500\nsigner\n');
    await lock.release();
    expect(await fs.readFile(file(), 'utf8')).toBe('500\nsigner\n');
    await lock.release(); // idempotent
  });

  it('creates the directory and reports a live process', async () => {
    const nested = path.join(dir, 'a', 'b');
    const lock = await acquireInstanceLock(nested, { pid: 1, isAlive: () => true });
    expect(lock.path).toBe(path.join(nested, INSTANCE_LOCK_FILE));
    await lock.release();
    expect(processAlive(process.pid)).toBe(true);
  });
});
