import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTANCE_LOCK_FILE,
  INSTANCE_LOCK_GRACE_MS,
  InstanceLockError,
  acquireInstanceLock,
  formatLockRecord,
  lockHolderIsLive,
  parseLockRecord,
  parseProcStatStartTime,
  processAlive,
} from './instance.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-instance-'));
  alive.clear();
  startTimes.clear();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const BOOT = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_BOOT = 'a1b2c3d4-0000-4000-8000-000000000002';
const alive = new Set<number>();
const startTimes = new Map<number, string>();
const isAlive = (pid: number) => alive.has(pid);
const startTimeOf = async (pid: number) => startTimes.get(pid) ?? null;
const file = () => path.join(dir, INSTANCE_LOCK_FILE);
const base = { isAlive, startTimeOf, bootId: BOOT };

function live(pid: number, start: string): void {
  alive.add(pid);
  startTimes.set(pid, start);
}

async function failure(fn: () => Promise<unknown>): Promise<InstanceLockError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceLockError);
    return error as InstanceLockError;
  }
  throw new Error('expected an InstanceLockError');
}

describe('instance lock', () => {
  it('is exclusive while its holder lives, and names the holder', async () => {
    live(100, '5000');
    const lock = await acquireInstanceLock(dir, { ...base, pid: 100, command: 'signer' });
    expect(lock.path).toBe(file());
    expect(await fs.readFile(file(), 'utf8')).toBe(`100\nsigner\nboot=${BOOT}\nstart=5000\n`);

    const error = await failure(() => acquireInstanceLock(dir, { ...base, pid: 200 }));
    expect(error.holderPid).toBe(100);
    expect(error.message).toMatch(/pid 100/);
    expect(await fs.readFile(file(), 'utf8')).toBe(`100\nsigner\nboot=${BOOT}\nstart=5000\n`); // untouched

    await lock.release();
    await expect(fs.access(file())).rejects.toThrow();
    const next = await acquireInstanceLock(dir, { ...base, pid: 200 });
    expect(next.pid).toBe(200);
  });

  it('takes over a stale lock (holder gone, or our own pid after a restart with pid reuse)', async () => {
    await fs.writeFile(file(), formatLockRecord({ pid: 100, command: 'signer', bootId: BOOT, startTime: '1' }));
    const lock = await acquireInstanceLock(dir, { ...base, pid: 200 });
    expect(await fs.readFile(file(), 'utf8')).toMatch(/^200\nsigner\n/);
    await lock.release();

    await fs.writeFile(file(), formatLockRecord({ pid: 300, command: 'signer', bootId: BOOT, startTime: '1' }));
    live(300, '1');
    const own = await acquireInstanceLock(dir, { ...base, pid: 300 });
    expect(own.pid).toBe(300);
    await own.release();

    // No leftover of the rename-away takeover.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('takes over the lock of a previous boot even when the pid is alive again', async () => {
    // After a reboot systemd restarts the signer; a pid of the previous boot is often reused.
    await fs.writeFile(
      file(),
      formatLockRecord({ pid: 100, command: 'signer', bootId: OTHER_BOOT, startTime: '5000' }),
    );
    live(100, '5000');
    const lock = await acquireInstanceLock(dir, { ...base, pid: 200 });
    expect(await fs.readFile(file(), 'utf8')).toBe(`200\nsigner\nboot=${BOOT}\nstart=\n`);
    await lock.release();
  });

  it('takes over the lock of a reused pid in the same boot (another start time)', async () => {
    await fs.writeFile(
      file(),
      formatLockRecord({ pid: 100, command: 'signer', bootId: BOOT, startTime: '5000' }),
    );
    live(100, '7777'); // same pid, another process
    const lock = await acquireInstanceLock(dir, { ...base, pid: 200 });
    expect(lock.pid).toBe(200);
    await lock.release();

    // Same start time: the very same process, still live.
    await fs.writeFile(
      file(),
      formatLockRecord({ pid: 100, command: 'signer', bootId: BOOT, startTime: '5000' }),
    );
    live(100, '5000');
    expect((await failure(() => acquireInstanceLock(dir, { ...base, pid: 200 }))).holderPid).toBe(100);
  });

  it('falls back to the pid check where the boot id or the start time is unknown', async () => {
    // A lock of the previous two-line format, or written where /proc is unavailable.
    await fs.writeFile(file(), '100\nsigner\n');
    live(100, '5000');
    expect((await failure(() => acquireInstanceLock(dir, { ...base, pid: 200 }))).holderPid).toBe(100);
    alive.delete(100);
    const lock = await acquireInstanceLock(dir, { ...base, pid: 200 });
    await lock.release();

    // Ours unknown (not Linux): a recorded boot id or start time is not compared.
    await fs.writeFile(
      file(),
      formatLockRecord({ pid: 100, command: 'signer', bootId: OTHER_BOOT, startTime: '5000' }),
    );
    live(100, '7777');
    const noProc = { isAlive, startTimeOf: async () => null, bootId: null };
    expect((await failure(() => acquireInstanceLock(dir, { ...noProc, pid: 200 }))).holderPid).toBe(100);
    alive.delete(100);
    const taken = await acquireInstanceLock(dir, { ...noProc, pid: 200 });
    expect(await fs.readFile(file(), 'utf8')).toBe('200\nsigner\nboot=\nstart=\n');
    await taken.release();
  });

  it('counts an empty or unparsable file as held during the grace period, then takes it over', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    for (const garbage of ['', 'not a pid\n']) {
      await fs.writeFile(file(), garbage);
      const stat = await fs.stat(file());
      clock = stat.mtimeMs + INSTANCE_LOCK_GRACE_MS - 1;
      const error = await failure(() => acquireInstanceLock(dir, { ...base, pid: 400, now }));
      expect(error.holderPid).toBeNull();
      expect(error.message).toMatch(/being written/);
      expect(await fs.readFile(file(), 'utf8')).toBe(garbage); // untouched

      clock = stat.mtimeMs + INSTANCE_LOCK_GRACE_MS;
      const taken = await acquireInstanceLock(dir, { ...base, pid: 400, now });
      expect(await fs.readFile(file(), 'utf8')).toMatch(/^400\nsigner\n/);
      await taken.release();
    }
    // A shorter grace is configurable.
    await fs.writeFile(file(), '');
    const taken = await acquireInstanceLock(dir, { ...base, pid: 400, graceMs: 0 });
    await taken.release();
  });

  it('lets exactly one of two processes racing for a stale lock win', async () => {
    await fs.writeFile(file(), formatLockRecord({ pid: 100, command: 'signer', bootId: BOOT, startTime: '1' }));
    live(200, '2');
    live(300, '3');
    const results = await Promise.allSettled([
      acquireInstanceLock(dir, { ...base, pid: 200 }),
      acquireInstanceLock(dir, { ...base, pid: 300 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InstanceLockError);
    const winner = (won[0] as PromiseFulfilledResult<{ pid: number }>).value.pid;
    expect(await fs.readFile(file(), 'utf8')).toMatch(new RegExp(`^${winner}\\n`));
    expect(await fs.readdir(dir)).toEqual([INSTANCE_LOCK_FILE]); // no stale leftover
  });

  it('refuses a second acquisition in the same process, whatever pid the file holds', async () => {
    const lock = await acquireInstanceLock(dir, { ...base, pid: 100 });
    await expect(acquireInstanceLock(dir, { ...base, pid: 100 })).rejects.toThrow(
      /another signer instance/,
    );
    await lock.release();
    const again = await acquireInstanceLock(dir, { ...base, pid: 100 });
    await again.release();
  });

  it('release never removes a lock that another process took over', async () => {
    const lock = await acquireInstanceLock(dir, { ...base, pid: 100 });
    await fs.writeFile(file(), '500\nsigner\n');
    await lock.release();
    expect(await fs.readFile(file(), 'utf8')).toBe('500\nsigner\n');
    await lock.release(); // idempotent
  });

  it('creates the directory and reports a live process', async () => {
    const nested = path.join(dir, 'a', 'b');
    const lock = await acquireInstanceLock(nested, { ...base, pid: 1, isAlive: () => true });
    expect(lock.path).toBe(path.join(nested, INSTANCE_LOCK_FILE));
    await lock.release();
    expect(processAlive(process.pid)).toBe(true);
  });

  it('records the real boot id and start time of this process without throwing', async () => {
    // On Linux both come from /proc; elsewhere they are empty and the pid check alone decides.
    const lock = await acquireInstanceLock(dir);
    const record = parseLockRecord(await fs.readFile(file(), 'utf8'));
    expect(record?.pid).toBe(process.pid);
    if (process.platform === 'linux') {
      expect(record?.bootId).toMatch(/^[0-9a-f-]{36}$/);
      expect(record?.startTime).toMatch(/^[0-9]+$/);
    } else {
      expect(record?.bootId).toBeNull();
      expect(record?.startTime).toBeNull();
    }
    await lock.release();
  });
});

describe('lock records', () => {
  it('round-trips and reads the previous two-line format', () => {
    const record = { pid: 42, command: 'revoke-launch', bootId: BOOT, startTime: '123' };
    expect(parseLockRecord(formatLockRecord(record))).toEqual(record);
    expect(parseLockRecord(formatLockRecord({ ...record, bootId: null, startTime: null }))).toEqual({
      ...record,
      bootId: null,
      startTime: null,
    });
    expect(parseLockRecord('42\nsigner\n')).toEqual({
      pid: 42,
      command: 'signer',
      bootId: null,
      startTime: null,
    });
    expect(parseLockRecord('42\r\nsigner\r\nboot=x\r\n')).toMatchObject({ pid: 42, bootId: 'x' });
    expect(parseLockRecord('')).toBeNull();
    expect(parseLockRecord('0\n')).toBeNull();
    expect(parseLockRecord('abc\n')).toBeNull();
    expect(parseLockRecord('12345678901\n')).toBeNull();
  });

  it('reads field 22 of /proc/<pid>/stat, whatever the command contains', () => {
    const tail =
      '0 1 1 0 -1 4194560 12 0 0 0 1 1 0 0 20 0 1 0 987654 10842112 236 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
    expect(parseProcStatStartTime(`1234 (node) S ${tail}`)).toBe('987654');
    expect(parseProcStatStartTime(`1234 (my (odd) name) S ${tail}`)).toBe('987654');
    expect(parseProcStatStartTime(`1234 (node) S ${tail}\n`)).toBe('987654');
    expect(parseProcStatStartTime('1234 (node) S 0 1')).toBeNull();
    expect(parseProcStatStartTime('garbage')).toBeNull();
  });

  it('decides liveness from the boot id, the pid and the start time', async () => {
    live(100, '5000');
    const self = { pid: 200, bootId: BOOT };
    const record = { pid: 100, command: 'signer', bootId: BOOT, startTime: '5000' };
    expect(await lockHolderIsLive(record, self, isAlive, startTimeOf)).toBe(true);
    expect(await lockHolderIsLive({ ...record, bootId: OTHER_BOOT }, self, isAlive, startTimeOf)).toBe(false);
    expect(await lockHolderIsLive({ ...record, startTime: '1' }, self, isAlive, startTimeOf)).toBe(false);
    expect(await lockHolderIsLive({ ...record, pid: 200 }, self, isAlive, startTimeOf)).toBe(false);
    expect(await lockHolderIsLive(record, { ...self, bootId: null }, isAlive, startTimeOf)).toBe(true);
    expect(await lockHolderIsLive(record, self, isAlive, async () => null)).toBe(true);
    alive.delete(100);
    expect(await lockHolderIsLive(record, self, isAlive, startTimeOf)).toBe(false);
  });
});
