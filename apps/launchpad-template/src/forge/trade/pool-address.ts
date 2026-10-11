import { canonicalAddress, dbcPoolAddress } from '../tx/programs';

/**
 * LOCKED ZONE. Bonding curve pool of a coin of THIS launchpad, derived from the launchpad config
 * (`forge.config.json#onchain.launchpadConfig`) and the coin mint. The pool address shown by an
 * indexer is never trusted for trading: a coin that is not on this launchpad's config simply has no
 * pool here, and the trade panel then refuses to trade it.
 *
 * Returns null when the mint or the config is not a valid, canonical address.
 */
export function launchpadPoolForMint(
  mint: string | undefined | null,
  launchpadConfig: string | undefined | null,
): string | null {
  const coin = canonicalAddress(mint);
  const config = canonicalAddress(launchpadConfig);
  if (!coin || !config || coin === config) return null;
  try {
    return dbcPoolAddress(config, coin);
  } catch {
    return null;
  }
}
