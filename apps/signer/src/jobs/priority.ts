/**
 * Priority fees of the transactions the signer builds or has core build (claims, refunds, cashbox
 * sweeps, revenue unwrap and forward, launchpad accounts and launches, Jupiter referral claims).
 *
 * The price is the one of @forge/core (`estimatePriorityFee`): the `percentile` of the recent
 * prioritization fees of the accounts the transaction writes (`getRecentPrioritizationFees` on
 * the signer's own RPC), at least the floor and at most the cap per compute unit, and the whole
 * priority fee of a transaction never above `maxLamports`. When the fees cannot be read, the
 * price is the floor (logged by the caller through the quote's `source`).
 *
 * Environment (runtime/env.ts, apps/signer/.env.example):
 * - SIGNER_PRIORITY_FEE_MICRO_LAMPORTS (default 0): the floor, micro-lamports per CU. It was the
 *   fixed price before; set it equal to SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS to get a fixed
 *   price again;
 * - SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS (default 1,000,000 = 1 lamport per CU, at most
 *   `MAX_COMPUTE_UNIT_PRICE`): the cap per CU; 0 turns priority fees off (the transactions are
 *   built as before, without a price);
 * - SIGNER_PRIORITY_FEE_PERCENTILE (default 75);
 * - SIGNER_PRIORITY_FEE_MAX_LAMPORTS (default 500,000 = 0.0005 SOL, at most
 *   `MAX_SIGNER_PRIORITY_FEE_LAMPORTS`): the cap of one transaction.
 *
 * The transaction policies (shared.ts `assertComputeBudgetSet`, routes/policy.ts) accept the
 * compute budget instructions this produces and nothing else: one unit limit and one unit price
 * at most, bounded by the same hard ceilings.
 */
import {
  estimatePriorityFee,
  fixedPriorityFee,
  maxPriorityFeeLamports,
  priorityFeeInstructions,
  type PriorityFeeQuote,
  type PriorityFeeReader,
  type PriorityFeeSetting,
} from '@forge/core';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { JobError, MAX_COMPUTE_UNIT_PRICE, MAX_SIGNER_PRIORITY_FEE_LAMPORTS } from './shared.js';

/**
 * Compute unit limit of the signer's SOL transfers with a priority fee (cashbox sweep, refund,
 * revenue forward): a System transfer and a memo without signer, with a wide margin.
 */
export const SOL_TRANSFER_COMPUTE_UNITS = 30_000;

export interface SignerPriorityFeeConfig {
  /** SIGNER_PRIORITY_FEE_MICRO_LAMPORTS: lowest price, micro-lamports per CU. */
  floorMicroLamports: number;
  /** SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS: highest price per CU (0 = no priority fee). */
  maxMicroLamports: number;
  /** SIGNER_PRIORITY_FEE_PERCENTILE: percentile of the recent fees (0 to 100). */
  percentile: number;
  /** SIGNER_PRIORITY_FEE_MAX_LAMPORTS: highest priority fee of one transaction. */
  maxLamports: bigint;
}

export const DEFAULT_SIGNER_PRIORITY_FEE: Readonly<SignerPriorityFeeConfig> = Object.freeze({
  floorMicroLamports: 0,
  maxMicroLamports: 1_000_000,
  percentile: 75,
  maxLamports: 500_000n,
});

/** Priority fees turned off: no price on any transaction (the shape before priority fees). */
export const PRIORITY_FEES_OFF: Readonly<SignerPriorityFeeConfig> = Object.freeze({
  floorMicroLamports: 0,
  maxMicroLamports: 0,
  percentile: 75,
  maxLamports: 0n,
});

/** @throws JobError CONFIG on a value outside the bounds. */
export function assertSignerPriorityFeeConfig(config: SignerPriorityFeeConfig): void {
  const int = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const maxPrice = Number(MAX_COMPUTE_UNIT_PRICE);
  if (!int(config.maxMicroLamports, 0, maxPrice)) {
    throw new JobError('CONFIG', `the priority fee cap per CU must be between 0 and ${maxPrice}`);
  }
  if (!int(config.floorMicroLamports, 0, config.maxMicroLamports)) {
    throw new JobError('CONFIG', 'the priority fee floor must be between 0 and its cap per CU');
  }
  if (!int(config.percentile, 0, 100)) {
    throw new JobError('CONFIG', 'the priority fee percentile must be between 0 and 100');
  }
  if (
    typeof config.maxLamports !== 'bigint' ||
    config.maxLamports < 0n ||
    config.maxLamports > MAX_SIGNER_PRIORITY_FEE_LAMPORTS
  ) {
    throw new JobError(
      'CONFIG',
      `the priority fee cap per transaction must be between 0 and ${MAX_SIGNER_PRIORITY_FEE_LAMPORTS} lamports`,
    );
  }
}

export interface PriorityFees {
  /** The setting handed to the core builders, or undefined when priority fees are off. */
  readonly setting: PriorityFeeSetting | undefined;
  /** The price of a transaction writing `writable`, of `computeUnitLimit` CU. */
  quote(writable: readonly PublicKey[], computeUnitLimit: number): Promise<PriorityFeeQuote>;
  /** The most a transaction of `computeUnitLimit` CU pays (fee buffers), 0 when off. */
  maxFeeLamports(computeUnitLimit: number): bigint;
}

/**
 * Priority fees over `reader` (the signer's connection). `reader` null: the floor price, as when
 * the fees cannot be read.
 */
export function createPriorityFees(
  reader: PriorityFeeReader | null,
  config: SignerPriorityFeeConfig = DEFAULT_SIGNER_PRIORITY_FEE,
): PriorityFees {
  assertSignerPriorityFeeConfig(config);
  const off = config.maxMicroLamports === 0 || config.maxLamports === 0n;
  const setting: PriorityFeeSetting = {
    percentile: config.percentile,
    floorMicroLamports: config.floorMicroLamports,
    maxMicroLamports: config.maxMicroLamports,
    maxLamports: config.maxLamports,
  };
  const failing: PriorityFeeReader = {
    getRecentPrioritizationFees: () => Promise.reject(new Error('no priority fee reader')),
  };
  return {
    setting: off ? undefined : setting,
    async quote(writable, computeUnitLimit) {
      if (off) return fixedPriorityFee(computeUnitLimit, 0);
      return estimatePriorityFee({
        connection: reader ?? failing,
        writableAccounts: writable,
        computeUnitLimit,
        setting,
      });
    },
    maxFeeLamports(computeUnitLimit) {
      return off ? 0n : maxPriorityFeeLamports(computeUnitLimit, setting);
    },
  };
}

/** No priority fee at all (tests, tools): every quote is a zero price. */
export const NO_PRIORITY_FEES: PriorityFees = createPriorityFees(null, PRIORITY_FEES_OFF);

/**
 * The compute budget instructions of a quote for a transaction the signer builds itself: the unit
 * limit then the price, or nothing at a zero price (the shape of these transactions without a
 * priority fee).
 */
export function signerBudgetInstructions(quote: PriorityFeeQuote): TransactionInstruction[] {
  return quote.microLamports > 0 ? priorityFeeInstructions(quote) : [];
}
