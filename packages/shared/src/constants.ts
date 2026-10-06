/**
 * Business constants shared by every FORGE app (docs/INTERFACES.md §1).
 * Percentages are expressed in basis points (bps) unless the name says `Pct`.
 */

export const PRICING = {
  creationUsd: 33,
  modificationUsd: 5.5,
  includedModifications: 2,
  maxAttemptsBeforeRefund: 2,
  quoteValiditySeconds: 120,
} as const;

export const FEES = {
  /** Our fee on our own buy button (before graduation). */
  platformFeeBps: 30,
  /** After graduation; Jupiter keeps 20 % of it. */
  jupiterIntegratorFeeBps: 30,
  /** FORGE creator share on the coin of every launchpad. */
  forgeCreatorSharePct: 25,
} as const;

export const CLIENT_BOUNDS = {
  /** Trading fee range offered to clients. */
  tradingFeeBps: { min: 50, max: 200 },
  coinCreatorSharePct: { min: 0, max: 50, default: 25 },
  /**
   * Coin creation fee set by the client: 0 (no fee) or between 0.001 and 1 SOL
   * (0.001 SOL = MIN_POOL_CREATION_FEE of the SDK). Whether the SDK accepts 0 must be
   * confirmed by devnet test 1; otherwise the minimum becomes 0.001.
   */
  poolCreationFeeSol: { min: 0.001, max: 1, allowZero: true },
  /** Imposed (Meteora migration bots). */
  migrationThresholdSol: 10,
} as const;

export const OPS = {
  dormantDaysBeforeSleep: 30,
  claimIntervalHours: 24,
  agentBudgetUsdPerJob: 15,
  agentTimeoutMinutes: 30,
  /** Past this delay, an active job with no news is considered crashed. */
  jobLockStaleMinutes: 45,
} as const;

/** 1 SOL = 1_000_000_000 lamports. */
export const LAMPORTS_PER_SOL = 1_000_000_000;
