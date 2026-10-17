/**
 * Priority fees of the transactions built by @forge/core (compute unit price).
 *
 * Under congestion a transaction without a compute unit price is dropped by the leaders long
 * before its blockhash expires; a late payment then becomes a manual anomaly. Every builder that
 * returns an unsigned transaction accepts an optional `priority` setting (`PriorityFeeSetting`):
 * the price is read from the cluster, bounded, and two compute budget instructions are put first
 * (`setComputeUnitLimit`, then `setComputeUnitPrice`; after the nonce advance of a durable nonce
 * transaction).
 *
 * The price, in micro-lamports per compute unit (pure: `computePriorityFee`):
 *
 *   p     = the `percentile` (nearest rank) of the `prioritizationFee` values returned by
 *           `getRecentPrioritizationFees` for the transaction's writable accounts (up to 150
 *           recent slots, zeros included);
 *   price = min(max(p, floorMicroLamports), maxMicroLamports, floor(maxLamports x 10^6 / limit))
 *
 * so the priority fee of the whole transaction, `ceil(limit x price / 10^6)` lamports, is never
 * above `maxLamports`, whatever the cluster answers. An empty answer, or an RPC error (the relay
 * refusing the method, a timeout), falls back to the floor: the quote says so (`source`), nothing
 * is hidden, and the transaction is still built.
 *
 * The compute unit limit is a per-transaction-kind constant measured on devnet with a margin
 * (e.g. `DEFAULT_SWAP_COMPUTE_UNIT_LIMIT`, `LAUNCH_COIN_COMPUTE_UNITS`, `PAYMENT_COMPUTE_UNITS`):
 * the price applies to the requested limit, not to what the transaction uses.
 *
 * Defaults (`DEFAULT_PRIORITY_FEE_POLICY`), sized for mainnet-beta and harmless on devnet: 75th
 * percentile, floor 10,000 micro-lamports per CU, at most 1,000,000 micro-lamports per CU (1
 * lamport) and at most 500,000 lamports (0.0005 SOL) per transaction. A setting can tighten or
 * relax them within the hard ceilings `MAX_PRIORITY_FEE_MICRO_LAMPORTS` (10 lamports per CU) and
 * `MAX_PRIORITY_FEE_LAMPORTS` (0.01 SOL), the bounds every FORGE verifier accepts.
 *
 * `checkComputeBudgetInstructions` is the matching check for transaction policies: compute
 * budget instructions in their exact form only (no accounts, `SetComputeUnitLimit` or
 * `SetComputeUnitPrice`, at most one of each), with bounded values.
 *
 * Browser-safe: only @solana/web3.js.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { computeBudgetInstructions, priorityFeeLamports } from './tx.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Solana's per-transaction compute ceiling (also the limit assumed when none is set). */
export const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;

/** Hard ceiling of a compute unit price: 10 lamports per CU (`MAX_SWAP_PRIORITY_FEE_MICRO_LAMPORTS`). */
export const MAX_PRIORITY_FEE_MICRO_LAMPORTS = 10_000_000;

/** Hard ceiling of the priority fee of one transaction: 0.01 SOL. */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

/**
 * Most writable accounts passed to `getRecentPrioritizationFees` (the RPC accepts 128; the FORGE
 * relay accepts this many).
 */
export const MAX_PRIORITY_FEE_ACCOUNTS = 32;

/** How the price is chosen and bounded. */
export interface PriorityFeePolicy {
  /** Percentile of the recent fees, an integer from 0 (lowest) to 100 (highest). */
  percentile: number;
  /** Lowest price, micro-lamports per CU (also the price when the cluster gives none). */
  floorMicroLamports: number;
  /** Highest price, micro-lamports per CU. */
  maxMicroLamports: number;
  /** Highest priority fee of the whole transaction, lamports (the cost guard shown to users). */
  maxLamports: bigint;
}

