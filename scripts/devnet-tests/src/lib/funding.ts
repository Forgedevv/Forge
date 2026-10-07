/**
 * Funding of the throwaway wallets from the `funder` wallet.
 *
 * The human sends devnet SOL to the funder (https://faucet.solana.com); the scripts then
 * distribute it. When the funder cannot cover a test, `ensureFunded` throws `FundingNeeded`
 * and the script prints the funder public address and the amount to send, then exits with code 2.
 */
import type { PublicKey } from '@solana/web3.js';
import { getBalance, transferSol, formatSol } from './solana.js';
import { missingLamports, solToLamports } from './math.js';
import type { WalletName, Wallets } from './wallets.js';

export const EXIT_FUNDING_NEEDED = 2;

/** Kept in the funder for transfer fees. */
const FUNDER_RESERVE = solToLamports(0.01);

export type Budget = Partial<Record<Exclude<WalletName, 'funder'>, number>>; // SOL per wallet

/** Lamports each wallet should hold before a test starts. */
export const BUDGETS: Record<'mint' | 'test1' | 'test2' | 'test3' | 'test4', Budget> = {
  // fake $FORGE mint (mint + ATA rent + fees)
  mint: { forgeCreator: 0.02 },
  // config (partner) + pool (forgeCreator) + referral WSOL account + two 0.1 SOL buys
  test1: { partner: 0.06, forgeCreator: 0.06, referral: 0.01, trader: 0.25 },
  // config + pool + migration rent + buys/sells + filling the curve to the (reduced) threshold.
  // Fee receivers hold 0.01 SOL: a system account must stay rent-exempt (~0.00089 SOL) after a transfer.
  test2: { partner: 0.06, forgeCreator: 0.3, trader: 1.3, multisigStandIn: 0.01 },
  // config (partner) + pool with first buy (forgeCreator rent, client buys) + a follow-up buy
  test3: { partner: 0.06, forgeCreator: 0.06, client: 0.12, trader: 0.08 },
  // config + pool + referral account + buy & sell with platform fee
  test4: { partner: 0.06, forgeCreator: 0.06, referral: 0.01, trader: 0.2, platformFee: 0.01 },
};

export function totalBudgetLamports(budgets: Budget[]): bigint {
  let total = 0n;
  for (const b of budgets) for (const v of Object.values(b)) total += solToLamports(v ?? 0);
  return total;
}

export class FundingNeeded extends Error {
  constructor(
    public readonly funder: PublicKey,
    public readonly lamports: bigint,
  ) {
    super(`Funding needed: send ${formatSol(lamports)} of devnet SOL to ${funder.toBase58()}`);
    this.name = 'FundingNeeded';
  }
}

/** Rounds up to the next 0.1 SOL so the human has a simple number to type in the faucet. */
export function roundUpToTenth(lamports: bigint): bigint {
  const tenth = 100_000_000n;
  return ((lamports + tenth - 1n) / tenth) * tenth;
}

/**
 * Makes sure each wallet in `budget` holds at least its budget, transferring from the funder.
 * Throws `FundingNeeded` when the funder is short.
 */
export async function ensureFunded(wallets: Wallets, budget: Budget): Promise<void> {
  const entries = Object.entries(budget) as Array<[Exclude<WalletName, 'funder'>, number]>;
  const needs: Array<{ name: Exclude<WalletName, 'funder'>; required: bigint; balance: bigint }> =
    [];
  for (const [name, solAmount] of entries) {
    const required = solToLamports(solAmount);
    const balance = await getBalance(wallets[name].publicKey);
    needs.push({ name, required, balance });
  }
  const funderBalance = await getBalance(wallets.funder.publicKey);
  const transfers = needs.filter((n) => n.balance < n.required);
  const margin = FUNDER_RESERVE + BigInt(transfers.length) * 10_000n;
  const missing = missingLamports(needs, funderBalance, margin);
  if (missing > 0n) throw new FundingNeeded(wallets.funder.publicKey, roundUpToTenth(missing));
  for (const t of transfers) {
    const amount = t.required - t.balance;
    console.log(`  funding ${t.name} with ${formatSol(amount)}`);
    await transferSol(wallets.funder, wallets[t.name].publicKey, amount, `fund ${t.name}`);
  }
}

export function printFundingRequest(err: FundingNeeded): void {
  console.log('');
  console.log('==================== FUNDING NEEDED ====================');
  console.log(`Send at least ${formatSol(err.lamports)} of DEVNET SOL to the funder wallet:`);
  console.log('');
  console.log(`  ${err.funder.toBase58()}`);
  console.log('');
  console.log('Faucet: https://faucet.solana.com (devnet). Then rerun the same command.');
  console.log('========================================================');
}

/** Wraps a test main: handles FundingNeeded with exit code 2, other errors with exit code 1. */
export async function runMain(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FundingNeeded) {
      printFundingRequest(err);
      process.exit(EXIT_FUNDING_NEEDED);
    }
    console.error(err);
    process.exit(1);
  }
}
