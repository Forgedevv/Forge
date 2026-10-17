/**
 * $FORGE buyback job (tasks/05-SIGNER.md "buyback.ts", docs/DECISIONS.md D8, docs/SECURITY.md
 * sections 7 and 8, docs/OPERATIONS.md "Kill switches" and "Automatic tasks").
 *
 * D8: 100% of the trading revenue buys $FORGE back; nothing is burnt, the tokens are held in the
 * treasury (the Squads multisig vault). The bot only has a daily Squads spending limit to its own
 * wallet (SECURITY.md 7) and buys in small amounts at random times with a slippage capped at 1%
 * (SECURITY.md 8).
 *
 * Daily flow:
 *   1. Budget (D35). The budget source (jobs/buyback-budget.ts) reports the revenue backlog: the
 *      trading revenue that reached the vault since BUYBACK_REVENUE_SINCE (revenue forwards and
 *      the creator claims to the vault, finalized only; never a client payment) minus what the
 *      buyback already took out of the vault since then (its spending-limit withdrawals;
 *      simulated orders move nothing and count for nothing). The day's budget = min(backlog +
 *      the SOL already on the bot above its reserve, BUYBACK_DAILY_CAP_LAMPORTS, and in live
 *      mode what the bot can fund: that SOL plus the spending limit still available, minus the
 *      fee allowance of the orders and the withdrawal's fee). What the cap leaves out stays in
 *      the backlog and is bought on the following days. A budget the source cannot establish (journal unreadable, a
 *      corrupt entry, BUYBACK_REVENUE_SINCE unset) is 0 for the run, with a high alert, and no
 *      plan is written: the next tick tries again. Without a budget source (direct callers) the
 *      cap alone is the budget.
 *   2. Plan. The day (UTC) is split into N equal segments with a random time in each, and the
 *      budget into N random amounts in [min order, max order] (`planDay`, injectable RNG; the
 *      configuration is refused when the cap could not fit in N maximum orders). The plan is
 *      written to the journal before anything else, so a restart reuses it (never re-rolls).
 *      Slots already in the past when the plan is created are `missed` (no catch-up burst).
 *   3. Funding (live). Once per day the missing SOL (the planned orders plus a fee allowance per
 *      order, minus what the bot already holds above its reserve, plus the withdrawal's own fee)
 *      is withdrawn from the vault to the bot wallet through the `SpendingLimitWithdrawer`
 *      (jobs/squads.ts: the bot's own Squads v4 spending limit, SECURITY.md 7). The request is
 *      journaled BEFORE it is made and never repeated that day.
 *   4. Orders. Each run executes at most one due slot (TWAP: the day's budget in several slices
 *      at random times). A slot later than `maxLatenessMs` is `missed`. Simulation: quote (if
 *      $FORGE and a quote source exist; asked for the vault as taker, since simulation never reads
 *      the keystore) and log the would-be order. Live: quote (ExactIn SOL -> FORGE_MINT, slippage
 *      <= 100 bps, price impact <= cap, for the bot as taker), swap transaction from the route
 *      (Jupiter: JUPITER_SWAP_API=v2 by default, the bot assembles it from the Swap API V2 build
 *      with its own compute budget, jobs/jupiter-v2.ts; v1 the Metis API's transaction), static
 *      allowlist (Jupiter: `verifySwapTransaction` from convert.ts with the route arguments
 *      decoded and bound to the quote and the slippage cap; devnet DBC: `assertDbcBuyTx` in
 *      buyback-dbc.ts), simulation with the post-state of every account the bot holds
 *      (`compareBuybackStates`), kill switch re-read, sign, journal (signature + bytes),
 *      `onBeforeSend`, send, settle by polling. One attempt per slot: a slot that may have reached
 *      the network is never retried.
 *   5. Return. Any $FORGE on the bot wallet is transferred to the vault's associated token
 *      account (`assertForgeReturnTx` policy, preflight simulation, journaled in flight), with a
 *      priority fee priced like the signer's other transactions (SIGNER_PRIORITY_FEE_*,
 *      jobs/priority.ts). The leftover SOL stays on the bot within its fee reserve.
 *
 * Fees: each order's fee allowance covers the buy (BUYBACK_MAX_PRIORITY_FEE_LAMPORTS) and its
 * return (the signer priority fee cap at FORGE_RETURN_COMPUTE_UNITS), network fees included; the
 * funding withdrawal adds its own fee (`SpendingLimitWithdrawer.maxFeeLamports`) to the amount it
 * withdraws. The reserve is never what pays them.
 *
 * Routes (BUYBACK_ROUTE): `jupiter` (default, the only route allowed on mainnet-beta) and
 * `dbc-devnet` (devnet only: Jupiter does not index devnet, so a devnet test buys the stand-in
 * coin straight from its DBC pool with @forge/core `buildBuyTx`; a startup error on mainnet-beta).
 *
 * Modes: `simulation` is the default. Live needs FORGE_BUYBACK_LIVE = true, FORGE_MINT and a
 * withdrawer, and either SOLANA_CLUSTER = mainnet-beta with the Jupiter route, or SOLANA_CLUSTER =
 * devnet with FORGE_BUYBACK_DEVNET_TEST = true and the dbc-devnet route (the devnet proof,
 * scripts/devnet-tests/src/signer-buyback.ts). FORGE_BUYBACK_DEVNET_TEST on mainnet-beta is a
 * startup error, so the devnet gate can never loosen mainnet. Asking for live without a withdrawer
 * (or any other live dependency) is a startup error. Simulation never reads the keystore, never
 * signs and never sends. Kill switches: env BUYBACK_PAUSED and the `buyback_paused` flag, fail
 * closed (missing row or unreadable flags = paused), re-read before every withdrawal and every
 * signature.
 */
import { randomInt } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import { z } from 'zod';
import { PLATFORM_FEE_BPS, platformFeeLamports, type PriorityFeeQuote } from '@forge/core';
import type { FlagKey } from '@forge/shared';
import { NO_PRIORITY_FEES, signerBudgetInstructions, type PriorityFees } from './priority.js';
import type { RevenueBreakdown } from './revenue.js';
import {
  JupiterError,
  JupiterRefusal,
  WSOL_MINT,
  loadLookupTables,
  quoteSchema,
  selectJupiterApi,
  verifySwapTransaction,
  type AccountDelta,
  type AccountStateLite,
  type JupiterQuote,
  type JupiterSwap,
  type JupiterSwapApi,
  type SwapConnection,
} from './convert.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  FALLBACK_EXPIRY_BLOCKS,
  JobError,
  MEMO_PROGRAM_ID,
  alertAbnormalPause,
  assertSignerBudgetPair,
  awaitSettlement,
  base58Encode,
  broadcast,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  createFileJournal,
  describeError,
  formatSol,
  parseAddress,
  parseLamportsEnv,
  parsePositiveIntEnv,
  realSleep,
  requireRoleRef,
  requiredSigners,
  sendAlert,
  signWithKeystore,
  spendableBalance,
  startIntervalJob,
  withRetry,
  type BeforeSendHook,
  type FlagsReader,
  type IntervalJobHandle,
  type JobAlerter,
  type JobLogger,
  type Journal,
  type KeystoreLike,
  type Mutex,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Constants

export const BUYBACK_FLAG = 'buyback_paused' as const satisfies FlagKey;
/** Hard slippage ceiling (1%, SECURITY.md 8): no configuration can go above it. */
export const MAX_BUYBACK_SLIPPAGE_BPS = 100;
/** Hard price impact ceiling (1%). */
export const MAX_BUYBACK_PRICE_IMPACT_BPS = 100;
export const MAX_ORDERS_PER_DAY = 48;
export const DAY_MS = 24 * 60 * 60_000;
export const RETURN_MEMO = 'forge:buyback-return';
/**
 * Compute unit limit of the return transfer with a priority fee: an idempotent creation of the
 * vault's $FORGE account (core's devnet swap measurements put a coin account creation at about
 * 15,000 CU), a TransferChecked and a memo without signer, with a wide margin.
 */
export const FORGE_RETURN_COMPUTE_UNITS = 100_000;
export const INFLIGHT_KEY = 'inflight';
/** Upper bound of the weights used to split the budget (amounts stay in bigint). */
const WEIGHT_RANGE = 1_000_000;

// ---------------------------------------------------------------------------------------
// Mode

export type BuybackMode = 'simulation' | 'live';

/** `jupiter` on mainnet-beta; `dbc-devnet` (core `buildBuyTx` on a DBC pool) on devnet only. */
export type BuybackRouteKind = 'jupiter' | 'dbc-devnet';
export const BUYBACK_ROUTES: readonly BuybackRouteKind[] = ['jupiter', 'dbc-devnet'];

export interface BuybackModeInput {
  cluster: string | undefined;
  /** FORGE_BUYBACK_LIVE parsed (exactly "true"). */
  live: boolean;
  forgeMint: PublicKey | null;
  hasWithdrawer: boolean;
  /** BUYBACK_ROUTE (default jupiter). */
  route?: BuybackRouteKind;
  /** FORGE_BUYBACK_DEVNET_TEST parsed (exactly "true"): the devnet live gate. */
  devnetTest?: boolean;
}

export interface BuybackModeDecision {
  mode: BuybackMode;
  reason: string;
  /** The environment asks for live (cluster, flag and mint): refused when mode stays simulation. */
  liveRequested: boolean;
}

/**
 * Live on mainnet-beta with FORGE_BUYBACK_LIVE=true, a $FORGE mint, a withdrawer and the Jupiter
 * route; or on devnet with FORGE_BUYBACK_DEVNET_TEST=true on top of the same, with the dbc-devnet
 * route. The devnet route or the devnet-test flag on mainnet-beta throws (CONFIG): neither can
 * ever apply there. Anything else is simulation.
 */
export function resolveBuybackMode(input: BuybackModeInput): BuybackModeDecision {
  const route = input.route ?? 'jupiter';
  const devnetTest = input.devnetTest ?? false;
  if (input.cluster === 'mainnet-beta') {
    if (route !== 'jupiter') {
      throw new JobError('CONFIG', `BUYBACK_ROUTE=${route} is refused on mainnet-beta`);
    }
    if (devnetTest) {
      throw new JobError('CONFIG', 'FORGE_BUYBACK_DEVNET_TEST cannot be set on mainnet-beta');
    }
  } else if (input.cluster !== 'devnet' || !devnetTest) {
    return {
      mode: 'simulation',
      reason:
        input.cluster === 'devnet'
          ? 'cluster is devnet without FORGE_BUYBACK_DEVNET_TEST=true'
          : `cluster is ${input.cluster ?? 'unset'}, not mainnet-beta`,
      liveRequested: false,
    };
  }
  if (!input.live) {
    return { mode: 'simulation', reason: 'FORGE_BUYBACK_LIVE is not "true"', liveRequested: false };
  }
  if (!input.forgeMint) {
    return { mode: 'simulation', reason: 'FORGE_MINT is not set', liveRequested: false };
  }
  if (input.cluster === 'devnet' && route !== 'dbc-devnet') {
    return {
      mode: 'simulation',
      reason: 'a devnet live test needs BUYBACK_ROUTE=dbc-devnet (Jupiter does not index devnet)',
      liveRequested: true,
    };
  }
  if (!input.hasWithdrawer) {
    return {
      mode: 'simulation',
      reason: 'no Squads spending limit withdrawer is wired',
      liveRequested: true,
    };
  }
  return {
    mode: 'live',
    reason:
      input.cluster === 'mainnet-beta'
        ? 'mainnet-beta, FORGE_BUYBACK_LIVE=true, FORGE_MINT set, Jupiter route'
        : 'devnet test: FORGE_BUYBACK_DEVNET_TEST=true, FORGE_BUYBACK_LIVE=true, dbc-devnet route',
    liveRequested: true,
  };
}

// ---------------------------------------------------------------------------------------
// Configuration

