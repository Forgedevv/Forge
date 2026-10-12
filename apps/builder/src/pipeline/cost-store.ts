import { InMemoryGatewayStore, type GatewayStore, type TokenRecord } from '../gateway/index.js';
import type { JobCostStore } from './store.js';

/** Logger shape (pino compatible). */
interface CostLogger {
  warn(obj: object, msg?: string): void;
}

/** Where the daily total of the startup day comes from (see `PersistentCostGatewayStore`). */
export interface DailyCostSeed {
  /** UTC day (YYYY-MM-DD) the builder started on. */
  day: string;
  /** Total already spent on that day, read once (read-only query). */
  load: () => Promise<number>;
}

/**
 * Gateway store for the builder process: tokens and daily totals in memory (the gateway and the
 * worker run in the same process, and tokens never outlive a job), per-job cost persisted in
 * `jobs.api_cost_usd` so the $ budget of a job spans its build attempts and survives a restart.
 *
 * Daily total: without a seed a restart would start the day at zero again. With `dailySeed`, the
 * startup day starts from what is already recorded in the database, then accumulates in memory.
 * The seed is an approximation from above: the sum of `jobs.api_cost_usd` of the jobs updated
 * since 00:00 UTC (a cost write updates the row), so a job that spent today counts in full, even
 * the part it spent before midnight (at most one job budget per such job). Every request checks
 * the daily total before it can cost anything, so the seed is always loaded before this process
 * records a cost: nothing is counted twice. A seed that cannot be read fails closed: the gateway
 * refuses requests until it loads (retried on the next request). Later days start at zero: the
 * process has seen all of their spending.
 *
 * Increments are serialized per job inside this process. Only the worker running a job issues its
 * tokens, so no other process adds to the same job concurrently. (An atomic SQL increment would
 * remove that assumption; see the change requests of the task report.)
 */
export class PersistentCostGatewayStore implements GatewayStore {
  private readonly memory = new InMemoryGatewayStore();
  private readonly costs = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private seeded = false;
  private seeding: Promise<void> | undefined;

  constructor(
    private readonly db: JobCostStore,
    private readonly logger?: CostLogger,
    private readonly dailySeed?: DailyCostSeed,
  ) {}

  /**
   * Loads the daily total of the startup day (once; a failure is retried by the next call).
   * Called at startup; also called before any read or write of that day's total.
   */
  seedDailyCost(): Promise<void> {
    const seed = this.dailySeed;
    if (!seed || this.seeded) return Promise.resolve();
    this.seeding ??= (async () => {
      try {
        const usd = await seed.load();
        if (!Number.isFinite(usd) || usd < 0) throw new Error('invalid daily cost seed');
        await this.memory.addDailyCost(seed.day, usd);
        this.seeded = true;
      } finally {
        this.seeding = undefined;
      }
    })();
    return this.seeding;
  }

  private async ready(day: string): Promise<void> {
    if (this.dailySeed && day === this.dailySeed.day) await this.seedDailyCost();
  }

  saveToken(record: TokenRecord): Promise<void> {
    return this.memory.saveToken(record);
  }

  getToken(tokenHash: string): Promise<TokenRecord | undefined> {
    return this.memory.getToken(tokenHash);
  }

  revokeToken(tokenHash: string): Promise<void> {
    return this.memory.revokeToken(tokenHash);
  }

  revokeJobTokens(jobId: string): Promise<void> {
    return this.memory.revokeJobTokens(jobId);
  }

  /** Runs `fn` after every previous operation on the same job. */
  private serialize<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(jobId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(jobId, settled);
    void settled.then(() => {
      if (this.chains.get(jobId) === settled) this.chains.delete(jobId);
    });
    return next;
  }

  private async current(jobId: string): Promise<number> {
    const cached = this.costs.get(jobId);
    if (cached !== undefined) return cached;
    // A read error propagates: the gateway then refuses the request (fail closed on the budget).
    const stored = await this.db.getJobCost(jobId);
    this.costs.set(jobId, stored);
    return stored;
  }

  addJobCost(jobId: string, usd: number): Promise<number> {
    return this.serialize(jobId, async () => {
      const total = (await this.current(jobId)) + usd;
      this.costs.set(jobId, total);
      try {
        await this.db.setJobCost(jobId, total);
      } catch (err) {
        // The in-memory total still enforces the budget; the column catches up on the next add.
        this.logger?.warn(
          { jobId, error: err instanceof Error ? err.name : 'unknown' },
          'could not record the job API cost',
        );
      }
      return total;
    });
  }

  getJobCost(jobId: string): Promise<number> {
    return this.serialize(jobId, () => this.current(jobId));
  }

  async addDailyCost(day: string, usd: number): Promise<number> {
    await this.ready(day);
    return this.memory.addDailyCost(day, usd);
  }

  async getDailyCost(day: string): Promise<number> {
    await this.ready(day);
    return this.memory.getDailyCost(day);
  }

  markDailyAlert(day: string): Promise<boolean> {
    return this.memory.markDailyAlert(day);
  }
}