/** What a caller passes: any subset of the policy, the rest from `DEFAULT_PRIORITY_FEE_POLICY`. */
export type PriorityFeeSetting = Partial<PriorityFeePolicy>;

/** Mainnet-sized defaults (see the top of this file). */
export const DEFAULT_PRIORITY_FEE_POLICY: Readonly<PriorityFeePolicy> = Object.freeze({
  percentile: 75,
  floorMicroLamports: 10_000,
  maxMicroLamports: 1_000_000,
  maxLamports: 500_000n,
});

/** One entry of `getRecentPrioritizationFees`. */
export interface RecentPrioritizationFee {
  slot: number;
  /** Micro-lamports per CU paid by the cheapest transaction of the slot writing those accounts. */
  prioritizationFee: number;
}

/**
 * Where the price comes from: the recent fees, the floor because the cluster returned no fee, or
 * the floor because the fees could not be read (`rpc_unavailable`).
 */
export type PriorityFeeSource = 'recent_fees' | 'no_recent_fees' | 'rpc_unavailable' | 'fixed';

/** The priority fee of one transaction, as the builders return it. */
export interface PriorityFeeQuote {
  /** Compute unit limit the price applies to (the one set by the transaction). */
  computeUnitLimit: number;
  /** Compute unit price, micro-lamports per CU (0: no `setComputeUnitPrice` instruction). */
  microLamports: number;
  /** Priority fee the transaction pays at most: `ceil(limit x price / 10^6)` lamports. */
  priorityFeeLamports: bigint;
  /** The cost guard: no priority fee of this setting is ever above it (lamports). */
  maxLamports: bigint;
  source: PriorityFeeSource;
}

// ---------------------------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------------------------

function assertInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * The full policy of a setting: defaults filled in, every value checked against the hard
 * ceilings. @throws RangeError on an invalid value.
 */
export function resolvePriorityFeePolicy(setting: PriorityFeeSetting = {}): PriorityFeePolicy {
  if (setting === null || typeof setting !== 'object') {
    throw new RangeError('the priority fee setting must be an object');
  }
  const percentile = assertInteger(
    'percentile',
    setting.percentile ?? DEFAULT_PRIORITY_FEE_POLICY.percentile,
    0,
    100,
  );
  const maxMicroLamports = assertInteger(
    'maxMicroLamports',
    setting.maxMicroLamports ?? DEFAULT_PRIORITY_FEE_POLICY.maxMicroLamports,
    0,
    MAX_PRIORITY_FEE_MICRO_LAMPORTS,
  );
  const floorMicroLamports = assertInteger(
    'floorMicroLamports',
    setting.floorMicroLamports ??
      Math.min(DEFAULT_PRIORITY_FEE_POLICY.floorMicroLamports, maxMicroLamports),
    0,
    maxMicroLamports,
  );
  const maxLamports = setting.maxLamports ?? DEFAULT_PRIORITY_FEE_POLICY.maxLamports;
  if (
    typeof maxLamports !== 'bigint' ||
    maxLamports < 0n ||
    maxLamports > MAX_PRIORITY_FEE_LAMPORTS
  ) {
    throw new RangeError(
      `maxLamports must be a bigint between 0 and ${MAX_PRIORITY_FEE_LAMPORTS} lamports`,
    );
  }
  return { percentile, floorMicroLamports, maxMicroLamports, maxLamports };
}

/**
 * Nearest-rank percentile of `values` (0 = lowest, 100 = highest); 0 for an empty list.
 * @throws RangeError on a percentile outside 0..100.
 */