export interface BuybackConfig {
  /** The runtime's resolved cluster (SOLANA_CLUSTER, devnet by default). */
  cluster: string | undefined;
  /** FORGE_BUYBACK_LIVE === "true". */
  live: boolean;
  /** FORGE_MINT, null before the $FORGE launch (simulation only). */
  forgeMint: PublicKey | null;
  /** FORGE_MULTISIG_VAULT: the bought tokens end up in its associated token account. */
  vault: PublicKey;
  /**
   * Most lamports spent on buybacks per UTC day; what the revenue backlog holds above it waits
   * for the following days. 0 disables buying (plans stay empty). At most ordersPerDay x
   * maxOrderLamports (refused otherwise: the day could not place its whole budget).
   */
  dailyCapLamports: bigint;
  /**
   * BUYBACK_REVENUE_SINCE: the ISO 8601 instant (with its time zone) from which the trading
   * revenue is bought back; nothing before it ever is. Null when unset: required for a live
   * buyback on mainnet-beta (startup error), elsewhere the budget source reports it unconfigured
   * (alert, budget 0). Not read by the job itself: the budget source is built from it.
   */
  revenueSince: string | null;
  /** Orders per day when the budget allows it (1..48). */
  ordersPerDay: number;
  minOrderLamports: bigint;
  maxOrderLamports: bigint;
  /** Slippage asked from Jupiter, in bps (<= 100). */
  slippageBps: number;
  /** A quote with a higher price impact (bps) is refused (<= 100). */
  maxPriceImpactBps: number;
  /** SOL always kept on the bot wallet for fees and rent. */
  feeReserveLamports: bigint;
  /** A slot later than this is skipped as `missed` (never caught up in a burst). */
  maxLatenessMs: number;
  /** No order in the first and last `dayMarginMs` of the day. */
  dayMarginMs: number;
  /**
   * Highest priority fee a swap transaction may carry (lamports): with JUPITER_SWAP_API=v2 (and
   * on the dbc-devnet route) the cap per transaction of the signer priority fee setting the buy
   * is priced with; with v1 Jupiter's `maxLamports`.
   */
  maxPriorityFeeLamports: bigint;
  /**
   * Lamports withdrawn on top of each planned order to cover its fees (network and priority fees
   * of the buy and of the return, each at its cap; on the devnet route the 30 bps platform fee
   * core adds), so the reserve is never eaten by the day's orders.
   */
  orderFeeAllowanceLamports: bigint;
  /** BUYBACK_ROUTE: jupiter (mainnet) or dbc-devnet (devnet only). */
  route: BuybackRouteKind;
  /** FORGE_BUYBACK_DEVNET_TEST === "true": allows live mode on devnet (never on mainnet-beta). */
  devnetTest: boolean;
  /** BUYBACK_DEVNET_DBC_POOL: the DBC pool of the devnet stand-in coin (dbc-devnet route). */
  devnetPool: PublicKey | null;
  /** Local kill switch (BUYBACK_PAUSED). */
  paused?: boolean;
  settle?: Partial<SettleTiming>;
}

/**
 * BUYBACK_REVENUE_SINCE must name an instant: an ISO 8601 date-time with an explicit time zone
 * (`2026-11-01T00:00:00Z`). A date without a zone would be read in the machine's zone.
 */
const REVENUE_SINCE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isRevenueSince(value: string): boolean {
  return REVENUE_SINCE_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** Throws CONFIG when the configuration is not safe to run. */
export function validateBuybackConfig(config: BuybackConfig): void {
  const fail = (rule: string): never => {
    throw new JobError('CONFIG', rule);
  };
  if (!Number.isInteger(config.slippageBps) || config.slippageBps < 1) {
    fail('BUYBACK_SLIPPAGE_BPS must be a positive integer');
  }
  if (config.slippageBps > MAX_BUYBACK_SLIPPAGE_BPS) fail('BUYBACK_SLIPPAGE_BPS is above 100 bps');
  if (
    !Number.isInteger(config.maxPriceImpactBps) ||
    config.maxPriceImpactBps < 1 ||
    config.maxPriceImpactBps > MAX_BUYBACK_PRICE_IMPACT_BPS
  ) {
    fail('BUYBACK_MAX_PRICE_IMPACT_BPS must be between 1 and 100');
  }
  if (
    !Number.isInteger(config.ordersPerDay) ||
    config.ordersPerDay < 1 ||
    config.ordersPerDay > MAX_ORDERS_PER_DAY
  ) {
    fail('BUYBACK_ORDERS_PER_DAY must be between 1 and 48');
  }
  if (config.minOrderLamports <= 0n) fail('BUYBACK_MIN_ORDER_LAMPORTS must be positive');
  if (config.maxOrderLamports < config.minOrderLamports) {
    fail('BUYBACK_MAX_ORDER_LAMPORTS must be at least BUYBACK_MIN_ORDER_LAMPORTS');
  }
  if (config.dailyCapLamports < 0n || config.feeReserveLamports < 0n) fail('negative amount');
  // The day's plan holds at most ordersPerDay orders of maxOrderLamports: a cap above that could
  // never be placed in one day, and a budget must never be dropped silently (D35).
  if (config.dailyCapLamports > BigInt(config.ordersPerDay) * config.maxOrderLamports) {
    fail(
      `BUYBACK_DAILY_CAP_LAMPORTS (${config.dailyCapLamports}) exceeds BUYBACK_ORDERS_PER_DAY x BUYBACK_MAX_ORDER_LAMPORTS (${config.ordersPerDay} x ${config.maxOrderLamports}): raise the orders or the maximum order so a whole day's budget fits`,
    );
  }
  if (config.revenueSince !== null && !isRevenueSince(config.revenueSince)) {
    fail('BUYBACK_REVENUE_SINCE must be an ISO 8601 instant with its time zone');
  }
  if (!Number.isInteger(config.maxLatenessMs) || config.maxLatenessMs < 60_000) {
    fail('BUYBACK_MAX_LATENESS_MINUTES must be at least 1');
  }
  if (
    !Number.isInteger(config.dayMarginMs) ||
    config.dayMarginMs < 0 ||
    config.dayMarginMs * 2 >= DAY_MS - config.ordersPerDay * 60_000
  ) {
    fail('day margin leaves no room for the orders');
  }
  if (config.maxPriorityFeeLamports < 0n) fail('negative priority fee');
  if (config.orderFeeAllowanceLamports < 0n) fail('negative order fee allowance');
  if (config.forgeMint) {
    if (config.forgeMint.equals(NATIVE_MINT)) fail('FORGE_MINT must not be wrapped SOL');
    if (config.forgeMint.equals(config.vault)) fail('FORGE_MINT must differ from the vault');
  }
  if (!BUYBACK_ROUTES.includes(config.route)) fail('BUYBACK_ROUTE must be jupiter or dbc-devnet');
  if (config.cluster === 'mainnet-beta') {
    if (config.route !== 'jupiter') fail('BUYBACK_ROUTE=dbc-devnet is refused on mainnet-beta');
    if (config.devnetTest) fail('FORGE_BUYBACK_DEVNET_TEST cannot be set on mainnet-beta');
    if (config.devnetPool) fail('BUYBACK_DEVNET_DBC_POOL cannot be set on mainnet-beta');
  }
  if (config.route === 'dbc-devnet') {
    const pool = config.devnetPool;
    if (!pool) throw new JobError('CONFIG', 'BUYBACK_ROUTE=dbc-devnet needs BUYBACK_DEVNET_DBC_POOL');
    if (pool.equals(config.vault) || pool.equals(NATIVE_MINT)) {
      fail('BUYBACK_DEVNET_DBC_POOL is not a pool');
    }
    if (config.forgeMint && pool.equals(config.forgeMint)) {
      fail('BUYBACK_DEVNET_DBC_POOL must differ from FORGE_MINT');
    }
  }
}

export interface BuybackJupiterSettings {
  /** JUPITER_SWAP_API: v2 (default, `/build` + local assembly) or v1 (Metis `/quote` + `/swap`). */
  swapApi: JupiterSwapApi;
  baseUrl: string;
  apiKey?: string | undefined;
  minRequestIntervalMs: number;
  timeoutMs: number;
}

const LIVE_RE = /^(true|false)?$/;

/**
 * Reads the buyback settings. Addresses (vault, mint) come from @forge/core `requireAddresses`.
 * FORGE_BUYBACK_LIVE (exactly "true" or "false", default false), BUYBACK_DAILY_CAP_LAMPORTS
 * (default 0: nothing is bought; 5 SOL on mainnet, D35; at most orders x max order),
 * BUYBACK_REVENUE_SINCE (ISO 8601 instant with its zone; required by FORGE_BUYBACK_LIVE=true on
 * mainnet-beta), BUYBACK_ORDERS_PER_DAY (8), BUYBACK_MIN_ORDER_LAMPORTS
 * (0.01 SOL), BUYBACK_MAX_ORDER_LAMPORTS (0.25 SOL), BUYBACK_SLIPPAGE_BPS (50, max 100),
 * BUYBACK_MAX_PRICE_IMPACT_BPS (100, max 100), BUYBACK_FEE_RESERVE_LAMPORTS (0.02 SOL),
 * BUYBACK_MAX_LATENESS_MINUTES (30), BUYBACK_DAY_MARGIN_MINUTES (10),
 * BUYBACK_MAX_PRIORITY_FEE_LAMPORTS (100 000), BUYBACK_ORDER_FEE_ALLOWANCE_LAMPORTS (that cap +
 * the return's priority fee cap under `options.priorityFees` + 10 000; the dbc-devnet route adds
 * the 30 bps platform fee of the largest order),
 * BUYBACK_TICK_SECONDS (60), BUYBACK_PAUSED (false), BUYBACK_ROUTE (jupiter | dbc-devnet),
 * FORGE_BUYBACK_DEVNET_TEST (exactly "true" or "false", default false, refused on mainnet-beta),
 * BUYBACK_DEVNET_DBC_POOL (required by the dbc-devnet route), JUPITER_SWAP_API (v2 | v1, default
 * v2) / JUPITER_API_URL / JUPITER_API_KEY (shared with the conversion job, convert.ts
 * `selectJupiterApi`; the key is required by FORGE_BUYBACK_LIVE=true on mainnet-beta, whatever
 * the API), BUYBACK_REQUEST_INTERVAL_MS (1100), BUYBACK_REQUEST_TIMEOUT_MS (15 000).
 *
 * The mode decision (live, devnet test or simulation) uses `options.cluster`, the cluster the
 * runtime resolved (devnet unless SOLANA_CLUSTER is mainnet-beta), not the raw variable; without
 * it (direct callers) SOLANA_CLUSTER is read with the same default.
 */
export function buybackConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  addresses: { vault: PublicKey; forgeMint: PublicKey | null },
  options: {
    cluster?: string;
    /** The signer's priority fees (SIGNER_PRIORITY_FEE_*): the return's cap is in the allowance. */
    priorityFees?: Pick<PriorityFees, 'maxFeeLamports'>;
  } = {},
): { config: BuybackConfig; tickMs: number; jupiter: BuybackJupiterSettings } {
  const liveRaw = env.FORGE_BUYBACK_LIVE ?? '';
  if (!LIVE_RE.test(liveRaw))
    throw new JobError('CONFIG', 'FORGE_BUYBACK_LIVE must be true or false');
  const devnetTestRaw = env.FORGE_BUYBACK_DEVNET_TEST ?? '';
  if (!LIVE_RE.test(devnetTestRaw)) {
    throw new JobError('CONFIG', 'FORGE_BUYBACK_DEVNET_TEST must be true or false');
  }
  const routeRaw = env.BUYBACK_ROUTE ?? '';
  if (routeRaw !== '' && !(BUYBACK_ROUTES as readonly string[]).includes(routeRaw)) {
    throw new JobError('CONFIG', 'BUYBACK_ROUTE must be jupiter or dbc-devnet');
  }
  const route: BuybackRouteKind = routeRaw === '' ? 'jupiter' : (routeRaw as BuybackRouteKind);
  const poolRaw = env.BUYBACK_DEVNET_DBC_POOL ?? '';
  let devnetPool: PublicKey | null = null;
  if (poolRaw !== '') {
    devnetPool = parseAddress(poolRaw);
    if (!devnetPool) throw new JobError('CONFIG', 'BUYBACK_DEVNET_DBC_POOL is not an address');
  }
  const pausedRaw = env.BUYBACK_PAUSED ?? '';
  if (!/^(true|false|1|0)?$/.test(pausedRaw)) {
    throw new JobError('CONFIG', 'BUYBACK_PAUSED must be true or false');
  }
  const sinceRaw = env.BUYBACK_REVENUE_SINCE?.trim() ?? '';
  if (sinceRaw !== '' && !isRevenueSince(sinceRaw)) {
    throw new JobError(
      'CONFIG',
      'BUYBACK_REVENUE_SINCE must be an ISO 8601 instant with its time zone (e.g. 2026-11-01T00:00:00Z)',
    );
  }
  const intEnv = (name: string, fallback: number, max: number): number => {
    const v = parsePositiveIntEnv(env[name], name, fallback);
    if (v > max) throw new JobError('CONFIG', `${name} is too large`);
    return v;
  };
  const jupiterApi = selectJupiterApi(env);
  if (!jupiterApi.ok) throw new JobError('CONFIG', jupiterApi.error);
  const config: BuybackConfig = {
    cluster: options.cluster ?? (env.SOLANA_CLUSTER || 'devnet'),
    live: liveRaw === 'true',
    forgeMint: addresses.forgeMint,
    vault: addresses.vault,
    dailyCapLamports: parseLamportsEnv(
      env.BUYBACK_DAILY_CAP_LAMPORTS,
      'BUYBACK_DAILY_CAP_LAMPORTS',
      0n,
    ),
    revenueSince: sinceRaw === '' ? null : sinceRaw,
    ordersPerDay: intEnv('BUYBACK_ORDERS_PER_DAY', 8, MAX_ORDERS_PER_DAY),
    minOrderLamports: parseLamportsEnv(
      env.BUYBACK_MIN_ORDER_LAMPORTS,
      'BUYBACK_MIN_ORDER_LAMPORTS',
      10_000_000n,
    ),
    maxOrderLamports: parseLamportsEnv(
      env.BUYBACK_MAX_ORDER_LAMPORTS,
      'BUYBACK_MAX_ORDER_LAMPORTS',
      250_000_000n,
    ),
    slippageBps: intEnv('BUYBACK_SLIPPAGE_BPS', 50, MAX_BUYBACK_SLIPPAGE_BPS),
    maxPriceImpactBps: intEnv('BUYBACK_MAX_PRICE_IMPACT_BPS', 100, MAX_BUYBACK_PRICE_IMPACT_BPS),
    feeReserveLamports: parseLamportsEnv(
      env.BUYBACK_FEE_RESERVE_LAMPORTS,
      'BUYBACK_FEE_RESERVE_LAMPORTS',
      20_000_000n,
    ),
    maxLatenessMs: intEnv('BUYBACK_MAX_LATENESS_MINUTES', 30, 24 * 60) * 60_000,
    dayMarginMs: (() => {
      const raw = env.BUYBACK_DAY_MARGIN_MINUTES;
      if (raw === '0') return 0;
      return intEnv('BUYBACK_DAY_MARGIN_MINUTES', 10, 6 * 60) * 60_000;
    })(),
    maxPriorityFeeLamports: parseLamportsEnv(
      env.BUYBACK_MAX_PRIORITY_FEE_LAMPORTS,
      'BUYBACK_MAX_PRIORITY_FEE_LAMPORTS',
      100_000n,
    ),
    orderFeeAllowanceLamports: 0n,
    route,
    devnetTest: devnetTestRaw === 'true',
    devnetPool,
    paused: pausedRaw === 'true' || pausedRaw === '1',
  };
  // Per order: the buy's priority fee cap, the return's (priced by the signer's setting) and the
  // network fees of both.
  const returnPriorityFee = (options.priorityFees ?? NO_PRIORITY_FEES).maxFeeLamports(
    FORGE_RETURN_COMPUTE_UNITS,
  );
  config.orderFeeAllowanceLamports = parseLamportsEnv(
    env.BUYBACK_ORDER_FEE_ALLOWANCE_LAMPORTS,
    'BUYBACK_ORDER_FEE_ALLOWANCE_LAMPORTS',
    config.maxPriorityFeeLamports + returnPriorityFee + 10_000n,
  );
  if (route === 'dbc-devnet') {
    // Core adds the 30 bps platform fee on top of every buy (docs/METEORA.md).
    config.orderFeeAllowanceLamports += platformFeeLamports(
      config.maxOrderLamports,
      PLATFORM_FEE_BPS,
    );
  }
  validateBuybackConfig(config);
  // A live buyback on mainnet-beta buys through the Jupiter API, which needs a key
  // (docs/METEORA.md "Jupiter"): refused at startup rather than failing every order.
  const apiKey = env.JUPITER_API_KEY?.trim() ? env.JUPITER_API_KEY : undefined;
  if (config.cluster === 'mainnet-beta' && config.live && !apiKey) {
    throw new JobError(
      'CONFIG',
      'JUPITER_API_KEY is required when FORGE_BUYBACK_LIVE=true on mainnet-beta',
    );
  }
  // A live buyback on mainnet-beta must know from when the revenue is bought back (D35): with
  // no instant, the history before the go-live would be. Elsewhere the budget source alerts.
  if (config.cluster === 'mainnet-beta' && config.live && config.revenueSince === null) {
    throw new JobError(
      'CONFIG',
      'BUYBACK_REVENUE_SINCE is required when FORGE_BUYBACK_LIVE=true on mainnet-beta: set it to the go-live instant so no earlier revenue is bought back',
    );
  }
  const tickSeconds = intEnv('BUYBACK_TICK_SECONDS', 60, 3_600);
  if (tickSeconds < 5) throw new JobError('CONFIG', 'BUYBACK_TICK_SECONDS must be at least 5');
  return {
    config,
    tickMs: tickSeconds * 1_000,
    jupiter: {
      swapApi: jupiterApi.api,
      baseUrl: jupiterApi.baseUrl,
      apiKey,
      minRequestIntervalMs: intEnv('BUYBACK_REQUEST_INTERVAL_MS', 1_100, 60_000),
      timeoutMs: intEnv('BUYBACK_REQUEST_TIMEOUT_MS', 15_000, 120_000),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Schedule (pure)

/** Random number in [0, 1). Injectable for tests; the default uses the CSPRNG. */
export type Rng = () => number;

export const cryptoRng: Rng = () => randomInt(0, 2 ** 48) / 2 ** 48;

function draw(rng: Rng): number {
  const v = rng();
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) {
    throw new JobError('CONFIG', 'random source returned a value outside [0, 1)');
  }
  return v;
}

export interface PlanInput {
  /** 00:00 UTC of the day, in ms. */
  dayStartMs: number;
  budgetLamports: bigint;
  orders: number;
  minOrderLamports: bigint;
  maxOrderLamports: bigint;
  marginMs: number;
  rng: Rng;
}

export interface PlannedSlot {
  index: number;
  /** Execution time (ms since epoch). */
  at: number;
  lamports: bigint;
}

/**
 * Pure: the day's orders. Invariants: at most `orders` slots and never more than
 * budget / minOrder; every amount in [minOrder, maxOrder]; total <= budget, and total = budget
 * whenever the slots can hold it (budget <= slots x maxOrder: nothing is dropped silently, the
 * rest stays in the revenue backlog); slot i lies in the i-th equal segment of
 * [dayStart + margin, dayEnd - margin) (spread over the day, sorted).
 */
export function planDay(input: PlanInput): PlannedSlot[] {
  const { budgetLamports: budget, minOrderLamports: min, maxOrderLamports: max } = input;
  if (min <= 0n || max < min) throw new JobError('CONFIG', 'invalid order bounds');
  if (budget < 0n) throw new JobError('INVALID_AMOUNT', 'negative budget');
  if (!Number.isInteger(input.orders) || input.orders < 1 || input.orders > MAX_ORDERS_PER_DAY) {
    throw new JobError('CONFIG', 'invalid number of orders');
  }
  const byBudget = budget / min;
  const n = Number(byBudget < BigInt(input.orders) ? byBudget : BigInt(input.orders));
  if (n === 0) return [];
  const usable = DAY_MS - 2 * input.marginMs;
  const segment = Math.floor(usable / n);
  if (segment < 1) throw new JobError('CONFIG', 'day margin leaves no room for the orders');

  const slots: PlannedSlot[] = [];
  for (let i = 0; i < n; i++) {
    const at =
      input.dayStartMs + input.marginMs + i * segment + Math.floor(draw(input.rng) * segment);
    slots.push({ index: i, at, lamports: min });
  }
  // Every slot gets the minimum, then the rest of the budget is spread by random weights. A slot
  // the weights push above the maximum stops there and its surplus is spread again, by weight,
  // over the slots still below it, until nothing is left or every slot is at the maximum (each
  // round closes at least one slot, so this ends). What `n` maximum orders cannot hold is left
  // out, measured by the caller and kept in the revenue backlog.
  let remaining = budget - min * BigInt(n);
  const weights = slots.map(() => BigInt(1 + Math.floor(draw(input.rng) * WEIGHT_RANGE)));
  let open = slots.map((_, i) => i);
  while (remaining > 0n && open.length > 0) {
    const totalWeight = open.reduce((a, i) => a + weights[i]!, 0n);
    const pool = remaining;
    let capped = false;
    for (const i of open) {
      const slot = slots[i]!;
      const room = max - slot.lamports;
      const share = (pool * weights[i]!) / totalWeight;
      if (share >= room) {
        capped = true;
        slot.lamports = max;
        remaining -= room;
      } else {
        slot.lamports += share;
        remaining -= share;
      }
    }
    open = open.filter((i) => slots[i]!.lamports < max);
    if (!capped) {
      // Only the integer-division dust is left (fewer lamports than open slots): one each.
      for (const i of open) {
        if (remaining === 0n) break;
        slots[i]!.lamports += 1n;
        remaining -= 1n;
      }
    }
  }
  return slots;
}

/** Lamports of a budget the plan could not place (budget above slots x maxOrder). */
export function unplannedLamports(budget: bigint, slots: readonly PlannedSlot[]): bigint {
  return budget - slots.reduce((a, s) => a + s.lamports, 0n);
}

/** UTC day of a timestamp: `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function dayStartMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

export function dayJournalKey(day: string): string {
  return `day-${day}`;
}

// ---------------------------------------------------------------------------------------
// Journal

const lamportsString = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

export const SlotStatus = z.enum([
  'planned',
  'missed',
  'simulated',
  'skipped',
  'submitted',
  'swapped',
  'failed',
  'unknown',
]);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const BuybackSlot = z.object({
  index: z.number().int().nonnegative(),
  at: z.number().int(),
  lamports: lamportsString,
  status: SlotStatus,
  signature: z.string().optional(),
  /** Quoted output (simulation) or guaranteed minimum (live), raw $FORGE units. */
  outAmount: lamportsString.optional(),
  note: z.string().max(200).optional(),
  updatedAt: z.string().optional(),
});
export type BuybackSlot = z.infer<typeof BuybackSlot>;

