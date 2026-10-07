/**
 * Constants used by the transaction core.
 *
 * - Business constants come from `@forge/shared` (docs/INTERFACES.md §1) and are re-exported as is.
 * - Meteora DBC bounds come from `@meteora-ag/dynamic-bonding-curve-sdk` (pinned 1.5.13) and are
 *   re-exported from the SDK, never retyped (docs/METEORA.md, "Bounds").
 * - Lamport values derived from them are `bigint`, so money is never handled as a float.
 */
import { NATIVE_MINT, NATIVE_MINT_2022 } from '@solana/spl-token';
import { CLIENT_BOUNDS, FEES, LAMPORTS_PER_SOL, OPS, PRICING } from '@forge/shared';

export { CLIENT_BOUNDS, FEES, LAMPORTS_PER_SOL, OPS, PRICING };

export {
  FEE_DENOMINATOR,
  HOST_FEE_PERCENT,
  MAX_BASIS_POINT,
  MAX_CREATOR_MIGRATION_FEE_PERCENTAGE,
  MAX_FEE_BPS,
  MAX_FEE_NUMERATOR,
  MAX_MIGRATED_POOL_FEE_BPS,
  MAX_MIGRATION_FEE_PERCENTAGE,
  MAX_POOL_CREATION_FEE,
  MAX_PRICE_CHANGE_BPS_DEFAULT,
  MIN_FEE_BPS,
  MIN_FEE_NUMERATOR,
  MIN_LOCKED_LIQUIDITY_BPS,
  MIN_MIGRATED_POOL_FEE_BPS,
  MIN_POOL_CREATION_FEE,
  PROTOCOL_FEE_PERCENT,
  PROTOCOL_POOL_CREATION_FEE_PERCENT,
  SECONDS_PER_DAY,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

/** Quote mint of every FORGE pool: wrapped SOL (classic SPL token program). */
export const SOL_QUOTE_MINT = NATIVE_MINT;
/** Token-2022 wrapped SOL: never a valid quote mint (the SDK rejects it too). */
export const SOL_QUOTE_MINT_2022 = NATIVE_MINT_2022;

/** Number of decimals of SOL: 1 SOL = 10^9 lamports. */
export const SOL_DECIMALS = 9;

/** `LAMPORTS_PER_SOL` as a bigint. */
export const LAMPORTS_PER_SOL_BIGINT = BigInt(LAMPORTS_PER_SOL);

/** Largest SOL amount `solToLamports` accepts (far above any FORGE amount). */
export const MAX_CONVERTIBLE_SOL = 1_000_000;

/**
 * Converts a SOL amount to lamports without floating point drift.
 * Throws when the amount is not finite, negative, or has more precision than one lamport
 * (e.g. `0.1 + 0.2`), so an imprecise value can never be rounded silently.
 */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol)) throw new RangeError('SOL amount must be a finite number');
  if (sol < 0) throw new RangeError('SOL amount must not be negative');
  // Above this, a float can no longer hold 9 exact decimals.
  if (sol > MAX_CONVERTIBLE_SOL) throw new RangeError('SOL amount is too large');
  const fixed = sol.toFixed(SOL_DECIMALS);
  if (Number(fixed) !== sol) {
    throw new RangeError(`SOL amount must have at most ${SOL_DECIMALS} decimals`);
  }
  const [whole = '0', fraction = ''] = fixed.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL_BIGINT + BigInt(fraction.padEnd(SOL_DECIMALS, '0'));
}

/** Imposed migration (graduation) threshold, in lamports: exactly 10 SOL. */
export const MIGRATION_THRESHOLD_LAMPORTS = solToLamports(CLIENT_BOUNDS.migrationThresholdSol);

/**
 * Client pool creation fee bounds in lamports (0 allowed when `allowZero`).
 * The SDK bounds (`MIN_POOL_CREATION_FEE` / `MAX_POOL_CREATION_FEE`) are checked as well.
 */
export const CLIENT_POOL_CREATION_FEE_LAMPORTS = {
  min: solToLamports(CLIENT_BOUNDS.poolCreationFeeSol.min),
  max: solToLamports(CLIENT_BOUNDS.poolCreationFeeSol.max),
  allowZero: CLIENT_BOUNDS.poolCreationFeeSol.allowZero,
} as const;
