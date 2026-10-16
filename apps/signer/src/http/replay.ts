/*
 * In-memory cache of the request nonces already accepted (the server records a nonce only after
 * its signature verified). A nonce is kept until its timestamp leaves the accepted window
 * (timestamp + max skew), after which the timestamp check alone rejects the request. The cache is bounded: when it is full of live entries, new requests are refused
 * (fail closed) instead of evicting an entry, which would reopen a replay.
 *
 * The cache is per process: the signer must run as a single instance.
 */

export type ReplayResult = 'fresh' | 'replay' | 'full';

export class ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly windowSeconds: number,
    private readonly maxEntries: number,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('ReplayCache maxEntries must be a positive integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Records `key` (timestamp `tsSeconds`) and says whether it was new. Check and insert are one
   * synchronous step, so two concurrent identical requests cannot both pass.
   */
  checkAndRemember(key: string, tsSeconds: number, nowSeconds: number): ReplayResult {
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined) {
      if (expiresAt >= nowSeconds) return 'replay';
      this.entries.delete(key);
    }
    if (this.entries.size >= this.maxEntries) {
      this.sweep(nowSeconds);
      if (this.entries.size >= this.maxEntries) return 'full';
    }
    this.entries.set(key, tsSeconds + this.windowSeconds);
    return 'fresh';
  }

  /** Removes the expired entries. */
  sweep(nowSeconds: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt < nowSeconds) this.entries.delete(key);
    }
  }
}
