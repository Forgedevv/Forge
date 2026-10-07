/*
 * Record of consumed sign-in nonces, kept until their expiry.
 *
 * NonceStore is pluggable. The default ConsumedNonceStore below is per server instance: on
 * serverless or multi-instance deployments a captured (message, signature) pair could be
 * replayed once per instance within the nonce lifetime (5 minutes). Deployments that need
 * strict single use should supply a shared implementation through verifySignIn's `store`.
 *
 * Design note, Supabase-backed store (service role only; the table is NOT created here):
 *
 *   create table public.consumed_nonces (
 *     nonce      text primary key,
 *     expires_at timestamptz not null
 *   );
 *   create index consumed_nonces_expires_at_idx on public.consumed_nonces (expires_at);
 *   alter table public.consumed_nonces enable row level security;  -- no policies
 *
 *   consume(nonce, exp): insert (nonce, to_timestamp(exp)); a unique violation (23505)
 *     means already consumed -> return false. Any other error must throw, so sign-in fails
 *     closed. An expired row for the same nonce can be deleted first, or the insert can be an
 *     upsert guarded by `expires_at <= now()`.
 *   has(nonce, now): select 1 where nonce = $1 and expires_at > to_timestamp(now).
 *   Cleanup: periodically `delete from consumed_nonces where expires_at < now()`.
 */
export interface NonceStore {
  /** True when `nonce` has been consumed and has not yet expired. */
  has(nonce: string, nowSeconds: number): boolean | Promise<boolean>;
  /** Atomically records `nonce` until `expSeconds`. Resolves false if it was already consumed. */
  consume(nonce: string, expSeconds: number, nowSeconds: number): boolean | Promise<boolean>;
}

export const MAX_CONSUMED_NONCES = 50_000;

/** In-memory NonceStore (per process). */
export class ConsumedNonceStore implements NonceStore {
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
