import type { CoinOfConfig } from '@forge/core';

/*
 * Which on-chain coins are the launchpad's. Anyone can create a pool on any DBC config, so the
 * pools listed on a launchpad's configs (`listCoinsOfConfig`) include look-alikes:
 * - the launchpad config hosts the coins created through the launchpad: every pool on it is a
 *   coin of the launchpad (coinsCount, claims), whoever created it;
 * - the launchpad coin config exists for ONE coin, the launchpad's own: `launchpads.
 *   launchpad_coin_mint`, recorded when the owner's launch landed. Any other pool on it is not
 *   official and is left out of every API answer (claimable fees, claims, pool lookups): a
 *   look-alike coin must never pass for the launchpad's coin. Before the launch (no mint
 *   recorded) the coin config has no official coin at all.
 */

export interface OfficialCoins {
  /** The launchpad's coin (at most one pool), or nothing before the launch. */
  official: CoinOfConfig[];
  /** Other pools found on the coin config, excluded. */
  lookalikes: number;
}

/** Keeps only the pool of `launchpadCoinMint` among the coins of the launchpad coin config. */
export function officialCoinsOfCoinConfig(
  coins: readonly CoinOfConfig[],
  launchpadCoinMint: string | null,
): OfficialCoins {
  const official =
    launchpadCoinMint === null
      ? []
      : coins.filter((coin) => coin.baseMint.toBase58() === launchpadCoinMint);
  return { official, lookalikes: coins.length - official.length };
}