export const FundingRecord = z.object({
  status: z.enum(['requested', 'confirmed', 'failed', 'unknown', 'not_needed']),
  lamports: lamportsString,
  signature: z.string().optional(),
  note: z.string().max(200).optional(),
  at: z.string(),
});
export type FundingRecord = z.infer<typeof FundingRecord>;

const countField = z.number().int().nonnegative();

/**
 * The revenue figures the day's budget was derived from (D35), as the budget source reported
 * them when the plan was made: what reached the vault since `since`, what the buyback already
 * took, the backlog. Absent in journals written before the revenue budget existed.
 */
export const BuybackRevenueRecord = z.object({
  since: z.string(),
  /** Finalized revenue forwards (jobs/revenue.ts) since `since`, with their breakdown by source. */
  forwards: z.object({
    count: countField,
    lamports: lamportsString,
    meteora_referral: lamportsString,
    jupiter_referral: lamportsString,
    platform_fee: lamportsString,
    other: lamportsString,
  }),
  /** Finalized creator claims to the vault (jobs/claims.ts receipts) since `since`. */
  claims: z.object({
    count: countField,
    lamports: lamportsString,
    dbc: lamportsString,
    position: lamportsString,
    /** Receipts seen confirmed but not finalized yet: not counted until they are. */
    awaitingFinality: countField,
  }),
  revenueLamports: lamportsString,
  /** Taken out of the vault by the buyback since `since`: its spending-limit withdrawals. */
  spent: z.object({ withdrawals: countField, lamports: lamportsString }),
  /** revenue - spent, never negative: what the vault still owes the buyback. */
  backlogLamports: lamportsString,
});
export type BuybackRevenueRecord = z.infer<typeof BuybackRevenueRecord>;

export const BuybackDayEntry = z.object({
  kind: z.literal('day'),
  v: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['simulation', 'live']),
  createdAt: z.string(),
  budgetLamports: lamportsString,
  capLamports: lamportsString,
  /** Lamports of the budget the plan could not place (never with a valid configuration). */
  unplannedLamports: lamportsString.optional(),
  /** SOL above the bot's reserve when the day was planned (live), counted as buyable. */
  botAvailableLamports: lamportsString.optional(),
  revenue: BuybackRevenueRecord.optional(),
  slots: z.array(BuybackSlot).max(MAX_ORDERS_PER_DAY),
  funding: FundingRecord.nullable(),
});
export type BuybackDayEntry = z.infer<typeof BuybackDayEntry>;

export const InFlightTx = z.object({
  purpose: z.enum(['swap', 'return']),
  day: z.string().optional(),
  slotIndex: z.number().int().nonnegative().optional(),
  signature: z.string(),
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  /** Lamports (swap) or raw $FORGE units (return). */
  amount: lamportsString,
  startedAt: z.string(),
});
export type InFlightTx = z.infer<typeof InFlightTx>;

export const BuybackInFlightEntry = z.object({
  kind: z.literal('inflight'),
  v: z.literal(1),
  tx: InFlightTx.nullable(),
});

export const BuybackJournalEntry = z.discriminatedUnion('kind', [
  BuybackDayEntry,
  BuybackInFlightEntry,
]);
export type BuybackJournalEntry = z.infer<typeof BuybackJournalEntry>;

/** Durable journal of the job: `<dir>/buyback.day-YYYY-MM-DD.json` and `buyback.inflight.json`. */
export function createBuybackJournal(dir: string): Journal<BuybackJournalEntry> {
  return createFileJournal({ dir, namespace: 'buyback', schema: BuybackJournalEntry });
}

/** Statuses whose amount counts against the daily cap (spent, or may have been). */
const COMMITTED: ReadonlySet<SlotStatus> = new Set([
  'simulated',
  'submitted',
  'swapped',
  'unknown',
]);

