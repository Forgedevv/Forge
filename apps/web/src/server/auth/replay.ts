/*
 * In-memory record of consumed sign-in nonces, kept until their expiry.
 *
 * Limitation: the store is per server instance. On serverless or multi-instance deployments a
 * captured (message, signature) pair could be replayed once per instance within the nonce
 * lifetime (5 minutes). Move this to a shared store (Supabase table or Redis) to close it.
 */

export const MAX_CONSUMED_NONCES = 50_000;

export class ConsumedNonceStore {
  // Map iteration order is insertion order, which makes eviction oldest-first.
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = MAX_CONSUMED_NONCES) {}

  has(nonce: string, nowSeconds: number): boolean {
    const exp = this.entries.get(nonce);
    if (exp === undefined) return false;
    if (exp <= nowSeconds) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  /** Records `nonce` until `expSeconds`. Returns false if it was already consumed. */
  consume(nonce: string, expSeconds: number, nowSeconds: number): boolean {
    if (this.has(nonce, nowSeconds)) return false;
    this.prune(nowSeconds);
    this.entries.set(nonce, expSeconds);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(nowSeconds: number): void {
    // Nonces share one lifetime, so insertion order is close to expiry order: stop at the
    // first live entry (a stray expired entry behind it is dropped later by has()).
    for (const [nonce, exp] of this.entries) {
      if (exp > nowSeconds) break;
      this.entries.delete(nonce);
    }
    // Still full: drop the oldest entries (they are the closest to expiry).
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

export const consumedNonces = new ConsumedNonceStore();
