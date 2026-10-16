import { PLATFORM_FEE_BPS, platformFeeLamports } from '@forge/core';
import { canonicalAddress } from '../tx/programs';

/**
 * LOCKED ZONE. The FORGE platform fee on the first buy of a coin created on this site: the same
 * 0.3% (`PLATFORM_FEE_BPS`, rounded up to the lamport) as on every swap built by @forge/core,
 * paid in the launch transaction by ONE SOL transfer to `FORGE_PLATFORM_FEE_WALLET` (the last
 * instruction). Core builds it (`buildUserCoinLaunchTx`); the browser verifier (`verify.ts`)
 * accepts exactly that transfer and nothing else.
 */

export { PLATFORM_FEE_BPS };

/** Platform fee of a first buy, in lamports (0 without a first buy). Computed by @forge/core. */
export function firstBuyPlatformFee(firstBuyLamports: bigint): bigint {
  return firstBuyLamports > BigInt(0)
    ? platformFeeLamports(firstBuyLamports, PLATFORM_FEE_BPS)
    : BigInt(0);
}

/**
 * The platform fee wallet, from the public environment (a literal `NEXT_PUBLIC_*` read, replaced
 * by its build-time value: nothing at runtime can change it). Same value on the server, which
 * builds the launch, and in the browser, which verifies it. Null when absent or invalid: a coin
 * with a first buy cannot be created then (fail closed).
 */
export function launchPlatformFeeWallet(): string | null {
  return canonicalAddress(process.env.NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET);
}