export function committedLamports(slots: readonly BuybackSlot[]): bigint {
  let total = 0n;
  for (const s of slots) {
    if (COMMITTED.has(s.status) || (s.status === 'failed' && s.signature)) {
      total += BigInt(s.lamports);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------------------
// Collaborators

/** The revenue figures behind a budget, in lamports (jobs/buyback-budget.ts computes them). */
export interface BuybackRevenueFigures {
  since: string;
  forwards: { count: number; lamports: bigint; breakdown: RevenueBreakdown };
  claims: {
    count: number;
    lamports: bigint;
    dbc: bigint;
    position: bigint;
    awaitingFinality: number;
  };
  revenueLamports: bigint;
  spent: { withdrawals: number; lamports: bigint };
  backlogLamports: bigint;
}

export type BuybackBudgetResult =
  | { status: 'ok'; figures: BuybackRevenueFigures }
  /** BUYBACK_REVENUE_SINCE is not set: nothing can be bought (alerted, no plan). */
  | { status: 'unconfigured'; reason: string }
  /** A journal is unreadable or holds a corrupt entry: budget 0 for the run (alerted, no plan). */
  | { status: 'unavailable'; reason: string };

/**
 * The revenue backlog (D35): what reached the vault as trading revenue since
 * BUYBACK_REVENUE_SINCE minus what the buyback already took out of it, never negative. The env
 * cap, the spending limit and the bot's balance apply on top (`computeBudget`).
 */
export interface BuybackBudgetSource {
  backlog(): Promise<BuybackBudgetResult>;
}

export function revenueFiguresToRecord(f: BuybackRevenueFigures): BuybackRevenueRecord {
  return {
    since: f.since,
    forwards: {
      count: f.forwards.count,
      lamports: f.forwards.lamports.toString(),
      meteora_referral: f.forwards.breakdown.meteora_referral.toString(),
      jupiter_referral: f.forwards.breakdown.jupiter_referral.toString(),
      platform_fee: f.forwards.breakdown.platform_fee.toString(),
      other: f.forwards.breakdown.other.toString(),
    },
    claims: {
      count: f.claims.count,
      lamports: f.claims.lamports.toString(),
      dbc: f.claims.dbc.toString(),
      position: f.claims.position.toString(),
      awaitingFinality: f.claims.awaitingFinality,
    },
    revenueLamports: f.revenueLamports.toString(),
    spent: { withdrawals: f.spent.withdrawals, lamports: f.spent.lamports.toString() },
    backlogLamports: f.backlogLamports.toString(),
  };
}

export type WithdrawResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; error: string; signature?: string }
  /** Refused before anything was signed or sent. */
  | { status: 'refused'; reason: string }
  /** Sent, outcome unknown at the deadline. */
  | { status: 'unknown'; signature: string };

/**
 * Squads v4 spending limit use (vault -> bot wallet). NOT implemented yet: live mode is refused
 * until one is wired. Contract for the implementation:
 * - only the spending limit configured for the bot (SOL, destination = the bot wallet) is used;
 *   the bot key is the spending-limit member and the only signer;
 * - `remainingLamports` reads the on-chain spending limit (remaining amount of the period);
 * - `withdraw` moves exactly `lamports`, policy-checks and simulates the transaction before
 *   signing, calls `onBeforeSend(signature)` before the first broadcast (outflow watcher), and
 *   settles by polling `getSignatureStatuses`. It is idempotent per `idempotencyKey`. The job
 *   journals the request first and never calls it twice for the same day;
 * - `maxFeeLamports` (optional, 0 when absent) is the most the withdrawal transaction costs its
 *   fee payer, the bot (network fee and priority fee at its cap): the job withdraws it on top of
 *   the orders so the reserve does not pay it.
 */
export interface SpendingLimitWithdrawer {
  remainingLamports(destination: PublicKey): Promise<bigint>;
  maxFeeLamports?(): bigint;
  withdraw(input: {
    lamports: bigint;
    destination: PublicKey;
    idempotencyKey: string;
    onBeforeSend: BeforeSendHook;
  }): Promise<WithdrawResult>;
}

/** Quote + swap for SOL -> $FORGE (Jupiter Swap API, or the devnet DBC pool). */
export interface BuybackQuoteSource {
  /**
   * `taker`: the wallet the swap is built for (Swap API V2 builds its instructions at quote
   * time): the bot when live, the vault in simulation. The Metis and DBC sources ignore it.
   */
  quote(input: {
    outputMint: string;
    lamports: bigint;
    slippageBps: number;
    taker: string;
  }): Promise<JupiterQuote>;
  swap(input: { quote: JupiterQuote; userPublicKey: string }): Promise<JupiterSwap>;
}

/** What the buy may do, from the VALIDATED quote (never from the swap answer). */
export interface BuyExpectation {
  forgeMint: string;
  /** Lamports sold: the bot's SOL may drop by at most this plus the fee bound. */
  inLamports: bigint;
  /** Raw $FORGE the quote guarantees (`otherAmountThreshold`). */
  minOutAmount: bigint;
  /** Raw $FORGE the quote announced (`outAmount`): the route's `quoted_out_amount` may not be lower. */
  quotedOutAmount: bigint;
  /** Highest `slippage_bps` the route instruction may carry (BUYBACK_SLIPPAGE_BPS, <= 100). */
  maxSlippageBps: number;
}

export type PreparedSwap =
  | { status: 'ready'; signature: string; raw: Uint8Array; lastValidBlockHeight: number }
  | { status: 'refused'; reason: string };

/** Verifies (allowlist + simulation) and signs a Jupiter buy transaction. Never sends. */
export interface BuybackSwapPreparer {
  prepare(input: {
    owner: PublicKey;
    ownerRef: string;
    swapTransaction: string;
    lastValidBlockHeight?: number;
    expected: BuyExpectation;
  }): Promise<PreparedSwap>;
}

/** On-chain reads of the return step. */
export interface ForgeTokenReader {
  mintInfo(mint: PublicKey): Promise<{ programId: PublicKey; decimals: number }>;
  /** Raw amount of a token account (0n when it does not exist); checks its mint and owner. */
  tokenBalance(
    account: PublicKey,
    expected: { mint: PublicKey; owner: PublicKey },
  ): Promise<bigint>;
}

// ---------------------------------------------------------------------------------------
// Jupiter client (SOL -> $FORGE)

export interface BuybackJupiterOptions extends Omit<BuybackJupiterSettings, 'swapApi'> {
  fetch?: typeof fetch;
  maxPriorityFeeLamports: bigint;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const swapResponseSchema = z.object({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: z.number().int().optional(),
});

/**
 * Metis Swap API client (JUPITER_SWAP_API=v1, the rollback path for one release; the default is
 * jobs/jupiter-v2.ts `createJupiterV2BuybackClient`). Same transport rules as the conversion
 * job's client (https only, key in a header, rate limit, errors without URL or headers), for the
 * opposite direction: input wrapped SOL.
 */
export function createJupiterBuybackClient(opts: BuybackJupiterOptions): BuybackQuoteSource {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new JupiterError('Jupiter API URL is invalid');
  }
  if (base.protocol !== 'https:') throw new JupiterError('Jupiter API URL must use https');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  let lastCall = Number.NEGATIVE_INFINITY;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const wait = lastCall + opts.minRequestIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      throw new JupiterError(
        `Jupiter request failed (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    if (!res.ok) throw new JupiterError(`Jupiter answered with status ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new JupiterError('Jupiter answered with invalid JSON', res.status);
    }
  }

  return {
    async quote({ outputMint, lamports, slippageBps }) {
      const params = new URLSearchParams({
        inputMint: WSOL_MINT,
        outputMint,
        amount: lamports.toString(),
        slippageBps: String(slippageBps),
        swapMode: 'ExactIn',
        restrictIntermediateTokens: 'true',
      });
      const parsed = quoteSchema.safeParse(
        await request(`/quote?${params.toString()}`, { method: 'GET' }),
      );
      if (!parsed.success) throw new JupiterError('Jupiter quote has an unexpected shape');
      return parsed.data;
    },
    async swap({ quote, userPublicKey }) {
      const body = await request('/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: Number(opts.maxPriorityFeeLamports),
              priorityLevel: 'medium',
            },
          },
        }),
      });
      const parsed = swapResponseSchema.safeParse(body);
      if (!parsed.success) throw new JupiterError('Jupiter swap has an unexpected shape');
      return parsed.data;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Quote validation (pure)

export type BuyQuoteRejection =
  | 'input_not_sol'
  | 'output_mint_mismatch'
  | 'amount_mismatch'
  | 'not_exact_in'
  | 'slippage_too_high'
  | 'price_impact_too_high'
  | 'invalid_price_impact'
  | 'zero_output'
  | 'threshold_inconsistent';

/** Why a buy quote must not be used, or null. Refuses, never adjusts. */
export function validateBuyQuote(
  quote: JupiterQuote,
  request: { forgeMint: string; lamports: bigint },
  limits: { maxSlippageBps: number; maxPriceImpactBps: number },
): BuyQuoteRejection | null {
  const maxSlippage = Math.min(limits.maxSlippageBps, MAX_BUYBACK_SLIPPAGE_BPS);
  const maxImpact = Math.min(limits.maxPriceImpactBps, MAX_BUYBACK_PRICE_IMPACT_BPS);
  if (quote.inputMint !== WSOL_MINT) return 'input_not_sol';
  if (quote.outputMint !== request.forgeMint) return 'output_mint_mismatch';
  if (BigInt(quote.inAmount) !== request.lamports) return 'amount_mismatch';
  if (quote.swapMode !== 'ExactIn') return 'not_exact_in';
  if (quote.slippageBps > maxSlippage) return 'slippage_too_high';
  const impact = Number(quote.priceImpactPct);
  if (!Number.isFinite(impact) || impact < 0) return 'invalid_price_impact';
  if (impact * 10_000 > maxImpact) return 'price_impact_too_high';
  const out = BigInt(quote.outAmount);
  const threshold = BigInt(quote.otherAmountThreshold);
  if (out <= 0n || threshold <= 0n) return 'zero_output';
  if (threshold > out) return 'threshold_inconsistent';
  // The guaranteed minimum must match the cap, whatever `slippageBps` claims: at least the
  // floor-rounded `out * (1 - cap)` (every quote source rounds its minimum down to the unit).
  if (threshold < (out * BigInt(10_000 - maxSlippage)) / 10_000n) return 'slippage_too_high';
  return null;
}

// ---------------------------------------------------------------------------------------
// Simulation check (pure part)

export type BuyRefusal =
  | 'simulation_failed'
  | 'simulation_incomplete'
  | 'state_changed_during_check'
  | 'owner_account_changed'
  | 'token_account_changed'
  | 'sol_overspent'
  | 'output_below_minimum';

interface TokenFields {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  state: number;
}

function decodeTokenAccount(state: AccountStateLite | null): TokenFields | null {
  if (!state || state.data.length < AccountLayout.span) return null;
  if (
    state.owner !== TOKEN_PROGRAM_ID.toBase58() &&
    state.owner !== TOKEN_2022_PROGRAM_ID.toBase58()
  ) {
    return null;
  }
  const raw = AccountLayout.decode(state.data.subarray(0, AccountLayout.span));
  return {
    mint: raw.mint.toBase58(),
    owner: raw.owner.toBase58(),
    amount: raw.amount,
    delegate: raw.delegateOption ? raw.delegate.toBase58() : null,
    delegatedAmount: raw.delegatedAmount,
    closeAuthority: raw.closeAuthorityOption ? raw.closeAuthority.toBase58() : null,
    state: raw.state,
  };
}

function sameState(a: AccountStateLite | null, b: AccountStateLite | null): boolean {
  if (!a || !b) return a === b;
  return a.owner === b.owner && a.lamports === b.lamports && a.data.equals(b.data);
}

/**
 * A simulation reports an account closed by the transaction as a zero-lamport, empty, system-owned
 * stub rather than `null` (devnet finding): that is a missing account.
 */
export function closedAsMissing(state: AccountStateLite | null): AccountStateLite | null {
  if (state && state.lamports === 0n && state.data.length === 0) return null;
  return state;
}