export function feePercentile(values: readonly number[], percentile: number): number {
  assertInteger('percentile', percentile, 0, 100);
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/** Highest price whose fee at `computeUnitLimit` stays within `maxLamports`. */
export function maxPriceForBudget(computeUnitLimit: number, maxLamports: bigint): number {
  assertInteger('computeUnitLimit', computeUnitLimit, 1, MAX_TRANSACTION_COMPUTE_UNITS);
  const price = (maxLamports * 1_000_000n) / BigInt(computeUnitLimit);
  return price > BigInt(MAX_PRIORITY_FEE_MICRO_LAMPORTS)
    ? MAX_PRIORITY_FEE_MICRO_LAMPORTS
    : Number(price);
}

/**
 * Pure: the price of a transaction of `computeUnitLimit` CU from the recent fees (see the top of
 * this file). `recentFees: null` means the fees could not be read (`rpc_unavailable`); entries
 * that are not non-negative safe integers are ignored.
 *
 * @throws RangeError on an invalid limit or policy.
 */
export function computePriorityFee(input: {
  recentFees: readonly RecentPrioritizationFee[] | null;
  computeUnitLimit: number;
  policy?: PriorityFeeSetting;
}): PriorityFeeQuote {
  const policy = resolvePriorityFeePolicy(input.policy);
  const units = assertInteger(
    'computeUnitLimit',
    input.computeUnitLimit,
    1,
    MAX_TRANSACTION_COMPUTE_UNITS,
  );
  const values =
    input.recentFees === null
      ? []
      : input.recentFees
          .map((entry) => entry?.prioritizationFee)
          .filter((fee): fee is number => Number.isSafeInteger(fee) && (fee as number) >= 0);
  const source: PriorityFeeSource =
    input.recentFees === null
      ? 'rpc_unavailable'
      : values.length > 0
        ? 'recent_fees'
        : 'no_recent_fees';
  let price = Math.max(feePercentile(values, policy.percentile), policy.floorMicroLamports);
  price = Math.min(price, policy.maxMicroLamports, maxPriceForBudget(units, policy.maxLamports));
  return {
    computeUnitLimit: units,
    microLamports: price,
    priorityFeeLamports: priorityFeeLamports({ units, microLamports: price }),
    maxLamports: policy.maxLamports,
    source,
  };
}

/**
 * The most a transaction of `computeUnitLimit` CU can pay as priority fee under `setting`, in
 * lamports: its fee at the highest price the setting allows. The cost guard to show before the
 * transaction is built (e.g. next to a swap quote).
 */
export function maxPriorityFeeLamports(
  computeUnitLimit: number,
  setting?: PriorityFeeSetting,
): bigint {
  return computePriorityFee({
    recentFees: [{ slot: 0, prioritizationFee: MAX_PRIORITY_FEE_MICRO_LAMPORTS }],
    computeUnitLimit,
    ...(setting ? { policy: setting } : {}),
  }).priorityFeeLamports;
}

/**
 * A quote for a fixed price (the builders' legacy `computeUnitPriceMicroLamports` /
 * `priorityFeeMicroLamports` parameters): no RPC read, the given price as is.
 */
export function fixedPriorityFee(
  computeUnitLimit: number,
  microLamports: number,
): PriorityFeeQuote {
  assertInteger('computeUnitLimit', computeUnitLimit, 1, MAX_TRANSACTION_COMPUTE_UNITS);
  assertInteger('microLamports', microLamports, 0, Number.MAX_SAFE_INTEGER);
  const fee = priorityFeeLamports({ units: computeUnitLimit, microLamports });
  return {
    computeUnitLimit,
    microLamports,
    priorityFeeLamports: fee,
    maxLamports: fee,
    source: 'fixed',
  };
}

/**
 * The compute budget instructions of a quote, to put first: `setComputeUnitLimit`, then
 * `setComputeUnitPrice` when the price is not 0. `priceOnly`: the price alone (no limit), for a
 * transaction too tight for both; its quote must then be computed for
 * `MAX_TRANSACTION_COMPUTE_UNITS`, the limit the runtime may apply.
 */
export function priorityFeeInstructions(
  quote: Pick<PriorityFeeQuote, 'computeUnitLimit' | 'microLamports'>,
  options: { priceOnly?: boolean } = {},
): TransactionInstruction[] {
  if (!options.priceOnly) {
    return computeBudgetInstructions({
      units: quote.computeUnitLimit,
      microLamports: quote.microLamports,
    });
  }
  assertInteger('microLamports', quote.microLamports, 0, MAX_PRIORITY_FEE_MICRO_LAMPORTS);
  return quote.microLamports > 0
    ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: quote.microLamports })]
    : [];
}

