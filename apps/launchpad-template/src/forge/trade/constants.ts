import { FEES } from '@forge/shared';

/** FORGE platform fee on swaps built by the core (basis points). Single source: @forge/shared. */
export const PLATFORM_FEE_BPS = FEES.platformFeeBps;

/** Jupiter integrator fee applied after graduation (basis points). */
export const JUPITER_REFERRAL_FEE_BPS = FEES.jupiterIntegratorFeeBps;

/** Slippage bounds, in basis points. The UI refuses anything outside [MIN, MAX]. */
export const SLIPPAGE_BPS = {
  min: 10,
  default: 100,
  max: 2500,
  /** Above this value the panel shows a warning. */
  warnAbove: 500,
} as const;

/** Price impact (bps) above which the quote is highlighted as risky. */
export const PRICE_IMPACT_WARN_BPS = 500;

/** Token amounts: DBC coins are created with 6 decimals by default. */
export const DEFAULT_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;

/** Fixed Solana fee per signature. Used only for the pre-sign estimate. */
export const LAMPORTS_PER_SIGNATURE = BigInt(5_000);

/** Size of an SPL token account, used to read the rent from the cluster. */
export const TOKEN_ACCOUNT_SIZE = 165;

/** Timings. Overridable through props for tests. */
export const QUOTE_DEBOUNCE_MS = 350;
export const QUOTE_REFRESH_MS = 15_000;
export const CONFIRM_TIMEOUT_MS = 60_000;
export const CONFIRM_POLL_MS = 1_500;