/** The owner's wSOL ATA and $FORGE ATAs (both token programs): the only accounts a buy may create. */
export function buyCreatableAccounts(owner: PublicKey, forgeMint: PublicKey): string[] {
  return [
    getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(forgeMint, owner, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(forgeMint, owner, true, TOKEN_2022_PROGRAM_ID),
  ].map((k) => k.toBase58());
}

/**
 * Pure: compares the bot's accounts before and after the simulated buy.
 * - the bot wallet stays a plain System account;
 * - token accounts keep their mint, owner (= the bot), delegate, close authority and state; only
 *   the bot's wSOL ATA and $FORGE ATA may be created, only the wSOL ATA may be closed;
 * - SOL: the lamports of the wallet and all its token accounts together drop by at most
 *   `inLamports + feeBoundLamports` (rent moved into a new ATA stays with the bot);
 * - $FORGE grows by at least `minOutAmount`; every other mint is unchanged (a swap paying out a
 *   different mint is refused here even if the transaction looked fine).
 */
export function compareBuybackStates(
  owner: string,
  expected: Pick<BuyExpectation, 'forgeMint' | 'inLamports' | 'minOutAmount'>,
  feeBoundLamports: bigint,
  deltas: readonly AccountDelta[],
): BuyRefusal | null {
  const system = SystemProgram.programId.toBase58();
  const ownerKey = new PublicKey(owner);
  const creatable = new Set(buyCreatableAccounts(ownerKey, new PublicKey(expected.forgeMint)));
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    ownerKey,
    true,
    TOKEN_PROGRAM_ID,
  ).toBase58();
  let lamportsPre = 0n;
  let lamportsPost = 0n;
  let forgePre = 0n;
  let forgePost = 0n;
  let sawOwner = false;
  for (const raw of deltas) {
    const d: AccountDelta = {
      address: raw.address,
      pre: closedAsMissing(raw.pre),
      post: closedAsMissing(raw.post),
    };
    if (d.address === owner) {
      sawOwner = true;
      if (!d.pre || !d.post || d.post.owner !== system || d.post.data.length !== 0) {
        return 'owner_account_changed';
      }
      lamportsPre += d.pre.lamports;
      lamportsPost += d.post.lamports;
      continue;
    }
    const pre = decodeTokenAccount(d.pre);
    const post = decodeTokenAccount(d.post);
    if ((d.pre && !pre) || (d.post && !post)) {
      if (!sameState(d.pre, d.post)) return 'token_account_changed';
      continue;
    }
    if (!pre && !post) continue;
    const mint = (pre ?? post)!.mint;
    for (const t of [pre, post]) {
      if (t && (t.owner !== owner || t.mint !== mint)) return 'token_account_changed';
    }
    if (pre && post) {
      if (
        pre.delegate !== post.delegate ||
        pre.delegatedAmount !== post.delegatedAmount ||
        pre.closeAuthority !== post.closeAuthority ||
        pre.state !== post.state
      ) {
        return 'token_account_changed';
      }
    } else if (!pre && post) {
      if (!creatable.has(d.address)) return 'token_account_changed';
      if (post.delegate !== null || post.closeAuthority !== null) return 'token_account_changed';
    } else if (d.address !== wsolAta) {
      // Closed: only the temporary wSOL account may go away.
      return 'token_account_changed';
    }
    lamportsPre += d.pre?.lamports ?? 0n;
    lamportsPost += d.post?.lamports ?? 0n;
    if (mint === WSOL_MINT) continue;
    if (mint === expected.forgeMint) {
      forgePre += pre?.amount ?? 0n;
      forgePost += post?.amount ?? 0n;
      continue;
    }
    if (!pre || !post || pre.amount !== post.amount || d.pre!.lamports !== d.post!.lamports) {
      return 'token_account_changed';
    }
  }
  if (!sawOwner) return 'simulation_incomplete';
  if (lamportsPre - lamportsPost > expected.inLamports + feeBoundLamports) return 'sol_overspent';
  if (forgePost < forgePre || forgePost - forgePre < expected.minOutAmount) {
    return 'output_below_minimum';
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Swap preparer over RPC

const ACCOUNTS_PER_REQUEST = 100;

function toLite(info: AccountInfo<Buffer> | null | undefined): AccountStateLite | null {
  if (!info) return null;
  return { owner: info.owner.toBase58(), lamports: BigInt(info.lamports), data: info.data };
}

async function readAccounts(
  connection: SwapConnection,
  keys: readonly PublicKey[],
): Promise<{ slot: number; states: (AccountStateLite | null)[] }> {
  const states: (AccountStateLite | null)[] = [];
  let slot = 0;
  for (let i = 0; i < keys.length; i += ACCOUNTS_PER_REQUEST) {
    const res = await connection.getMultipleAccountsInfoAndContext(
      keys.slice(i, i + ACCOUNTS_PER_REQUEST),
      'confirmed',
    );
    slot = Math.max(slot, res.context.slot);
    for (const info of res.value) states.push(toLite(info));
  }
  return { slot, states };
}

/**
 * Simulates the buy with the post-state of every account the bot holds (wallet, all token
 * accounts of both programs, wSOL and $FORGE ATAs) and checks them with `compareBuybackStates`.
 * The pre-state is read before AND after the simulation and must not move.
 */
export async function checkBuybackSimulation(
  connection: SwapConnection,
  tx: VersionedTransaction,
  input: {
    owner: PublicKey;
    expected: Pick<BuyExpectation, 'forgeMint' | 'inLamports' | 'minOutAmount'>;
    feeBoundLamports: bigint;
  },
): Promise<BuyRefusal | null> {
  const watched = new Map<string, PublicKey>();
  const add = (k: PublicKey) => watched.set(k.toBase58(), k);
  add(input.owner);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getTokenAccountsByOwner(input.owner, { programId }, 'confirmed');
    for (const { pubkey } of res.value) add(pubkey);
  }
  for (const a of buyCreatableAccounts(input.owner, new PublicKey(input.expected.forgeMint))) {
    add(new PublicKey(a));
  }
  const keys = [...watched.values()];
  const before = await readAccounts(connection, keys);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    minContextSlot: before.slot,
    accounts: { encoding: 'base64', addresses: keys.map((k) => k.toBase58()) },
  });
  const again = await readAccounts(connection, keys);
  if (sim.value.err !== null && sim.value.err !== undefined) return 'simulation_failed';
  const post = sim.value.accounts;
  if (!post || post.length !== keys.length) return 'simulation_incomplete';
  for (let i = 0; i < keys.length; i++) {
    if (!sameState(before.states[i] ?? null, again.states[i] ?? null)) {
      return 'state_changed_during_check';
    }
  }
  const deltas: AccountDelta[] = keys.map((k, i) => {
    const p = post[i];
    return {
      address: k.toBase58(),
      pre: before.states[i] ?? null,
      post: p
        ? {
            owner: p.owner,
            lamports: BigInt(p.lamports),
            data: Buffer.from(p.data[0] ?? '', 'base64'),
          }
        : null,
    };
  });
  return compareBuybackStates(
    input.owner.toBase58(),
    input.expected,
    input.feeBoundLamports,
    deltas,
  );
}

export interface RpcBuybackSwapPreparerOptions {
  connection: SwapConnection;
  keystore: KeystoreLike;
  maxPriorityFeeLamports: bigint;
}

/**
 * Jupiter transaction (the Metis API's, or the one assembled from a Swap API V2 build) ->
 * verified, simulated, signed bytes. Uses the conversion job's static
 * allowlist (`verifySwapTransaction`): it checks the token side of the swap by mint without regard
 * to the direction, so it is called with `inputMint` = the $FORGE mint (owner = only signer and
 * fee payer, ATA creation only for wSOL / $FORGE, wSOL wrap/unwrap only on the owner's account,
 * bounded priority fee, no Approve / SetAuthority / token transfer) and exactly one Jupiter ExactIn
 * route whose decoded arguments match the buy quote: input = the lamports sold, no platform fee,
 * slippage <= the buyback cap, quoted output >= the quote's `outAmount`.
 */
export function createRpcBuybackSwapPreparer(
  opts: RpcBuybackSwapPreparerOptions,
): BuybackSwapPreparer {
  return {
    async prepare({ owner, ownerRef, swapTransaction, lastValidBlockHeight, expected }) {
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      } catch {
        return { status: 'refused', reason: 'undecodable' };
      }
      const lookupTables = await loadLookupTables(opts.connection, tx.message);
      if (!lookupTables) return { status: 'refused', reason: 'lookup_table_missing' };
      const check = verifySwapTransaction(tx, {
        owner: owner.toBase58(),
        lookupTables,
        expected: {
          inputMint: expected.forgeMint,
          inAmount: expected.inLamports,
          minOutLamports: 0n,
          // The route instruction is checked against the buy quote ($FORGE units).
          quotedOutAmount: expected.quotedOutAmount,
          maxSlippageBps: Math.min(expected.maxSlippageBps, MAX_BUYBACK_SLIPPAGE_BPS),
          forbiddenMints: [],
        },
        maxPriorityFeeLamports: opts.maxPriorityFeeLamports,
      });
      if (!check.ok) return { status: 'refused', reason: check.reason };
      const simulated = await checkBuybackSimulation(opts.connection, tx, {
        owner,
        expected,
        feeBoundLamports: check.feeBoundLamports,
      });
      if (simulated) return { status: 'refused', reason: simulated };
      const expiry =
        lastValidBlockHeight ??
        (await opts.connection.getBlockHeight('confirmed')) + FALLBACK_EXPIRY_BLOCKS;
      await opts.keystore.withSigner(ownerRef, (signer) => {
        if (!signer.publicKey.equals(owner)) throw new JobError('SIGNER_MISMATCH');
        signer.signTransaction(tx);
      });
      const first = tx.signatures[0];
      if (!first || first.length !== 64 || first.every((b) => b === 0)) {
        throw new JobError('NOT_SIGNED', 'swap transaction is not signed');
      }
      return {
        status: 'ready',
        signature: base58Encode(first),
        raw: tx.serialize(),
        lastValidBlockHeight: expiry,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Return transfer ($FORGE bot -> vault ATA)

export interface ForgeReturnParams {
  bot: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  programId: PublicKey;
  decimals: number;
  amount: bigint;
}

function assertTokenProgram(programId: PublicKey): void {
  if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new JobError('TX_POLICY', 'unexpected token program');
  }
}

/** What the return writes: the bot (fee payer), its $FORGE account and the vault's. */
export function forgeReturnWritableAccounts(params: ForgeReturnParams): PublicKey[] {
  return [
    params.bot,
    getAssociatedTokenAddressSync(params.mint, params.bot, true, params.programId),
    getAssociatedTokenAddressSync(params.mint, params.vault, true, params.programId),
  ];
}

/**
 * Unsigned: the compute budget of `priorityFee` first (unit limit then price, nothing at a zero
 * price or without a quote), idempotent vault ATA creation (paid by the bot), TransferChecked of
 * `amount`, memo.
 */
export function buildForgeReturnTx(
  params: ForgeReturnParams,
  priorityFee?: PriorityFeeQuote,
): Transaction {
  assertTokenProgram(params.programId);
  const botAta = getAssociatedTokenAddressSync(params.mint, params.bot, true, params.programId);
  const vaultAta = getAssociatedTokenAddressSync(params.mint, params.vault, true, params.programId);
  const tx = new Transaction();
  tx.add(
    ...(priorityFee ? signerBudgetInstructions(priorityFee) : []),
    createAssociatedTokenAccountIdempotentInstruction(
      params.bot,
      vaultAta,
      params.vault,
      params.mint,
      params.programId,
    ),
    createTransferCheckedInstruction(
      botAta,
      params.mint,
      vaultAta,
      params.bot,
      params.amount,
      params.decimals,
      [],
      params.programId,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(RETURN_MEMO, 'utf8'),
    }),
  );
  tx.feePayer = params.bot;
  return tx;
}

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

export interface ForgeReturnExpectation extends ForgeReturnParams {
  /**
   * Highest priority fee the return may carry, lamports: the cap of the setting it was priced
   * with (`PriorityFees.maxFeeLamports(FORGE_RETURN_COMPUTE_UNITS)`). Default and ceiling:
   * MAX_SIGNER_PRIORITY_FEE_LAMPORTS.
   */
  maxPriorityFeeLamports?: bigint;
}

/**
 * Return policy: fee payer and only signer = the bot; optionally the compute budget pair first
 * (a unit limit then a unit price, `assertSignerBudgetPair`, priority fee within
 * `maxPriorityFeeLamports`); at most one idempotent ATA creation (paid by the bot, for the vault,
 * of the $FORGE mint, before the transfer); exactly one TransferChecked of exactly `amount` from
 * the bot's $FORGE ATA to the vault's, authority = the bot; at most one memo equal to RETURN_MEMO
 * without keys. Nothing else (no other compute budget instruction, no other program).
 */
export function assertForgeReturnTx(tx: Transaction, expected: ForgeReturnExpectation): void {
  assertTokenProgram(expected.programId);
  if (expected.amount <= 0n) policy('return amount must be positive');
  if (expected.bot.equals(expected.vault)) policy('bot and vault must differ');
  if (!tx.feePayer?.equals(expected.bot)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  for (const s of requiredSigners(tx)) {
    if (!s.equals(expected.bot)) policy('unexpected required signer');
  }
  const botAta = getAssociatedTokenAddressSync(
    expected.mint,
    expected.bot,
    true,
    expected.programId,
  );
  const vaultAta = getAssociatedTokenAddressSync(
    expected.mint,
    expected.vault,
    true,
    expected.programId,
  );
  const budget = assertSignerBudgetPair(tx.instructions, expected.maxPriorityFeeLamports);
  let creates = 0;
  let transfers = 0;
  let memos = 0;
  for (const ix of tx.instructions.slice(budget)) {
    const data = Buffer.from(ix.data);
    const key = (i: number): PublicKey => {
      const meta = ix.keys[i];
      if (!meta) policy('instruction is missing accounts');
      return meta.pubkey;
    };
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(data.length === 1 && data[0] === 1) || ix.keys.length !== 6) {
        policy('associated token instruction not allowed');
      }
      if (transfers > 0) policy('account created after the transfer');
      if (
        !key(0).equals(expected.bot) ||
        !key(1).equals(vaultAta) ||
        !key(2).equals(expected.vault) ||
        !key(3).equals(expected.mint) ||
        !key(4).equals(SystemProgram.programId) ||
        !key(5).equals(expected.programId)
      ) {
        policy('unexpected token account creation');
      }
      creates++;
    } else if (ix.programId.equals(expected.programId)) {
      if (data.length !== 10 || data[0] !== 12) policy('token instruction not allowed');
      if (ix.keys.length !== 4) policy('transfer with extra signers');
      if (
        !key(0).equals(botAta) ||
        !key(1).equals(expected.mint) ||
        !key(2).equals(vaultAta) ||
        !key(3).equals(expected.bot)
      ) {
        policy('transfer between unexpected accounts');
      }
      if (data.readBigUInt64LE(1) !== expected.amount) policy('transfer amount mismatch');
      if (data[9] !== expected.decimals) policy('decimals mismatch');
      transfers++;
    } else if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      if (ix.keys.length !== 0) policy('memo with signer keys');
      if (data.toString('utf8') !== RETURN_MEMO) policy('memo mismatch');
      memos++;
    } else {
      policy('program not allowed in a return');
    }
  }
  if (transfers !== 1) policy('exactly one transfer expected');
  if (creates > 1 || memos > 1) policy('duplicate instruction');
}

