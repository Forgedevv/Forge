/**
 * One signer at a time. The replay cache of the HMAC server, the launchpad locks, the payer
 * reservations and the file journals are all per process: two signers over the same journal
 * directory could sign the same creation or refund twice. An exclusive lock file in
 * SIGNER_JOURNAL_DIR (`signer.lock`, holding the pid) is taken before the keystore is opened and
 * released at shutdown; the operator command takes the same lock, so it never runs next to the
 * service. A lock left by a crashed process is detected (its pid is gone) and taken over.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const INSTANCE_LOCK_FILE = 'signer.lock';

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

/**
 * Lock files held by this process: a second acquisition in the same process (two runtimes, or
 * the operator command next to the service in one process) is refused like any other holder.
 * A file holding our pid that is NOT in this set was left by a dead process whose pid we reuse.
 */
const heldInProcess = new Set<string>();

function parsePid(content: string): number | null {
  const first = content.split(/\r?\n/)[0]?.trim() ?? '';
  if (!/^[0-9]{1,10}$/.test(first)) return null;
  const pid = Number(first);
  return pid > 0 ? pid : null;
}

/**
 * Takes the exclusive lock of `dir`, or throws `InstanceLockError` naming the live holder.
 * The file is created with O_EXCL, so two processes racing for a stale lock cannot both win.
 */
export async function acquireInstanceLock(
  dir: string,
  options: InstanceLockOptions = {},
): Promise<InstanceLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const file = path.join(path.resolve(dir), INSTANCE_LOCK_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = `${pid}\n${options.command ?? 'signer'}\n`;
  if (heldInProcess.has(file)) {
    const holder = (await fs.readFile(file, 'utf8').then(parsePid, () => null)) ?? pid;
    throw new InstanceLockError(
      `another signer instance holds ${INSTANCE_LOCK_FILE} (pid ${holder}, this process): refusing to run twice over the same journal directory`,
      holder,
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
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
          if (parsePid(current) === pid) await fs.rm(file, { force: true });
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
    const holder = parsePid(current);
    // Our own pid in the file: the previous holder with that pid is gone (we have it now).
    if (holder !== null && holder !== pid && isAlive(holder)) {
      throw new InstanceLockError(
        `another signer instance holds ${INSTANCE_LOCK_FILE} (pid ${holder}): refusing to run twice over the same journal directory`,
        holder,
      );
    }
    await fs.rm(file, { force: true });
  }
  throw new InstanceLockError(
    `could not take ${INSTANCE_LOCK_FILE}: the lock keeps changing hands`,
    null,
  );
}
