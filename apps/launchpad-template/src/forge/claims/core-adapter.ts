import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import {
  ClaimError,
  DbcReadError,
  FORGE_TOKEN_SETTINGS,
  buildCreatorClaimTx as coreBuildCreatorClaimTx,
  listCoinsOfConfig,
} from '@forge/core';
import { forgeConfig } from '../config';
import { getRelayConnection } from '../trade/connection';

/**
 * LOCKED ZONE. Adapter between the claim UI and `@forge/core`; a thin wrapper:
 *  - `listCoinsOfConfig` (reads.ts) lists the pools of the launchpad config, the adapter keeps the
 *    ones whose `creator` is the connected wallet and reads their claimable creator share from the
 *    `fees` of each coin;
 *  - `buildCreatorClaimTx` (claims.ts) builds the claim with `receiver` = the connected wallet; the
 *    legacy transaction it returns is wrapped in a `VersionedTransaction` for the signing flow, and
 *    the costs the core computed (`summary.costs`: network fee, the coin account rent of a first
 *    claim, the temporary WSOL rent) are handed over as they are, for the review and balance check.
 * Every chain read goes through the FORGE RPC relay connection. Names and symbols are not read
 * here (the UI falls back to the coin address).
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

/** What the claim costs the wallet (fee payer), lamports, as computed by `@forge/core`. */
export interface CreatorClaimCosts {
  /** Signature fees (no priority fee). */
  networkFeeLamports: bigint;
  /** Rent of the wallet's coin account, created on the first claim of a pool (0 when it exists). */
  receiverTokenAccountRentLamports: bigint;
  /** WSOL account rent advanced during the transaction and refunded in it. */
  temporaryLamports: bigint;
  /** What the wallet balance decreases by: network fee + one-time rent. */
  payerTotalLamports: bigint;
  /** Balance the wallet needs before signing: total + temporary. */
  payerRequiredBalanceLamports: bigint;
}

export interface CreatorClaimBuild {
  tx: VersionedTransaction;
  costs: CreatorClaimCosts;
}

export interface ClaimsCore {
  /** Coins of this launchpad created by `creator`, with their claimable creator fees. */
  listCreatorCoins(creator: string): Promise<CreatorCoin[]>;
  /**
   * Builds the creator claim of one pool. `receiver` is always the connected wallet in this UI.
   * The returned transaction has `creator` as fee payer and only the creator's signature missing;
   * `costs` are the core's figures for that transaction.
   */
  buildCreatorClaimTx(args: {
    pool: string;
    creator: string;
    receiver: string;
  }): Promise<CreatorClaimBuild>;
}

export interface CoreClaimsOptions {
  /** Connection to the FORGE RPC relay, or null when it is not configured. */
  getConnection: () => Connection | null;
  /** `forge.config.json#onchain.launchpadConfig` (and any further config of this launchpad). */
  launchpadConfigs: readonly string[];
}

function requireConnection(options: CoreClaimsOptions): Connection {
  const connection = options.getConnection();
  if (!connection) throw new Error('Fee claims are not configured on this site.');
  return connection;
}

/** Claims core backed by `@forge/core`. */
export function createCoreClaimsCore(options: CoreClaimsOptions): ClaimsCore {
  return {
    async listCreatorCoins(creator) {
      const connection = requireConnection(options);
      if (options.launchpadConfigs.length === 0) return [];
      const owner = new PublicKey(creator);
      const perConfig = await Promise.all(
        options.launchpadConfigs.map(async (config) => {
          try {
            return await listCoinsOfConfig(connection, new PublicKey(config));
          } catch (error) {
            if (error instanceof DbcReadError && error.code === 'config_not_found') return [];
            throw error;
          }
        }),
      );
      return perConfig
        .flat()
        .filter((coin) => coin.creator.equals(owner))
        .map((coin) => ({
          pool: coin.pool.toBase58(),
          mint: coin.baseMint.toBase58(),
          graduated: coin.graduation !== 'trading',
          claimableQuoteLamports: coin.fees.claimable.creator.quote,
          claimableBaseRaw: coin.fees.claimable.creator.base,
          baseDecimals: FORGE_TOKEN_SETTINGS.tokenBaseDecimal,
        }));
    },

    async buildCreatorClaimTx({ pool, creator, receiver }) {
      const connection = requireConnection(options);
      let result;
      try {
        result = await coreBuildCreatorClaimTx(connection, {
          pool: new PublicKey(pool),
          creator: new PublicKey(creator),
          receiver: new PublicKey(receiver),
        });
      } catch (error) {
        if (error instanceof ClaimError || error instanceof DbcReadError) {
          throw new Error(error.message, { cause: error });
        }
        throw error;
      }
      if (!result.transaction) {
        throw new Error('There is nothing to claim for this coin.');
      }
      const { costs } = result.summary;
      // Fee payer and blockhash are set by the core; no signature is attached yet.
      return {
        tx: new VersionedTransaction(result.transaction.compileMessage()),
        costs: {
          networkFeeLamports: costs.networkFeeLamports,
          receiverTokenAccountRentLamports: costs.receiverTokenAccountRentLamports,
          temporaryLamports: costs.temporaryLamports,
          payerTotalLamports: costs.payerTotalLamports,
          payerRequiredBalanceLamports: costs.payerRequiredBalanceLamports,
        },
      };
    },
  };
}

/** Production adapter: reads and builds through `@forge/core` on this launchpad's config. */
export const claimsCore: ClaimsCore = createCoreClaimsCore({
  getConnection: () => getRelayConnection(),
  launchpadConfigs: forgeConfig.onchain ? [forgeConfig.onchain.launchpadConfig] : [],
});
