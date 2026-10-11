import { InMemoryGatewayStore, type GatewayStore, type TokenRecord } from '../gateway/index.js';
import type { JobCostStore } from './store.js';

/** Logger shape (pino compatible). */
interface CostLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Gateway store for the builder process: tokens and daily totals in memory (the gateway and the
 * worker run in the same process, and tokens never outlive a job), per-job cost persisted in
 * `jobs.api_cost_usd` so the $ budget of a job spans its build attempts and survives a restart.
 *
 * Increments are serialized per job inside this process. Only the worker running a job issues its
 * tokens, so no other process adds to the same job concurrently. (An atomic SQL increment would
 * remove that assumption; see the change requests of the task report.)
 */
export class PersistentCostGatewayStore implements GatewayStore {
  private readonly memory = new InMemoryGatewayStore();
  private readonly costs = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: JobCostStore,
    private readonly logger?: CostLogger,
  ) {}

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

  addDailyCost(day: string, usd: number): Promise<number> {
    return this.memory.addDailyCost(day, usd);
  }

  getDailyCost(day: string): Promise<number> {
    return this.memory.getDailyCost(day);
  }

  markDailyAlert(day: string): Promise<boolean> {
    return this.memory.markDailyAlert(day);
  }
}
