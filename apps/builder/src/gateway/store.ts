/**
 * Persistence used by the gateway. The worker backs `addJobCost`/`getJobCost`
 * with Supabase `jobs.api_cost_usd` (the increment must be atomic, e.g. an
 * `update ... set api_cost_usd = api_cost_usd + $1 returning api_cost_usd`).
 * Tokens are stored by SHA-256 hash only, never in clear.
 */

export interface TokenRecord {
  /** SHA-256 hex of the opaque token. */
  tokenHash: string;
  jobId: string;
  budgetUsd: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  revoked: boolean;
}

export interface GatewayStore {
  saveToken(record: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | undefined>;
  /** Marks the token revoked. Unknown hashes are ignored. */
  revokeToken(tokenHash: string): Promise<void>;
  /** Revokes every token of a job. */
  revokeJobTokens(jobId: string): Promise<void>;
  /** Atomically adds `usd` to the job's cost and returns the new total. */
  addJobCost(jobId: string, usd: number): Promise<number>;
  getJobCost(jobId: string): Promise<number>;
  /** Atomically adds `usd` to the total of `day` (YYYY-MM-DD, UTC) and returns it. */
  addDailyCost(day: string, usd: number): Promise<number>;
  getDailyCost(day: string): Promise<number>;
  /** Returns true only the first time it is called for `day` (alert dedup). */
  markDailyAlert(day: string): Promise<boolean>;
}

/** In-memory store, for tests and single-process use. */
export class InMemoryGatewayStore implements GatewayStore {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly jobCosts = new Map<string, number>();
  private readonly dailyCosts = new Map<string, number>();
  private readonly alertedDays = new Set<string>();

  async saveToken(record: TokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, { ...record });
  }

  async getToken(tokenHash: string): Promise<TokenRecord | undefined> {
    const record = this.tokens.get(tokenHash);
    return record ? { ...record } : undefined;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    const record = this.tokens.get(tokenHash);
    if (record) record.revoked = true;
  }

  async revokeJobTokens(jobId: string): Promise<void> {
    for (const record of this.tokens.values()) {
      if (record.jobId === jobId) record.revoked = true;
    }
  }

  async addJobCost(jobId: string, usd: number): Promise<number> {
    const total = (this.jobCosts.get(jobId) ?? 0) + usd;
    this.jobCosts.set(jobId, total);
    return total;
  }

  async getJobCost(jobId: string): Promise<number> {
    return this.jobCosts.get(jobId) ?? 0;
  }

  async addDailyCost(day: string, usd: number): Promise<number> {
    const total = (this.dailyCosts.get(day) ?? 0) + usd;
    this.dailyCosts.set(day, total);
    return total;
  }

  async getDailyCost(day: string): Promise<number> {
    return this.dailyCosts.get(day) ?? 0;
  }

  async markDailyAlert(day: string): Promise<boolean> {
    if (this.alertedDays.has(day)) return false;
    this.alertedDays.add(day);
    return true;
  }
}
