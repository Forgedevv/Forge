import type { DecodedTransaction } from './decode';
import { VerificationError } from './errors';
import { COMPUTE_BUDGET_PROGRAM_ID } from './programs';
import { parseComputeBudget } from './parse';

/**
 * LOCKED ZONE. Network fee of a transaction, computed from the transaction itself (never taken from
 * a server): Solana's base fee per signature plus the priority fee
 * `ceil(compute unit limit x micro-lamports per CU / 10^6)`, at most `MAX_PRIORITY_FEE_LAMPORTS`.
 */

/** Base fee per signature (protocol constant). */
export const LAMPORTS_PER_SIGNATURE = BigInt(5000);

/**
 * Highest priority fee of one transaction (0.0005 SOL): the cap of the site's own setting
 * (`SITE_PRIORITY_FEE`, the @forge/core defaults); a test pins it to core.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = BigInt(500_000);

const MICRO_LAMPORTS_PER_LAMPORT = BigInt(1_000_000);

export interface ComputeBudget {
  unitLimit: number | null;
  microLamports: bigint;
}

/**
 * Reads the compute budget instructions; refuses duplicates, a price without a limit and a
 * priority fee above `MAX_PRIORITY_FEE_LAMPORTS`.
 */
export function readComputeBudget(decoded: DecodedTransaction): ComputeBudget {
  let unitLimit: number | null = null;
  let microLamports: bigint | null = null;
  for (const ix of decoded.instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const parsed = parseComputeBudget(ix);
    if (parsed.kind === 'setComputeUnitLimit') {
      if (unitLimit !== null) throw new VerificationError('Duplicate compute unit limit.');
      unitLimit = parsed.units;
    } else {
      if (microLamports !== null) throw new VerificationError('Duplicate priority fee.');
      microLamports = parsed.microLamports;
    }
  }
  if (microLamports !== null && microLamports > BigInt(0) && unitLimit === null) {
    // Without an explicit limit the priority fee depends on runtime defaults: not verifiable.
    throw new VerificationError(
      'The transaction sets a priority fee without a compute unit limit. Nothing was signed.',
    );
  }
  const budget = { unitLimit, microLamports: microLamports ?? BigInt(0) };
  if (priorityFee(budget) > MAX_PRIORITY_FEE_LAMPORTS) {
    throw new VerificationError(
      'The priority fee of the transaction is above the maximum of this site. Nothing was signed.',
    );
  }
  return budget;
}

function priorityFee(budget: ComputeBudget): bigint {
  if (budget.microLamports === BigInt(0) || budget.unitLimit === null) return BigInt(0);
  return (
    (BigInt(budget.unitLimit) * budget.microLamports + MICRO_LAMPORTS_PER_LAMPORT - BigInt(1)) /
    MICRO_LAMPORTS_PER_LAMPORT
  );
}

/** Exact network fee in lamports (base fee for every required signature + priority fee). */
export function networkFeeLamports(decoded: DecodedTransaction): bigint {
  const budget = readComputeBudget(decoded);
  const signatures = BigInt(decoded.requiredSigners.length) * LAMPORTS_PER_SIGNATURE;
  return signatures + priorityFee(budget);
}
