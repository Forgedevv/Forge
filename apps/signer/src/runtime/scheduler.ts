/**
 * Runs the signer's periodic jobs in one process: each job in its own loop, never overlapping
 * itself, with its own delay (fixed interval, or computed after each run: the watcher backs off
 * while its cycles fail). A failing run is recorded and the loop goes on. `stop()` stops every
 * loop and waits for the runs in progress (a job never stops in the middle of a payment).
 *
 * The health state of each job holds only status codes, counters and times: never a message,
 * an address list or anything secret.
 */
import type { JobHealthState } from '../routes/schemas.js';
import { Mutex, describeError, type JobLogger } from '../jobs/shared.js';

export interface ScheduledJob {
  /** One run. Its report's `status` (`ran`, `paused`, `busy`, `error`...) is recorded. */
  runOnce(): Promise<unknown>;
  /** Delay before the next run, read after each run. */
  delayMs(): number;
  /** Called once before the first run (e.g. restore a saved state). */
  init?(): Promise<void>;
  /** Run right away at start (default true). */
  runOnStart?: boolean;
}

export interface SchedulerOptions {
  logger: JobLogger;
  now?: () => number;
  /** Timer injection for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const STATUS_RE = /^[a-z0-9_-]{1,32}$/;

/** Status code of a run report (`{ status }`), `ran` when the report has none. */
export function statusOf(report: unknown): string {
  const status = (report as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'string' && STATUS_RE.test(status)) return status;
  return 'ran';
}

interface Entry {
  name: string;
  job: ScheduledJob;
  state: JobHealthState;
  /** A job never runs concurrently with itself (its loop and `runNow`). */
  mutex: Mutex;
  inFlight: Set<Promise<unknown>>;
  loop: Promise<void> | null;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class JobScheduler {
  readonly #entries = new Map<string, Entry>();
  readonly #log: JobLogger;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  #started = false;
  #stopping: Promise<void> | null = null;

  constructor(options: SchedulerOptions) {
    this.#log = options.logger;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  register(name: string, job: ScheduledJob): void {
    if (!STATUS_RE.test(name)) throw new Error('invalid job name');
    if (this.#entries.has(name)) throw new Error(`job ${name} is registered twice`);
    if (this.#started) throw new Error('jobs must be registered before start');
    this.#entries.set(name, {
      name,
      job,
      state: {
        state: 'starting',
        runs: 0,
        lastStatus: null,
        lastRunAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
      },
      mutex: new Mutex(),
      inFlight: new Set(),
      loop: null,
    });
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  /** Runs one job now (outside its loop, but never concurrently with its own run). */
  async runNow(name: string): Promise<unknown> {
    const entry = this.#entries.get(name);
    if (!entry) throw new Error(`unknown job ${name}`);
    return this.#runEntry(entry);
  }

  states(): Record<string, JobHealthState> {
    const out: Record<string, JobHealthState> = {};
    for (const [name, entry] of this.#entries) out[name] = { ...entry.state };
    return out;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const entry of this.#entries.values()) entry.loop = this.#loop(entry);
  }

  /** Stops every loop and waits for the runs in progress. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#controller.abort();
      const pending: Promise<unknown>[] = [];
      for (const entry of this.#entries.values()) {
        if (entry.loop) pending.push(entry.loop);
        pending.push(...entry.inFlight);
      }
      await Promise.allSettled(pending);
      for (const entry of this.#entries.values()) entry.state.state = 'stopped';
    })();
    return this.#stopping;
  }

  #runEntry(entry: Entry): Promise<unknown> {
    const iso = () => new Date(this.#now()).toISOString();
    const run = entry.mutex.runExclusive(async () => {
      entry.state.state = 'running';
      try {
        const report = await entry.job.runOnce();
        const status = statusOf(report);
        entry.state.lastStatus = status;
        if (status === 'error') entry.state.consecutiveFailures++;
        else {
          entry.state.consecutiveFailures = 0;
          entry.state.lastSuccessAt = iso();
        }
        return report;
      } catch (err) {
        entry.state.lastStatus = 'error';
        entry.state.consecutiveFailures++;
        this.#log.error({ job: entry.name, err: describeError(err) }, 'job run failed');
        return undefined;
      } finally {
        entry.state.runs++;
        entry.state.lastRunAt = iso();
        entry.state.state = this.#controller.signal.aborted ? 'stopped' : 'idle';
      }
    });
    entry.inFlight.add(run);
    void run.finally(() => entry.inFlight.delete(run));
    return run;
  }

  async #loop(entry: Entry): Promise<void> {
    const signal = this.#controller.signal;
    if (entry.job.init) {
      try {
        await entry.job.init();
      } catch (err) {
        this.#log.error({ job: entry.name, err: describeError(err) }, 'job init failed');
      }
    }
    entry.state.state = 'idle';
    if (entry.job.runOnStart === false) await this.#sleep(this.#delayOf(entry), signal);
    while (!signal.aborted) {
      await this.#runEntry(entry);
      if (signal.aborted) break;
      await this.#sleep(this.#delayOf(entry), signal);
    }
    entry.state.state = 'stopped';
  }

  #delayOf(entry: Entry): number {
    let ms: number;
    try {
      ms = entry.job.delayMs();
    } catch {
      ms = 60_000;
    }
    // Never a hot loop, whatever a job reports.
    return Number.isFinite(ms) ? Math.max(1_000, Math.floor(ms)) : 60_000;
  }
}
