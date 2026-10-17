import {
  DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
  maxPriorityFeeLamports,
  type PriorityFeeSetting,
} from '@forge/core';

/**
 * LOCKED ZONE. The priority fee of every transaction this site builds: trades on the curve, coin
 * creation and creator fee claims. It is the default policy of `@forge/core`: the 75th percentile
 * of the recent fees of the accounts the transaction writes (read through the FORGE RPC relay),
 * at least 10,000 and at most 1,000,000 micro-lamports per compute unit, and never more than
 * 0.0005 SOL per transaction. Without it, trades and claims are dropped when the network is busy.
 *
 * Fixed at build time: no prop, environment variable or page of the site can raise it. The
 * browser checks of the coin creation and the claims (`tx/fees.ts`) refuse a transaction above
 * the same cap.
 */
export const SITE_PRIORITY_FEE: PriorityFeeSetting = Object.freeze({});

/**
 * The most a trade on the curve can pay as priority fee (0.00015 SOL: 150,000 compute units at
 * 1,000,000 micro-lamports). Shown next to the quote before anything is built or signed.
 */
export const SWAP_MAX_PRIORITY_FEE_LAMPORTS: bigint = maxPriorityFeeLamports(
  DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
  SITE_PRIORITY_FEE,
);