/** Token reads over a web3.js connection (confirmed commitment). */
export function createRpcForgeTokenReader(
  connection: Pick<Connection, 'getAccountInfo'>,
): ForgeTokenReader {
  return {
    async mintInfo(mint) {
      const info = await connection.getAccountInfo(mint, 'confirmed');
      if (!info) throw new JobError('CONFIG', 'FORGE_MINT account not found');
      if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new JobError('CONFIG', 'FORGE_MINT is not a token mint');
      }
      if (info.data.length < MintLayout.span)
        throw new JobError('CONFIG', 'FORGE_MINT data invalid');
      const raw = MintLayout.decode(info.data.subarray(0, MintLayout.span));
      if (!raw.isInitialized) throw new JobError('CONFIG', 'FORGE_MINT is not initialized');
      return { programId: info.owner, decimals: raw.decimals };
    },
    async tokenBalance(account, expected) {
      const info = await connection.getAccountInfo(account, 'confirmed');
      if (!info) return 0n;
      const t = decodeTokenAccount(toLite(info));
      if (!t) throw new JobError('RPC', 'bot $FORGE account is not a token account');
      if (t.mint !== expected.mint.toBase58() || t.owner !== expected.owner.toBase58()) {
        throw new JobError('RPC', 'bot $FORGE account has an unexpected mint or owner');
      }
      return t.amount;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Job

export interface BuybackDeps {
  config: BuybackConfig;
  journal: Journal<BuybackJournalEntry>;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  /** Quotes (simulation logs them when present) and swap transactions (live). */
  quotes?: BuybackQuoteSource;
  budget?: BuybackBudgetSource;
  rng?: Rng;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retry?: RetryOptions;
  /** Interval of `start()` (default 60 s). */
  tickMs?: number;
  // Live only (all required when the environment asks for live).
  withdrawer?: SpendingLimitWithdrawer;
  keystore?: KeystoreLike;
  rpc?: SolanaRpc;
  swapPreparer?: BuybackSwapPreparer;
  tokens?: ForgeTokenReader;
  /** Serializes every job spending from the bot wallet. */
  walletLock?: Mutex;
  /** Called with each signature right before it is first broadcast (outflow watcher). */
  onBeforeSend?: BeforeSendHook;
  /**
   * Priority fee of the return transfer (SIGNER_PRIORITY_FEE_*, jobs/priority.ts), the setting
   * `buybackConfigFromEnv` sized the fee allowance with. Default: none.
   */
  priorityFees?: PriorityFees;
}

export type BuybackOutcome =
  | { result: 'idle'; nextAt?: number }
  | { result: 'no_budget'; reason: string }
  | { result: 'simulated'; slot: number; lamports: bigint; quotedOut?: bigint; note?: string }
  | { result: 'swapped'; slot: number; signature: string; lamports: bigint }
  | { result: 'returned'; signature: string; amount: bigint }
  | { result: 'in_flight'; signature: string; state: string }
  | { result: 'failed'; slot?: number; signature?: string; error: string }
  | { result: 'skipped'; slot?: number; reason: string };

/** The day's budget as planned, for the run summary and the logs (nothing secret). */
export interface BuybackBudgetSummary {
  day: string;
  budgetLamports: bigint;
  capLamports: bigint;
  /** Lamports planned in orders (every slot, whatever its status). */
  plannedLamports: bigint;
  unplannedLamports: bigint;
  botAvailableLamports: bigint | null;
  revenue: BuybackRevenueRecord | null;
}

export function summarizeBudget(entry: BuybackDayEntry): BuybackBudgetSummary {
  return {
    day: entry.day,
    budgetLamports: BigInt(entry.budgetLamports),
    capLamports: BigInt(entry.capLamports),
    plannedLamports: entry.slots.reduce((a, s) => a + BigInt(s.lamports), 0n),
    unplannedLamports: BigInt(entry.unplannedLamports ?? '0'),
    botAvailableLamports:
      entry.botAvailableLamports === undefined ? null : BigInt(entry.botAvailableLamports),
    revenue: entry.revenue ?? null,
  };
}

export interface BuybackRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  mode: BuybackMode;
  reason?: string;
  day?: string;
  outcome?: BuybackOutcome;
  /** The day's plan figures, once a plan exists for the day. */
  budget?: BuybackBudgetSummary;
}

export interface BuybackJob {
  readonly mode: BuybackMode;
  runOnce(): Promise<BuybackRunReport>;
  /** Runs `runOnce` every tick (never overlapping) until stopped. */
  start(): IntervalJobHandle;
}

interface LiveDeps {
  withdrawer: SpendingLimitWithdrawer;
  keystore: KeystoreLike;
  rpc: SolanaRpc;
  swapPreparer: BuybackSwapPreparer;
  tokens: ForgeTokenReader;
  walletLock: Mutex;
  quotes: BuybackQuoteSource;
  forgeMint: PublicKey;
  announce: (signature: string) => boolean;
}

export function createBuybackJob(deps: BuybackDeps): BuybackJob {
  const { config, journal, alerter, logger: log } = deps;
  validateBuybackConfig(config);
  const decision = resolveBuybackMode({
    cluster: config.cluster,
    live: config.live,
    forgeMint: config.forgeMint,
    hasWithdrawer: deps.withdrawer !== undefined,
    route: config.route,
    devnetTest: config.devnetTest,
  });
  if (decision.liveRequested && decision.mode !== 'live') {
    throw new JobError('CONFIG', `live buyback refused: ${decision.reason}`);
  }
  let live: LiveDeps | null = null;
  if (decision.mode === 'live') {
    const missing = (
      [
        'withdrawer',
        'keystore',
        'rpc',
        'swapPreparer',
        'tokens',
        'walletLock',
        'onBeforeSend',
        'quotes',
      ] as const
    ).filter((k) => deps[k] === undefined);
    if (missing.length > 0) {
      throw new JobError('CONFIG', `live buyback refused: missing ${missing.join(', ')}`);
    }
    live = {
      withdrawer: deps.withdrawer!,
      keystore: deps.keystore!,
      rpc: deps.rpc!,
      swapPreparer: deps.swapPreparer!,
      tokens: deps.tokens!,
      walletLock: deps.walletLock!,
      quotes: deps.quotes!,
      forgeMint: config.forgeMint!,
      announce: createAnnouncer(deps.onBeforeSend!, log),
    };
  }
  const mode = decision.mode;
  const rng = deps.rng ?? cryptoRng;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  const priorityFees = deps.priorityFees ?? NO_PRIORITY_FEES;
  const iso = () => new Date(now()).toISOString();
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    dedupKey?: string,
  ) => sendAlert(alerter, log, level, code, message, details, dedupKey);
  let running = false;

  log.info(
    {
      mode,
      reason: decision.reason,
      route: config.route,
      forgeMint: config.forgeMint?.toBase58() ?? null,
    },
    'buyback job configured',
  );

  async function stillAllowed(): Promise<boolean> {
    const pause = await checkPaused(deps.flags, BUYBACK_FLAG, config.paused, log);
    return !pause.paused;
  }

  /** The withdrawal transaction's own fee, paid by the bot and withdrawn with the orders. */
  function withdrawalFeeLamports(l: LiveDeps): bigint {
    const fee = l.withdrawer.maxFeeLamports?.() ?? 0n;
    if (typeof fee !== 'bigint' || fee < 0n) {
      throw new JobError('INVALID_AMOUNT', 'spending limit withdrawer returned an invalid fee');
    }
    return fee;
  }

  // ----- plan ---------------------------------------------------------------------------

  type NoBudgetReason = 'budget_unconfigured' | 'budget_unavailable';

  interface BudgetDecision {
    budget: bigint;
    figures: BuybackRevenueFigures | null;
    /** What bounded the budget: the cap, the backlog, the bot's SOL and what it can fund. */
    backlog: bigint | null;
    botAvailable: bigint | null;
    fundable: bigint | null;
  }

  /**
   * budget = min(cap, backlog + SOL already on the bot above its reserve, what the bot can fund).
   * The backlog is what the vault still owes the buyback (D35); the SOL already withdrawn to the
   * bot was counted as spent by the source and is buyable on top of it (never re-withdrawn).
   * Returns the reason instead of a budget when the source cannot establish one: nothing is
   * planned then (fail closed, alerted, retried on the next tick).
   */
  async function computeBudget(
    day: string,
    bot: PublicKey | null,
  ): Promise<BudgetDecision | NoBudgetReason> {
    let figures: BuybackRevenueFigures | null = null;
    let backlog: bigint | null = null;
    if (deps.budget) {
      const result = await deps.budget.backlog();
      if (result.status !== 'ok') {
        await alert(
          'high',
          `buyback_budget_${result.status}`,
          result.status === 'unconfigured'
            ? 'The buyback budget is not configured (BUYBACK_REVENUE_SINCE): nothing is bought until it is set'
            : 'The buyback budget cannot be established from the journals (unreadable or corrupt entry): nothing is bought until it is fixed',
          { day, reason: result.reason },
          `buyback_budget_${result.status}`,
        );
        log.warn({ day, status: result.status, reason: result.reason }, 'buyback budget unknown');
        return result.status === 'unconfigured' ? 'budget_unconfigured' : 'budget_unavailable';
      }
      figures = result.figures;
      backlog = figures.backlogLamports;
      if (typeof backlog !== 'bigint' || backlog < 0n) {
        throw new JobError('INVALID_AMOUNT', 'budget source returned an invalid amount');
      }
    }
    let budget = config.dailyCapLamports;
    let botAvailable: bigint | null = null;
    let fundable: bigint | null = null;
    if (live && bot) {
      const spendable = await spendableBalance(live.rpc, bot, retry);
      botAvailable =
        spendable > config.feeReserveLamports ? spendable - config.feeReserveLamports : 0n;
      const allowance = await live.withdrawer.remainingLamports(bot);
      if (typeof allowance !== 'bigint' || allowance < 0n) {
        throw new JobError('INVALID_AMOUNT', 'spending limit returned an invalid amount');
      }
      // What the wallet and the spending limit can put behind the day, minus the fee allowance
      // of every order and the withdrawal's own fee: `ensureFunding` withdraws the orders plus
      // those, so a budget that used the whole limit would leave the last orders unfunded
      // (skipped as insufficient_funds) once the limit binds.
      const fees =
        BigInt(config.ordersPerDay) * config.orderFeeAllowanceLamports +
        withdrawalFeeLamports(live);
      fundable = botAvailable + allowance > fees ? botAvailable + allowance - fees : 0n;
      if (fundable < budget) budget = fundable;
    }
    if (backlog !== null) {
      const buyable = backlog + (botAvailable ?? 0n);
      if (buyable < budget) budget = buyable;
    }
    return { budget, figures, backlog, botAvailable, fundable };
  }

  type PlanResult = { entry: BuybackDayEntry } | { entry: null; reason: NoBudgetReason };

  async function loadOrCreatePlan(day: string, bot: PublicKey | null): Promise<PlanResult> {
    const key = dayJournalKey(day);
    const existing = await journal.get(key);
    if (existing) {
      if (existing.kind !== 'day' || existing.day !== day) {
        throw new JobError('JOURNAL_CORRUPT', 'buyback day entry does not match its key');
      }
      return { entry: existing };
    }
    const t = now();
    const decision = await computeBudget(day, bot);
    if (typeof decision === 'string') return { entry: null, reason: decision };
    const { budget } = decision;
    const planned = planDay({
      dayStartMs: dayStartMs(t),
      budgetLamports: budget,
      orders: config.ordersPerDay,
      minOrderLamports: config.minOrderLamports,
      maxOrderLamports: config.maxOrderLamports,
      marginMs: config.dayMarginMs,
      rng,
    });
    const unplanned = unplannedLamports(budget, planned);
    const entry: BuybackDayEntry = {
      kind: 'day',
      v: 1,
      day,
      mode,
      createdAt: iso(),
      budgetLamports: budget.toString(),
      capLamports: config.dailyCapLamports.toString(),
      unplannedLamports: unplanned.toString(),
      ...(decision.botAvailable !== null
        ? { botAvailableLamports: decision.botAvailable.toString() }
        : {}),
      ...(decision.figures ? { revenue: revenueFiguresToRecord(decision.figures) } : {}),
      slots: planned.map((s) => ({
        index: s.index,
        at: s.at,
        lamports: s.lamports.toString(),
        // Created mid-day: the past slots are not caught up.
        status: s.at < t ? 'missed' : 'planned',
      })),
      funding: null,
    };
    await journal.put(key, entry);
    const active = entry.slots.filter((s) => s.status === 'planned');
    const f = decision.figures;
    log.info(
      {
        day,
        mode,
        budget: formatSol(budget),
        cap: formatSol(config.dailyCapLamports),
        backlog: decision.backlog === null ? null : formatSol(decision.backlog),
        botAvailable: decision.botAvailable === null ? null : formatSol(decision.botAvailable),
        fundable: decision.fundable === null ? null : formatSol(decision.fundable),
        unplanned: formatSol(unplanned),
        orders: active.length,
        missedAtCreation: entry.slots.length - active.length,
        total: formatSol(active.reduce((a, s) => a + BigInt(s.lamports), 0n)),
        ...(f
          ? {
              revenue: {
                since: f.since,
                total: formatSol(f.revenueLamports),
                forwards: formatSol(f.forwards.lamports),
                meteoraReferral: formatSol(f.forwards.breakdown.meteora_referral),
                jupiterReferral: formatSol(f.forwards.breakdown.jupiter_referral),
                platformFee: formatSol(f.forwards.breakdown.platform_fee),
                other: formatSol(f.forwards.breakdown.other),
                dbcClaims: formatSol(f.claims.dbc),
                positionClaims: formatSol(f.claims.position),
                claimsAwaitingFinality: f.claims.awaitingFinality,
                spent: formatSol(f.spent.lamports),
                withdrawals: f.spent.withdrawals,
              },
            }
          : {}),
      },
      'buyback day planned',
    );
    if (unplanned > 0n) {
      // Impossible with a validated configuration (cap <= orders x max order): said loudly.
      await alert(
        'high',
        'buyback_budget_unplanned',
        'Part of the day budget could not be placed in orders: it stays in the revenue backlog; check BUYBACK_ORDERS_PER_DAY and BUYBACK_MAX_ORDER_LAMPORTS',
        { day, unplanned: unplanned.toString(), budget: budget.toString() },
        'buyback_budget_unplanned',
      );
    }
    return { entry };
  }

  async function saveSlot(
    entry: BuybackDayEntry,
    index: number,
    patch: Partial<BuybackSlot>,
  ): Promise<BuybackDayEntry> {
    const next: BuybackDayEntry = {
      ...entry,
      slots: entry.slots.map((s) => (s.index === index ? { ...s, ...patch, updatedAt: iso() } : s)),
    };
    await journal.put(dayJournalKey(entry.day), next);
    return next;
  }

  // ----- in-flight transaction ------------------------------------------------------------

  async function getInFlight(): Promise<InFlightTx | null> {
    const e = await journal.get(INFLIGHT_KEY);
    if (!e) return null;
    if (e.kind !== 'inflight')
      throw new JobError('JOURNAL_CORRUPT', 'buyback in-flight entry invalid');
    return e.tx;
  }

  const putInFlight = (tx: InFlightTx | null) =>
    journal.put(INFLIGHT_KEY, { kind: 'inflight', v: 1, tx });

  async function resolveSwapSlot(tx: InFlightTx, status: SlotStatus, note?: string): Promise<void> {
    if (tx.day === undefined || tx.slotIndex === undefined) return;
    const entry = await journal.get(dayJournalKey(tx.day));
    if (entry?.kind !== 'day') return;
    await saveSlot(entry, tx.slotIndex, {
      status,
      signature: tx.signature,
      ...(note ? { note: note.slice(0, 200) } : {}),
    });
  }

  /** Settles the transaction in flight. Returns an outcome when the run must stop there. */
  async function settleInFlight(l: LiveDeps, wait: boolean): Promise<BuybackOutcome | null> {
    const tx = await getInFlight();
    if (!tx) return null;
    const raw = Buffer.from(tx.rawTx, 'base64');
    const s: Settlement = wait
      ? await awaitSettlement(l.rpc, tx.signature, {
          lastValidBlockHeight: tx.lastValidBlockHeight,
          raw,
          until: 'confirmed',
          ...settleTiming,
          retry,
          sleep,
          now,
          logger: log,
        })
      : await checkSettlement(l.rpc, tx.signature, tx.lastValidBlockHeight, retry);
    const amount = BigInt(tx.amount);
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      if (tx.purpose === 'swap') await resolveSwapSlot(tx, 'swapped');
      await putInFlight(null);
      log.info(
        { purpose: tx.purpose, signature: tx.signature, amount: tx.amount },
        'buyback transaction confirmed',
      );
      if (tx.purpose === 'swap') {
        return {
          result: 'swapped',
          slot: tx.slotIndex ?? -1,
          signature: tx.signature,
          lamports: amount,
        };
      }
      return { result: 'returned', signature: tx.signature, amount };
    }
    if (s.kind === 'failed' || s.kind === 'expired') {
      const error = s.kind === 'failed' ? s.error : 'blockhash expired';
      // One attempt per slot: a failed or expired buy is not retried (its SOL stays on the bot).
      if (tx.purpose === 'swap') await resolveSwapSlot(tx, 'failed', error);
      await putInFlight(null);
      if (s.kind === 'failed') {
        await alert(
          'high',
          `buyback_${tx.purpose}_failed`,
          tx.purpose === 'swap'
            ? 'A $FORGE buy failed on-chain (its SOL stays on the bot wallet)'
            : 'The $FORGE return transfer to the vault failed on-chain (retried next run)',
          { signature: tx.signature, error },
          `buyback_${tx.purpose}_failed`,
        );
      } else {
        log.warn({ purpose: tx.purpose, signature: tx.signature }, 'buyback transaction expired');
      }
      return {
        result: 'failed',
        ...(tx.slotIndex !== undefined ? { slot: tx.slotIndex } : {}),
        signature: tx.signature,
        error,
      };
    }
    if (!wait && s.kind === 'pending' && l.announce(tx.signature)) {
      try {
        await l.rpc.sendRawTransaction(raw);
      } catch (err) {
        log.debug({ err: describeError(err) }, 'buyback rebroadcast failed');
      }
    }
    if (wait && tx.purpose === 'swap') {
      await alert(
        'high',
        'buyback_swap_unknown',
        'A $FORGE buy was sent but is not settled yet: no other order until it is',
        { signature: tx.signature },
        `buyback_swap_unknown:${tx.signature}`,
      );
    }
    return { result: 'in_flight', signature: tx.signature, state: s.kind };
  }

  async function sendTracked(
    l: LiveDeps,
    tx: InFlightTx,
    raw: Uint8Array,
  ): Promise<BuybackOutcome> {
    if (!l.announce(tx.signature))
      return { result: 'in_flight', signature: tx.signature, state: 'not_announced' };
    const sent = await broadcast(l.rpc, raw, retry);
    if (sent.status === 'rejected') {
      // An earlier attempt may have reached the network: only proven expiry clears it.
      await alert(
        'high',
        `buyback_${tx.purpose}_rejected`,
        'The RPC rejected a buyback transaction (preflight simulation failed)',
        { signature: tx.signature, reason: sent.reason },
        `buyback_${tx.purpose}_rejected`,
      );
      return { result: 'in_flight', signature: tx.signature, state: 'rejected' };
    }
    return (
      (await settleInFlight(l, true)) ?? {
        result: 'in_flight',
        signature: tx.signature,
        state: 'unknown',
      }
    );
  }

  // ----- return of the bought tokens ---------------------------------------------------------

  async function returnTokens(
    l: LiveDeps,
    bot: PublicKey,
    botRef: string,
  ): Promise<BuybackOutcome | null> {
    const { programId, decimals } = await l.tokens.mintInfo(l.forgeMint);
    const botAta = getAssociatedTokenAddressSync(l.forgeMint, bot, true, programId);
    const amount = await l.tokens.tokenBalance(botAta, { mint: l.forgeMint, owner: bot });
    if (amount <= 0n) return null;
    if (!(await stillAllowed())) return { result: 'skipped', reason: 'paused' };
    const params: ForgeReturnParams = {
      bot,
      vault: config.vault,
      mint: l.forgeMint,
      programId,
      decimals,
      amount,
    };
    // Priced from the recent fees of the accounts it writes; the compute budget comes first.
    const priorityFee = await priorityFees.quote(
      forgeReturnWritableAccounts(params),
      FORGE_RETURN_COMPUTE_UNITS,
    );
    const tx = buildForgeReturnTx(params, priorityFee);
    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => l.rpc.getLatestBlockhash(),
      retry,
    );
    tx.recentBlockhash = blockhash;
    assertForgeReturnTx(tx, {
      ...params,
      maxPriorityFeeLamports: priorityFees.maxFeeLamports(FORGE_RETURN_COMPUTE_UNITS),
    });
    const { raw, signature } = await signWithKeystore(l.keystore, tx, [
      { ref: botRef, expected: bot },
    ]);
    const inFlight: InFlightTx = {
      purpose: 'return',
      signature,
      rawTx: raw.toString('base64'),
      lastValidBlockHeight,
      amount: amount.toString(),
      startedAt: iso(),
    };
    await putInFlight(inFlight);
    log.info(
      {
        signature,
        amount: amount.toString(),
        vault: config.vault.toBase58(),
        priorityFeeLamports: priorityFee.priorityFeeLamports.toString(),
        priorityFeeSource: priorityFee.source,
      },
      'returning $FORGE to the vault',
    );
    return sendTracked(l, inFlight, raw);
  }

  // ----- funding ----------------------------------------------------------------------------

  async function ensureFunding(
    l: LiveDeps,
    entry: BuybackDayEntry,
    bot: PublicKey,
  ): Promise<BuybackDayEntry> {
    const key = dayJournalKey(entry.day);
    if (entry.funding) {
      if (entry.funding.status !== 'requested') return entry;
      // A request journaled but never resolved (crash mid-call): never repeat it today.
      const next: BuybackDayEntry = {
        ...entry,
        funding: { ...entry.funding, status: 'unknown', note: 'interrupted', at: iso() },
      };
      await journal.put(key, next);
      await alert(
        'high',
        'buyback_funding_unknown',
        'A spending-limit withdrawal was interrupted: check the vault and the bot wallet (no new withdrawal today)',
        { day: entry.day, lamports: entry.funding.lamports },
        `buyback_funding_unknown:${entry.day}`,
      );
      return next;
    }
    // The planned orders plus a fee allowance each: the reserve is not what pays the day's fees.
    const remaining = entry.slots
      .filter((s) => s.status === 'planned')
      .reduce((a, s) => a + BigInt(s.lamports) + config.orderFeeAllowanceLamports, 0n);
    const spendable = await spendableBalance(l.rpc, bot, retry);
    const available =
      spendable > config.feeReserveLamports ? spendable - config.feeReserveLamports : 0n;
    let need = remaining > available ? remaining - available : 0n;
    if (need > 0n) {
      // The withdrawal pays its own fee (and priority fee) from what it brings.
      need += withdrawalFeeLamports(l);
      const allowance = await l.withdrawer.remainingLamports(bot);
      if (allowance < need) need = allowance;
    }
    if (need <= 0n) {
      const next: BuybackDayEntry = {
        ...entry,
        funding: { status: 'not_needed', lamports: '0', at: iso() },
      };
      await journal.put(key, next);
      return next;
    }
    if (!(await stillAllowed())) return entry;
    let next: BuybackDayEntry = {
      ...entry,
      funding: { status: 'requested', lamports: need.toString(), at: iso() },
    };
    await journal.put(key, next);
    const result = await l.withdrawer.withdraw({
      lamports: need,
      destination: bot,
      idempotencyKey: `buyback-funding-${entry.day}`,
      onBeforeSend: (signature) => {
        if (!l.announce(signature)) throw new JobError('CONFIG', 'onBeforeSend failed');
      },
    });
    const funding: FundingRecord =
      result.status === 'confirmed'
        ? { status: 'confirmed', lamports: need.toString(), signature: result.signature, at: iso() }
        : result.status === 'unknown'
          ? { status: 'unknown', lamports: need.toString(), signature: result.signature, at: iso() }
          : {
              status: 'failed',
              lamports: need.toString(),
              ...(result.status === 'failed' && result.signature
                ? { signature: result.signature }
                : {}),
              note: (result.status === 'failed' ? result.error : result.reason).slice(0, 200),
              at: iso(),
            };
    next = { ...next, funding };
    await journal.put(key, next);
    if (funding.status === 'confirmed') {
      log.info(
        { day: entry.day, lamports: funding.lamports, signature: funding.signature },
        'buyback funded',
      );
    } else {
      await alert(
        'high',
        `buyback_funding_${funding.status}`,
        funding.status === 'unknown'
          ? 'The spending-limit withdrawal outcome is unknown: check it (no new withdrawal today)'
          : 'The spending-limit withdrawal failed: orders run only on the SOL already on the bot wallet',
        {
          day: entry.day,
          lamports: funding.lamports,
          ...(funding.signature ? { signature: funding.signature } : {}),
        },
        `buyback_funding_${funding.status}:${entry.day}`,
      );
    }
    return next;
  }

  // ----- orders -----------------------------------------------------------------------------

  async function simulateSlot(entry: BuybackDayEntry, slot: BuybackSlot): Promise<BuybackOutcome> {
    const lamports = BigInt(slot.lamports);
    let note: string | undefined;
    let quotedOut: bigint | undefined;
    if (!config.forgeMint) {
      note = 'no_forge_mint';
    } else if (!deps.quotes) {
      note = 'no_quote_source';
    } else {
      try {
        // Simulation never reads the keystore: the quote is asked for the vault (any wallet gets
        // a quote; the instructions of a build are discarded).
        const quote = await deps.quotes.quote({
          outputMint: config.forgeMint.toBase58(),
          lamports,
          slippageBps: config.slippageBps,
          taker: config.vault.toBase58(),
        });
        const rejection = validateBuyQuote(
          quote,
          { forgeMint: config.forgeMint.toBase58(), lamports },
          { maxSlippageBps: config.slippageBps, maxPriceImpactBps: config.maxPriceImpactBps },
        );
        if (rejection) note = `quote_rejected:${rejection}`;
        else quotedOut = BigInt(quote.outAmount);
      } catch (err) {
        note = `quote_unavailable:${describeError(err).name}`;
      }
    }
    await saveSlot(entry, slot.index, {
      status: 'simulated',
      ...(quotedOut !== undefined ? { outAmount: quotedOut.toString() } : {}),
      ...(note ? { note } : {}),
    });
    log.info(
      {
        day: entry.day,
        slot: slot.index,
        lamports: slot.lamports,
        forgeMint: config.forgeMint?.toBase58() ?? null,
        quotedOut: quotedOut?.toString() ?? null,
        note: note ?? null,
      },
      'simulation: would buy $FORGE (nothing signed or sent)',
    );
    return {
      result: 'simulated',
      slot: slot.index,
      lamports,
      ...(quotedOut !== undefined ? { quotedOut } : {}),
      ...(note ? { note } : {}),
    };
  }

  async function liveSlot(
    l: LiveDeps,
    entry: BuybackDayEntry,
    slot: BuybackSlot,
    bot: PublicKey,
    botRef: string,
  ): Promise<BuybackOutcome> {
    const lamports = BigInt(slot.lamports);
    const forgeMint = l.forgeMint.toBase58();
    const skip = async (reason: string, alertIt = false): Promise<BuybackOutcome> => {
      await saveSlot(entry, slot.index, { status: 'skipped', note: reason.slice(0, 200) });
      if (alertIt) {
        await alert(
          'high',
          'buyback_order_skipped',
          `A $FORGE buy was skipped: ${reason}`,
          { day: entry.day, slot: slot.index },
          `buyback_order_skipped:${reason.split(':')[0]}`,
        );
      }
      return { result: 'skipped', slot: slot.index, reason };
    };

    const spendable = await spendableBalance(l.rpc, bot, retry);
    if (spendable < lamports + config.feeReserveLamports) return skip('insufficient_funds', true);

    let quote: JupiterQuote;
    try {
      quote = await l.quotes.quote({
        outputMint: forgeMint,
        lamports,
        slippageBps: config.slippageBps,
        taker: bot.toBase58(),
      });
    } catch (err) {
      return skip(`quote_unavailable:${describeError(err).name}`);
    }
    const rejection = validateBuyQuote(
      quote,
      { forgeMint, lamports },
      { maxSlippageBps: config.slippageBps, maxPriceImpactBps: config.maxPriceImpactBps },
    );
    if (rejection) return skip(`quote_rejected:${rejection}`, true);
    const expected: BuyExpectation = {
      forgeMint,
      inLamports: lamports,
      minOutAmount: BigInt(quote.otherAmountThreshold),
      quotedOutAmount: BigInt(quote.outAmount),
      maxSlippageBps: Math.min(config.slippageBps, MAX_BUYBACK_SLIPPAGE_BPS),
    };
    let swap: JupiterSwap;
    try {
      swap = await l.quotes.swap({ quote, userPublicKey: bot.toBase58() });
    } catch (err) {
      // Refused while assembling (Swap API V2): nothing signed, alerted like a refused transaction.
      if (err instanceof JupiterRefusal) return skip(`tx_refused:${err.reason}`, true);
      return skip(`swap_unavailable:${describeError(err).name}`);
    }
    // Kill switch re-read right before the key is used.
    if (!(await stillAllowed())) return { result: 'skipped', slot: slot.index, reason: 'paused' };
    const prepared = await l.swapPreparer.prepare({
      owner: bot,
      ownerRef: botRef,
      swapTransaction: swap.swapTransaction,
      ...(swap.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: swap.lastValidBlockHeight }
        : {}),
      expected,
    });
    if (prepared.status === 'refused') return skip(`tx_refused:${prepared.reason}`, true);

    // Journal BEFORE sending: in flight first, then the slot (a crash in between is reconciled
    // by the in-flight entry, which names the slot).
    const inFlight: InFlightTx = {
      purpose: 'swap',
      day: entry.day,
      slotIndex: slot.index,
      signature: prepared.signature,
      rawTx: Buffer.from(prepared.raw).toString('base64'),
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      amount: slot.lamports,
      startedAt: iso(),
    };
    await putInFlight(inFlight);
    await saveSlot(entry, slot.index, {
      status: 'submitted',
      signature: prepared.signature,
      outAmount: expected.minOutAmount.toString(),
    });
    log.info(
      {
        day: entry.day,
        slot: slot.index,
        lamports: slot.lamports,
        minOut: expected.minOutAmount.toString(),
        signature: prepared.signature,
      },
      'buying $FORGE',
    );
    return sendTracked(l, inFlight, prepared.raw);
  }

  async function processDueSlot(
    entry: BuybackDayEntry,
    l: LiveDeps | null,
    bot: PublicKey | null,
    botRef: string | null,
  ): Promise<BuybackOutcome> {
    const t = now();
    let current = entry;
    // A slot left `submitted` without an in-flight entry (journal written halfway): unknown.
    for (const s of current.slots) {
      if (s.status === 'submitted') {
        current = await saveSlot(current, s.index, {
          status: 'unknown',
          note: 'no in-flight record',
        });
        await alert(
          'high',
          'buyback_swap_unknown',
          'A $FORGE buy has no settlement record: check the bot wallet (it is not retried)',
          { day: current.day, slot: s.index, ...(s.signature ? { signature: s.signature } : {}) },
          `buyback_swap_unknown:${current.day}:${s.index}`,
        );
      }
    }
    let due: BuybackSlot | undefined;
    for (const s of current.slots) {
      if (s.status !== 'planned' || s.at > t) continue;
      if (t - s.at > config.maxLatenessMs) {
        current = await saveSlot(current, s.index, { status: 'missed', note: 'late' });
        log.info({ day: current.day, slot: s.index }, 'buyback slot missed (too late)');
        continue;
      }
      due = s;
      break;
    }
    if (!due) {
      const next = current.slots.find((s) => s.status === 'planned' && s.at > t);
      return { result: 'idle', ...(next ? { nextAt: next.at } : {}) };
    }
    // Daily cap, re-checked against the CURRENT configuration (a lowered cap applies at once).
    const cap =
      config.dailyCapLamports < BigInt(current.capLamports)
        ? config.dailyCapLamports
        : BigInt(current.capLamports);
    if (committedLamports(current.slots) + BigInt(due.lamports) > cap) {
      await saveSlot(current, due.index, { status: 'skipped', note: 'daily_cap' });
      log.warn({ day: current.day, slot: due.index }, 'buyback slot skipped: daily cap reached');
      return { result: 'skipped', slot: due.index, reason: 'daily_cap' };
    }
    if (current.mode === 'live' && l && bot && botRef)
      return liveSlot(l, current, due, bot, botRef);
    return simulateSlot(current, due);
  }

  // ----- run --------------------------------------------------------------------------------

  async function runLive(l: LiveDeps): Promise<BuybackRunReport> {
    const day = utcDay(now());
    let bot: PublicKey;
    let botRef: string;
    try {
      ({ ref: botRef, publicKey: bot } = await requireRoleRef(l.keystore, 'buyback'));
    } catch (err) {
      await alert('high', 'buyback_config', 'Buyback stopped: buyback key problem', {
        error: describeError(err).message,
      });
      return { status: 'error', mode, reason: 'buyback_key' };
    }
    if (bot.equals(config.vault))
      throw new JobError('CONFIG', 'the bot wallet and the vault must differ');
    const settled = await settleInFlight(l, false);
    if (settled) return { status: 'ran', mode, day, outcome: settled };
    const returned = await returnTokens(l, bot, botRef);
    if (returned) return { status: 'ran', mode, day, outcome: returned };
    const planned = await loadOrCreatePlan(day, bot);
    if (!planned.entry) {
      return { status: 'ran', mode, day, outcome: { result: 'no_budget', reason: planned.reason } };
    }
    let entry = planned.entry;
    if (entry.mode === 'live') entry = await ensureFunding(l, entry, bot);
    const budget = summarizeBudget(entry);
    if (entry.slots.length === 0) {
      return {
        status: 'ran',
        mode,
        day,
        outcome: { result: 'no_budget', reason: 'budget below one order' },
        budget,
      };
    }
    const outcome = await processDueSlot(entry, l, bot, botRef);
    return { status: 'ran', mode, day, outcome, budget };
  }

  async function runSimulation(): Promise<BuybackRunReport> {
    const day = utcDay(now());
    const planned = await loadOrCreatePlan(day, null);
    if (!planned.entry) {
      return { status: 'ran', mode, day, outcome: { result: 'no_budget', reason: planned.reason } };
    }
    const entry = planned.entry;
    const budget = summarizeBudget(entry);
    if (entry.slots.length === 0) {
      return {
        status: 'ran',
        mode,
        day,
        outcome: { result: 'no_budget', reason: 'budget below one order' },
        budget,
      };
    }
    const outcome = await processDueSlot(entry, null, null, null);
    return { status: 'ran', mode, day, outcome, budget };
  }

  async function runOnce(): Promise<BuybackRunReport> {
    if (running) return { status: 'busy', mode };
    running = true;
    try {
      const pause = await checkPaused(deps.flags, BUYBACK_FLAG, config.paused, log);
      if (pause.paused) {
        log.info({ reason: pause.reason }, 'buyback paused');
        await alertAbnormalPause(alerter, log, 'buyback', BUYBACK_FLAG, pause.reason);
        return { status: 'paused', mode, reason: pause.reason };
      }
      try {
        if (live) {
          const l = live;
          return await l.walletLock.runExclusive(() => runLive(l));
        }
        return await runSimulation();
      } catch (err) {
        const summary = describeError(err);
        const policyError =
          err instanceof JobError && (err.code === 'TX_POLICY' || err.code === 'SIGNER_MISMATCH');
        log.error({ err: summary }, 'buyback run failed');
        await alert(
          'high',
          policyError ? 'buyback_policy_violation' : 'buyback_run_failed',
          policyError
            ? 'A buyback transaction was refused before signing (policy check)'
            : 'The buyback run failed (journal, RPC or budget source unavailable?)',
          { error: summary.message },
          'buyback_run_failed',
        );
        return { status: 'error', mode, reason: summary.message };
      }
    } finally {
      running = false;
    }
  }

  return {
    mode,
    runOnce,
    start() {
      return startIntervalJob({
        name: 'buyback',
        intervalMs: deps.tickMs ?? 60_000,
        run: runOnce,
        logger: log,
      });
    },
  };
}
