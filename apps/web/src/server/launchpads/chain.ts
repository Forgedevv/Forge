import {
  CLUSTER_GENESIS_HASH,
  ClaimError,
  DbcReadError,
  buildPartnerClaimTx,
  buildPartnerPoolCreationFeeClaimTx,
  listCoinsOfConfig,
  retryRpc,
  type ClaimTxResult,
  type CoinOfConfig,
  type PoolCreationFeeClaimTxResult,
  type RetryOptions,
} from '@forge/core';
import type { Connection, PublicKey } from '@solana/web3.js';
import { ClusterMismatchError, RpcUnavailableError } from '../jobs/chain';
import type { Cluster } from '../jobs/config';

/*
 * The launchpad routes' view of the chain: the client's coins and partner fee claims, through
 * @forge/core only (`listCoinsOfConfig`, `buildPartnerClaimTx`, `buildPartnerPoolCreationFeeClaimTx`).
 * Nothing is signed or sent here: claim transactions go back unsigned to the owner's wallet.
 *
 * Core business errors (`ClaimError`, `DbcReadError`) are passed through for the caller to map;
 * any other failure becomes `RpcUnavailableError` (RPC messages may echo the endpoint and its key).
 */

export interface ClaimsChain {
  assertCluster(): Promise<void>;
  /** Coins (pools) of a config; an unknown config has none. Cached briefly. */
  listCoins(config: PublicKey): Promise<CoinOfConfig[]>;
  /** Unsigned partner trading fee claim, fee payer and receiver = the owner. */
  buildPartnerClaim(pool: PublicKey, owner: PublicKey): Promise<ClaimTxResult>;
  /** Unsigned partner pool creation fee claim, fee payer and receiver = the owner. */
  buildPoolCreationFeeClaim(
    pool: PublicKey,
    owner: PublicKey,
  ): Promise<PoolCreationFeeClaimTxResult>;
}

export const COINS_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 2_000;

function passThrough(error: unknown): never {
  if (error instanceof ClaimError || error instanceof DbcReadError) throw error;
  throw new RpcUnavailableError();
}

export interface CoreClaimsChainOptions {
  connection: Connection;
  cluster: Cluster;
  retry?: RetryOptions;
  now?: () => number;
}

export function createCoreClaimsChain(options: CoreClaimsChainOptions): ClaimsChain {
  const { connection, cluster, retry } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; coins: CoinOfConfig[] }>();
  let genesisChecked = false;
  const common = { commitment: 'confirmed' as const, ...(retry ? { retry } : {}) };

  return {
    async assertCluster() {
      if (genesisChecked) return;
      let genesis: string;
      try {
        genesis = await retryRpc(() => connection.getGenesisHash(), retry);
      } catch {
        throw new RpcUnavailableError();
      }
      if (genesis !== CLUSTER_GENESIS_HASH[cluster]) throw new ClusterMismatchError();
      genesisChecked = true;
    },

    async listCoins(config) {
      const key = config.toBase58();
      const hit = cache.get(key);
      if (hit && now() - hit.at < COINS_CACHE_TTL_MS) return hit.coins;
      let coins: CoinOfConfig[];
      try {
        coins = await listCoinsOfConfig(connection, config, common);
      } catch (error) {
        if (error instanceof DbcReadError && error.code === 'config_not_found') coins = [];
        else passThrough(error);
      }
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(key, { at: now(), coins });
      return coins;
    },

    async buildPartnerClaim(pool, owner) {
      try {
        // Skips claims that would cost the owner more than they collect.
        return await buildPartnerClaimTx(
          connection,
          { pool, feeClaimer: owner, receiver: owner, payer: owner },
          { ...common, minNetLamports: 0n },
        );
      } catch (error) {
        passThrough(error);
      }
    },

    async buildPoolCreationFeeClaim(pool, owner) {
      try {
        return await buildPartnerPoolCreationFeeClaimTx(
          connection,
          { pool, feeClaimer: owner, receiver: owner, payer: owner },
          common,
        );
      } catch (error) {
        passThrough(error);
      }
    },
  };
}
