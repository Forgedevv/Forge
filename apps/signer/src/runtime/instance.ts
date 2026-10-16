/**
 * One signer at a time. The replay cache of the HMAC server, the launchpad locks, the payer
 * reservations and the file journals are all per process: two signers over the same journal
 * directory could sign the same creation or refund twice. An exclusive lock file in
 * SIGNER_JOURNAL_DIR (`signer.lock`) is taken before the keystore is opened and released at
 * shutdown; the operator command takes the same lock, so it never runs next to the service.
 *
 * The lock records the holder's pid, the boot id of the machine and the start time of the
 * process (both from /proc on Linux). A lock is live only when the boot id matches, the pid is
 * alive and its start time matches: a lock left by a crashed process, or by a process of a
 * previous boot whose pid was reused after the reboot, is stale and taken over. Where /proc is
 * not available (tests on Windows, another OS), the unknown parts are not compared and the pid
 * check alone decides, which leans towards "live".
 *
 * Taking over is done by renaming the stale file away first: only one of several processes
 * racing for the same stale lock can win the rename, the others retry and find the winner's
 * lock. A file that is empty or unparsable may be a lock being written (created with O_EXCL,
 * then written): it counts as held for a short grace period, measured on its mtime, before it
 * is treated as garbage and taken over.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const INSTANCE_LOCK_FILE = 'signer.lock';

/** How long an empty or unparsable lock file counts as held (a lock being written). */
export const INSTANCE_LOCK_GRACE_MS = 10_000;

export class InstanceLockError extends Error {
  override readonly name = 'InstanceLockError';
  /** Pid of the live holder, null when the lock could not be taken for another reason. */
  readonly holderPid: number | null;
  constructor(message: string, holderPid: number | null) {
    super(message);
    this.holderPid = holderPid;
  }
}

export interface InstanceLock {
  readonly path: string;
  readonly pid: number;
  /** Removes the lock file, only if it still holds this pid. Idempotent. */
  release(): Promise<void>;
}

export interface InstanceLockOptions {
  /** Pid written to the lock (default: this process). */
  pid?: number;
  /** Whether a pid is a live process (default: `process.kill(pid, 0)`). Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Free text written after the pid (the command holding the lock, for the operator). */
  command?: string;
  /** Boot id of this machine (default: /proc/sys/kernel/random/boot_id; null when unreadable). */
  bootId?: string | null;
  /** Start time of a live pid (default: field 22 of /proc/<pid>/stat; null when unreadable). */
  startTimeOf?: (pid: number) => Promise<string | null>;
  /** Grace during which an empty or unparsable lock counts as held (default 10 s). */
  graceMs?: number;
  /** Clock, for the grace period. Injectable for tests. */
  now?: () => number;
}

/** What the lock file records about its holder. */
export interface InstanceLockRecord {
  pid: number;
  command: string;
  /** Boot id of the machine the holder ran on, null when it could not be read. */
  bootId: string | null;
  /** Start time of the holder (clock ticks since boot), null when it could not be read. */
  startTime: string | null;
}

