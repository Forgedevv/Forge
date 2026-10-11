/**
 * Lamports of the payer wallet promised to transactions that are signed and sent but not settled
 * yet (the account creations of the signing routes).
 *
 * A balance read does not show a transaction that has not landed. Without this registry, two
 * creations a few seconds apart would both see the same lamports, and the second could fail
 * on-chain (or starve a claim) once the first lands. Every balance check of the payer wallet
 * subtracts what is still reserved.
 *
 * A reservation ends when its transaction settles (the owner releases it), or by itself once the
 * FINALIZED block height is past its last valid block height: by then it either landed (and the
 * finalized balance shows it) or never will. One registry per process, shared by the routes and
 * the jobs that check the payer balance; the payer lock serializes the checks themselves.
 */
import { withRetry, type RetryOptions, type SettlementRpc } from './shared.js';

interface Reservation {
  lamports: bigint;
  lastValidBlockHeight: number;
}

export class PayerReservations {
  readonly #items = new Map<string, Reservation>();

  /** Reserves `lamports` for the transaction `signature` (idempotent per signature). */
  reserve(signature: string, lamports: bigint, lastValidBlockHeight: number): void {
    if (lamports < 0n) throw new Error('a reservation cannot be negative');
    this.#items.set(signature, { lamports, lastValidBlockHeight });
  }

  /** Ends the reservation of a settled transaction (no-op when unknown). */
  release(signature: string): void {
    this.#items.delete(signature);
  }

  has(signature: string): boolean {
    return this.#items.has(signature);
  }

  get size(): number {
    return this.#items.size;
  }

  /**
   * Lamports still reserved. Reservations whose blockhash is past the finalized block height are
   * dropped first (one RPC read, only when something is reserved).
   */
  async outstanding(
    rpc: Pick<SettlementRpc, 'getBlockHeight'>,
    retry: RetryOptions,
  ): Promise<bigint> {
    if (this.#items.size === 0) return 0n;
    const finalizedHeight = await withRetry(() => rpc.getBlockHeight('finalized'), retry);
    let total = 0n;
    for (const [signature, r] of this.#items) {
      if (finalizedHeight > r.lastValidBlockHeight) {
        this.#items.delete(signature);
        continue;
      }
      total += r.lamports;
    }
    return total;
  }
}