/**
 * The writable accounts of `instructions`, without duplicates, in order of appearance (at most
 * `MAX_PRIORITY_FEE_ACCOUNTS`): what the leaders lock, so what the recent fees are read for.
 */
export function writableAccountsOf(instructions: readonly TransactionInstruction[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const ix of instructions) {
    for (const meta of ix.keys) {
      if (!meta.isWritable) continue;
      const id = meta.pubkey.toBase58();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(meta.pubkey);
      if (out.length === MAX_PRIORITY_FEE_ACCOUNTS) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------

/** The connection method the estimate uses (a `Connection` satisfies it). */
export type PriorityFeeReader = Pick<Connection, 'getRecentPrioritizationFees'>;

/**
 * Reads the recent prioritization fees for `writableAccounts` (deduplicated, at most
 * `MAX_PRIORITY_FEE_ACCOUNTS`). Throws what the connection throws.
 */
export async function readRecentPriorityFees(
  connection: PriorityFeeReader,
  writableAccounts: readonly PublicKey[],
): Promise<RecentPrioritizationFee[]> {
  const seen = new Set<string>();
  const accounts: PublicKey[] = [];
  for (const account of writableAccounts) {
    if (!(account instanceof PublicKey))
      throw new TypeError('writable accounts must be PublicKeys');
    const id = account.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    accounts.push(account);
    if (accounts.length === MAX_PRIORITY_FEE_ACCOUNTS) break;
  }
  const fees = await connection.getRecentPrioritizationFees(
    accounts.length > 0 ? { lockedWritableAccounts: accounts } : undefined,
  );
  if (!Array.isArray(fees))
    throw new TypeError('getRecentPrioritizationFees did not return a list');
  return fees;
}

export interface EstimatePriorityFeeParams {
  connection: PriorityFeeReader;
  /** The transaction's writable accounts (`writableAccountsOf`). */
  writableAccounts: readonly PublicKey[];
  computeUnitLimit: number;
  setting?: PriorityFeeSetting;
}

/**
 * Reads the recent fees and computes the price (`computePriorityFee`). A failed read is not an
 * error: the price is the floor and the quote says `rpc_unavailable`. Invalid settings throw
 * (RangeError) before any network call.
 */
export async function estimatePriorityFee(
  params: EstimatePriorityFeeParams,
): Promise<PriorityFeeQuote> {
  // Validate first: a bad setting never reaches the network.
  computePriorityFee({
    recentFees: [],
    computeUnitLimit: params.computeUnitLimit,
    ...(params.setting ? { policy: params.setting } : {}),
  });
  let recentFees: RecentPrioritizationFee[] | null;
  try {
    recentFees = await readRecentPriorityFees(params.connection, params.writableAccounts);
  } catch {
    // Degraded, reported in the quote (`source`): the floor still gives the transaction a price.
    recentFees = null;
  }
  return computePriorityFee({
    recentFees,
    computeUnitLimit: params.computeUnitLimit,
    ...(params.setting ? { policy: params.setting } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Verification (transaction policies)
// ---------------------------------------------------------------------------------------------

export type ComputeBudgetCheckCode =
  /** A compute budget instruction with accounts, or of another kind (heap frame, data size...). */
  | 'unexpected_instruction'
  /** Two unit limits or two unit prices. */
  | 'duplicate_instruction'
  | 'limit_out_of_range'
  | 'price_too_high'
  | 'fee_too_high';

/** A compute budget instruction is not in the accepted form or above the bounds. */
export class ComputeBudgetCheckError extends Error {
  readonly code: ComputeBudgetCheckCode;

  constructor(code: ComputeBudgetCheckCode, message: string) {
    super(message);
    this.name = 'ComputeBudgetCheckError';
    this.code = code;
  }
}

export interface ComputeBudgetBounds {
  /** Highest unit limit (default `MAX_TRANSACTION_COMPUTE_UNITS`). */
  maxComputeUnits?: number;
  /** Highest unit price, micro-lamports per CU (default `MAX_PRIORITY_FEE_MICRO_LAMPORTS`). */
  maxMicroLamports?: number | bigint;
  /** Highest priority fee of the transaction, lamports (default `MAX_PRIORITY_FEE_LAMPORTS`). */
  maxPriorityFeeLamports?: bigint;
}

export interface ComputeBudgetSummary {
  /** The unit limit set, or null when there is none. */
  computeUnitLimit: number | null;
  /** The unit price set, micro-lamports per CU (0 when there is none). */
  microLamports: bigint;
  /**
   * The highest priority fee the transaction can pay, lamports. Without a unit limit it is
   * computed for `MAX_TRANSACTION_COMPUTE_UNITS` (the runtime's default depends on the
   * instructions; this bound holds for any of them).
   */
  priorityFeeLamports: bigint;
}

/** What `checkComputeBudgetInstructions` reads of an instruction (a web3.js instruction fits). */
export interface InspectedInstruction {
  programId: PublicKey;
  keys: readonly unknown[];
  data: Uint8Array;
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

/**
 * Checks every Compute Budget instruction of `instructions` (other programs are left to the
 * caller's policy): no account, `SetComputeUnitLimit` (tag 2, u32) or `SetComputeUnitPrice`
 * (tag 3, u64) only, at most one of each, limit within 1..`maxComputeUnits`, price within
 * `maxMicroLamports`, priority fee within `maxPriorityFeeLamports`.
 *
 * @throws ComputeBudgetCheckError with a stable `code`.
 */
export function checkComputeBudgetInstructions(
  instructions: readonly InspectedInstruction[],
  bounds: ComputeBudgetBounds = {},
): ComputeBudgetSummary {
  const maxUnits = bounds.maxComputeUnits ?? MAX_TRANSACTION_COMPUTE_UNITS;
  const maxPrice = BigInt(bounds.maxMicroLamports ?? MAX_PRIORITY_FEE_MICRO_LAMPORTS);
  const maxFee = bounds.maxPriorityFeeLamports ?? MAX_PRIORITY_FEE_LAMPORTS;
  let units: number | null = null;
  let price: bigint | null = null;
  for (const ix of instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    const data = ix.data;
    if (ix.keys.length !== 0) {
      throw new ComputeBudgetCheckError(
        'unexpected_instruction',
        'compute budget instruction with accounts',
      );
    }
    if (data[0] === 2 && data.length === 5) {
      if (units !== null) {
        throw new ComputeBudgetCheckError('duplicate_instruction', 'duplicate compute unit limit');
      }
      units = readU32(data, 1);
      if (units < 1 || units > maxUnits) {
        throw new ComputeBudgetCheckError('limit_out_of_range', 'compute unit limit out of range');
      }
    } else if (data[0] === 3 && data.length === 9) {
      if (price !== null) {
        throw new ComputeBudgetCheckError('duplicate_instruction', 'duplicate compute unit price');
      }
      price = readU64(data, 1);
      if (price > maxPrice) {
        throw new ComputeBudgetCheckError('price_too_high', 'compute unit price too high');
      }
    } else {
      throw new ComputeBudgetCheckError(
        'unexpected_instruction',
        'compute budget instruction other than a unit limit or a unit price',
      );
    }
  }
  const microLamports = price ?? 0n;
  const budget = BigInt(units ?? MAX_TRANSACTION_COMPUTE_UNITS);
  const fee = (budget * microLamports + 999_999n) / 1_000_000n;
  if (fee > maxFee) throw new ComputeBudgetCheckError('fee_too_high', 'priority fee too high');
  return { computeUnitLimit: units, microLamports, priorityFeeLamports: fee };
}