/** True when a process with that pid exists (EPERM: it exists but is not ours). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** The boot id of this machine, null outside Linux or when /proc is unreadable. */
export async function readBootId(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const id = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/**
 * The start time of a process (field 22 of /proc/<pid>/stat, in clock ticks since boot), null
 * outside Linux, when the process is gone or when /proc is unreadable. Two processes of one
 * boot never share a pid and a start time.
 */
export async function readProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    return parseProcStatStartTime(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Field 22 of a /proc/<pid>/stat line. The command (field 2) is in parentheses and may contain spaces. */
export function parseProcStatStartTime(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  // After the closing parenthesis come fields 3 (state) onwards: field 22 is at index 19.
  const start = stat.slice(end + 1).trim().split(/\s+/)[19];
  return start !== undefined && /^[0-9]+$/.test(start) ? start : null;
}

/**
 * Lock files held by this process: a second acquisition in the same process (two runtimes, or
 * the operator command next to the service in one process) is refused like any other holder.
 * A file holding our pid that is NOT in this set was left by a dead process whose pid we reuse.
 */
const heldInProcess = new Set<string>();

/** Lines: pid, command, then `key=value` lines (`boot`, `start`; empty when unknown). */
export function formatLockRecord(record: InstanceLockRecord): string {
  return `${record.pid}\n${record.command}\nboot=${record.bootId ?? ''}\nstart=${record.startTime ?? ''}\n`;
}

/** Null when the first line is not a pid (an empty file, or garbage). */
export function parseLockRecord(content: string): InstanceLockRecord | null {
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  if (!/^[0-9]{1,10}$/.test(first)) return null;
  const pid = Number(first);
  if (pid <= 0) return null;
  const record: InstanceLockRecord = {
    pid,
    command: lines[1]?.trim() ?? '',
    bootId: null,
    startTime: null,
  };
  for (const line of lines.slice(2)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value === '') continue;
    if (key === 'boot') record.bootId = value;
    else if (key === 'start') record.startTime = value;
  }
  return record;
}

/**
 * Whether the holder of a lock record is still running. Live only when the boot id matches,
 * the pid is alive and its start time matches; a part unknown on either side is not compared.
 */
export async function lockHolderIsLive(
  record: InstanceLockRecord,
  self: { pid: number; bootId: string | null },
  isAlive: (pid: number) => boolean,
  startTimeOf: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  // Our own pid in the file: the previous holder with that pid is gone (we have it now).
  if (record.pid === self.pid) return false;
  // Written before a reboot: whatever runs under that pid now is another process.
  if (record.bootId !== null && self.bootId !== null && record.bootId !== self.bootId) return false;
  if (!isAlive(record.pid)) return false;
  // The pid is alive, but is it the same process? A reused pid has another start time.
  if (record.startTime !== null) {
    const current = await startTimeOf(record.pid);
    if (current !== null && current !== record.startTime) return false;
  }
  return true;
}

/**
 * Takes the exclusive lock of `dir`, or throws `InstanceLockError` naming the live holder.
 * The file is created with O_EXCL; a stale file is renamed away before it is replaced, so two
 * processes racing for the same stale lock cannot both win: the loser of the rename retries
 * and finds the winner's lock.
 */
export async function acquireInstanceLock(
  dir: string,
  options: InstanceLockOptions = {},
): Promise<InstanceLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const startTimeOf = options.startTimeOf ?? readProcessStartTime;
  const bootId = options.bootId === undefined ? await readBootId() : options.bootId;
  const graceMs = options.graceMs ?? INSTANCE_LOCK_GRACE_MS;
  const now = options.now ?? Date.now;
  const file = path.join(path.resolve(dir), INSTANCE_LOCK_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = formatLockRecord({
    pid,
    command: options.command ?? 'signer',
    bootId,
    startTime: await startTimeOf(pid),
  });
  if (heldInProcess.has(file)) {
    const holder = (await fs.readFile(file, 'utf8').then(parseLockRecord, () => null))?.pid ?? pid;
    throw new InstanceLockError(
      `another signer instance holds ${INSTANCE_LOCK_FILE} (pid ${holder}, this process): refusing to run twice over the same journal directory`,
      holder,
    );
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      heldInProcess.add(file);
      return {
        path: file,
        pid,
        async release() {
          heldInProcess.delete(file);
          let current: string;
          try {
            current = await fs.readFile(file, 'utf8');
          } catch (err) {
            if ((err as { code?: string }).code === 'ENOENT') return;
            throw err;
          }
          if (parseLockRecord(current)?.pid === pid) await fs.rm(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
    // Someone holds it, or held it and died.
    let current: string;
    try {
      current = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') continue; // released meanwhile: retry
      throw err;
    }
    const record = parseLockRecord(current);
    if (record === null) {
      // Empty or garbage: a lock being written by a process that just created it, until the
      // file is older than the grace period.
      const age = await fs.stat(file).then((s) => now() - s.mtimeMs, () => null);
      if (age === null) continue; // gone meanwhile: retry
      if (age < graceMs) {
        throw new InstanceLockError(
          `another signer instance is taking ${INSTANCE_LOCK_FILE} (file being written): refusing to run twice over the same journal directory`,
          null,
        );
      }
    } else if (await lockHolderIsLive(record, { pid, bootId }, isAlive, startTimeOf)) {
      throw new InstanceLockError(
        `another signer instance holds ${INSTANCE_LOCK_FILE} (pid ${record.pid}): refusing to run twice over the same journal directory`,
        record.pid,
      );
    }
    // Stale: rename it away. Only one of the processes racing for it wins the rename; the
    // others get ENOENT and retry, to find the winner's fresh lock.
    const stale = `${file}.stale-${pid}-${now()}-${attempt}`;
    try {
      await fs.rename(file, stale);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') continue;
      throw err;
    }
    await fs.rm(stale, { force: true });
  }
  throw new InstanceLockError(
    `could not take ${INSTANCE_LOCK_FILE}: the lock keeps changing hands`,
    null,
  );
}
