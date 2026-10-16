import { PublicKey, type Connection } from '@solana/web3.js';
import { onchainConfig } from '../config';
import { DBC_PROGRAM_ID, canonicalAddress } from '../tx/programs';
import { launchpadPoolForMint } from './pool-address';

/**
 * LOCKED ZONE. Which pools this site trades: only the coins of THIS launchpad, i.e. the DBC pools
 * on its two configs (`forge.config.json#onchain`): `launchpadConfig` (the coins its users create)
 * and `launchpadCoinConfig` (the launchpad's own coin). A pool is never taken from a prop, a URL
 * or an indexer: it is derived from the mint and these configs, then looked up on-chain. The
 * swap adapter checks the config again, on-chain, before every quote and transaction
 * (`allowedConfigs` of @forge/core).
 *
 * `forge.config.json` is bundled and frozen (`config.ts`), so nothing at runtime can add a config.
 */

/** The DBC configs of this launchpad, valid and distinct; empty before the on-chain setup. */
export function launchpadConfigs(): string[] {
  const configs: string[] = [];
  for (const raw of [onchainConfig?.launchpadConfig, onchainConfig?.launchpadCoinConfig]) {
    const key = canonicalAddress(raw);
    if (key && !configs.includes(key)) configs.push(key);
  }
  return configs;
}

/**
 * The configs the coin lists (data API, stream) are filtered on: this launchpad's configs, or,
 * before the on-chain setup, the valid addresses of `NEXT_PUBLIC_POOL_CONFIG_KEY`. Empty means
 * "no list": callers must not query the data API without a filter (it would list every coin).
 */
export function listedConfigs(): string[] {
  const configs = launchpadConfigs();
  if (configs.length > 0) return configs;
  const fromEnv: string[] = [];
  for (const raw of (process.env.NEXT_PUBLIC_POOL_CONFIG_KEY ?? '').split(',')) {
    const key = canonicalAddress(raw.trim());
    if (key && !fromEnv.includes(key)) fromEnv.push(key);
  }
  return fromEnv;
}

/** A pool of this launchpad, as found on-chain by `findLaunchpadPool` (the only way to get one). */
export interface LaunchpadPool {
  readonly mint: string;
  readonly pool: string;
  readonly config: string;
}

const issued = new WeakSet<object>();

/**
 * True only for a pool handle issued by `findLaunchpadPool` in this page: the trade form, the
 * quote and the execution refuse anything else, so no component can be handed a raw pool address.
 */
export function isLaunchpadPool(value: unknown): value is LaunchpadPool {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/** The pool address of an issued handle, or null for anything else. */
export function launchpadPoolKey(value: unknown): PublicKey | null {
  return isLaunchpadPool(value) ? new PublicKey(value.pool) : null;
}

/** The pools `mint` would have on this launchpad's configs (derived, nothing read). */
export function candidatePools(mint: string): { config: string; pool: string }[] {
  const candidates: { config: string; pool: string }[] = [];
  for (const config of launchpadConfigs()) {
    const pool = launchpadPoolForMint(mint, config);
    if (pool) candidates.push({ config, pool });
  }
  return candidates;
}

/**
 * Finds the pool of `mint` on this launchpad: the first candidate (users' config, then the
 * launchpad coin's) whose account exists and belongs to the DBC program. A pool address is a PDA
 * of its config and its mint, so an account there is that config's pool. A graduated coin keeps
 * its DBC pool account: the panel then routes it to Jupiter. Null when the coin is not on this
 * launchpad (or before the on-chain setup).
 *
 * @throws network errors of the relay (the panel offers a retry).
 */
export async function findLaunchpadPool(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: string,
): Promise<LaunchpadPool | null> {
  const coin = canonicalAddress(mint);
  if (!coin) return null;
  for (const candidate of candidatePools(coin)) {
    const info = await connection.getAccountInfo(new PublicKey(candidate.pool), 'confirmed');
    if (info && info.owner.toBase58() === DBC_PROGRAM_ID) {
      const handle: LaunchpadPool = Object.freeze({ mint: coin, ...candidate });
      issued.add(handle);
      return handle;
    }
  }
  return null;
}
