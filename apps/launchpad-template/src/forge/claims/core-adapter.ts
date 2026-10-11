import type { VersionedTransaction } from '@solana/web3.js';

/**
 * LOCKED ZONE. Local adapter between the claim UI and `@forge/core`.
 *
 * SWITCH TO @forge/core AT MERGE: implement `ClaimsCore` with
 *  - `listCoinsOfConfig(connection, config)` (reads.ts), keeping the pools whose `creator` is the
 *    connected wallet, and `feeMetrics(state).claimable.creator` ({ base, quote }) for each pool;
 *  - `buildCreatorClaimTx(pool, creator, receiver)` (claims.ts), with `receiver` = the connected
 *    wallet, converted to a `VersionedTransaction` with a recent blockhash and the wallet as fee
 *    payer.
 * Names and symbols come from the coin metadata (Jupiter data API, or the on-chain metadata
 * account as plan B). Until then the default export refuses to run instead of showing fake data.
 */

export interface CreatorCoin {
  /** DBC pool address. */
  pool: string;
  mint: string;
  name?: string;
  symbol?: string;
  /** Graduated coins are claimed on the migrated pool; the adapter hides that difference. */
  graduated: boolean;
  /** Claimable creator fees in the quote currency (SOL), lamports. */
  claimableQuoteLamports: bigint;
  /** Claimable creator fees in the coin itself, raw units. Usually 0 (quote-only fee mode). */
  claimableBaseRaw: bigint;
  baseDecimals: number;
}

export interface ClaimsCore {
  /** Coins of this launchpad created by `creator`, with their claimable creator fees. */
  listCreatorCoins(creator: string): Promise<CreatorCoin[]>;
  /**
   * Builds the creator claim of one pool. `receiver` is always the connected wallet in this UI.
   * The returned transaction has `creator` as fee payer and only the creator's signature missing.
   */
  buildCreatorClaimTx(args: {
    pool: string;
    creator: string;
    receiver: string;
  }): Promise<VersionedTransaction>;
}

/** Default adapter until `@forge/core` is wired at merge: fails loudly, never returns fake data. */
export const unavailableClaimsCore: ClaimsCore = {
  async listCreatorCoins() {
    throw new Error('Fee claims are not available yet.');
  },
  async buildCreatorClaimTx() {
    throw new Error('Fee claims are not available yet.');
  },
};

export const claimsCore: ClaimsCore = unavailableClaimsCore;
