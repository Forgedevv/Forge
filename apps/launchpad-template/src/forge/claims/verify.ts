import type { VersionedTransaction } from '@solana/web3.js';
import { describeChainError, type SimulationResult } from '../create/chain';
import { decodeTransaction } from '../tx/decode';
import { VerificationError } from '../tx/errors';
import { networkFeeLamports } from '../tx/fees';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  DBC_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  canonicalAddress,
  dbcEventAuthority,
  dbcPoolAddress,
  dbcPoolAuthority,
  dbcVaultAddress,
} from '../tx/programs';
import {
  dbcInstructionName,
  parseComputeBudget,
  parseCreateAtaIdempotent,
  parseDbcClaimCreator,
  parseTokenIx,
} from '../tx/parse';
import type { CreatorCoin } from './core-adapter';

/**
 * LOCKED ZONE. Strict check of a creator fee claim before the wallet signs it.
 *
 * Accepted instructions only:
 * - compute budget (bounded priority fee);
 * - idempotent creation of the wallet's own coin account and wrapped SOL account (paid by the
 *   wallet);
 * - exactly one DBC `claim_creator_trading_fee` on the selected pool, which must be a pool of this
 *   launchpad's config for the selected coin, with the wallet as creator and the wallet's own token
 *   accounts as receivers;
 * - `CloseAccount` of the wallet's wrapped SOL account back to the wallet (unwrap).
 * Everything else (SOL transfers, token approvals, authority changes, other receivers, other
 * programs, other signers) is refused. The receiver is always the connected wallet.
 */

export interface ClaimExpectations {
  wallet: string;
  coin: CreatorCoin;
  /** Configs of this launchpad (`forge.config.json#onchain`); the pool must belong to one. */
  launchpadConfigs: readonly string[];
}

export interface VerifiedClaim {
  networkFeeLamports: bigint;
  /** The wallet's coin account (credited with base fees; created if missing). */
  walletCoinAccount: string;
  walletWrappedSolAccount: string;
}

function fail(message: string): never {
  throw new VerificationError(message);
}

export function verifyCreatorClaimTx(
  tx: VersionedTransaction,
  expected: ClaimExpectations,
): VerifiedClaim {
  const wallet = canonicalAddress(expected.wallet) ?? fail('Invalid wallet.');
  const pool = canonicalAddress(expected.coin.pool) ?? fail('Invalid pool.');
  const mint = canonicalAddress(expected.coin.mint) ?? fail('Invalid coin.');
  if (!expected.launchpadConfigs.some((config) => dbcPoolAddress(config, mint) === pool)) {
    fail('This coin is not part of this launchpad. Nothing was signed.');
  }

  const decoded = decodeTransaction(tx);
  if (decoded.feePayer !== wallet) {
    fail('The transaction fee payer is not your wallet. Nothing was signed.');
  }
  if (decoded.requiredSigners.length !== 1 || decoded.signed.size !== 0) {
    fail('The claim must be signed by your wallet alone. Nothing was signed.');
  }

  const wsolAta = associatedTokenAddress(wallet, WSOL_MINT, TOKEN_PROGRAM_ID);
  let coinProgram: string | null = null;
  let coinAta: string | null = null;
  let claims = 0;
  let closes = 0;
  const createdAtas: { ata: string; mint: string; tokenProgram: string }[] = [];

  for (const ix of decoded.instructions) {
    const where = `instruction #${ix.index + 1}`;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        parseComputeBudget(ix);
        break;
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        const a = parseCreateAtaIdempotent(ix);
        if (a.payer !== wallet || a.owner !== wallet || (a.mint !== mint && a.mint !== WSOL_MINT)) {
          fail(`The claim creates an unexpected token account (${where}).`);
        }
        createdAtas.push({ ata: a.ata, mint: a.mint, tokenProgram: a.tokenProgram });
        break;
      }
      case TOKEN_PROGRAM_ID: {
        const t = parseTokenIx(ix);
        if (
          t.kind !== 'closeAccount' ||
          t.account !== wsolAta ||
          t.destination !== wallet ||
          t.owner !== wallet
        ) {
          fail(`The claim moves wrapped SOL somewhere else than your wallet (${where}).`);
        }
        closes += 1;
        break;
      }
      case DBC_PROGRAM_ID: {
        if (dbcInstructionName(ix) !== 'claimCreatorTradingFee') {
          fail(`The claim calls an unexpected pool instruction (${where}).`);
        }
        const c = parseDbcClaimCreator(ix);
        if (c.tokenBaseProgram !== TOKEN_PROGRAM_ID && c.tokenBaseProgram !== TOKEN_2022_PROGRAM_ID) {
          fail('The claim uses an unknown token program.');
        }
        coinProgram = c.tokenBaseProgram;
        coinAta = associatedTokenAddress(wallet, mint, coinProgram);
        const ok =
          c.poolAuthority === dbcPoolAuthority() &&
          c.pool === pool &&
          c.tokenAAccount === coinAta &&
          c.tokenBAccount === wsolAta &&
          c.baseVault === dbcVaultAddress(pool, mint) &&
          c.quoteVault === dbcVaultAddress(pool, WSOL_MINT) &&
          c.baseMint === mint &&
          c.quoteMint === WSOL_MINT &&
          c.creator === wallet &&
          c.tokenQuoteProgram === TOKEN_PROGRAM_ID &&
          c.eventAuthority === dbcEventAuthority() &&
          c.program === DBC_PROGRAM_ID;
        if (!ok) fail('The claim does not pay your own wallet for your own coin. Nothing was signed.');
        claims += 1;
        break;
      }
      default:
        fail(`The claim calls an unexpected program (${ix.programId}). Nothing was signed.`);
    }
  }

  if (claims !== 1 || closes > 1 || coinAta === null || coinProgram === null) {
    fail('The claim transaction is not shaped as expected.');
  }
  for (const created of createdAtas) {
    const ok =
      (created.mint === WSOL_MINT &&
        created.ata === wsolAta &&
        created.tokenProgram === TOKEN_PROGRAM_ID) ||
      (created.mint === mint && created.ata === coinAta && created.tokenProgram === coinProgram);
    if (!ok) fail('The claim creates an unexpected token account.');
  }

  return {
    networkFeeLamports: networkFeeLamports(decoded),
    walletCoinAccount: coinAta,
    walletWrappedSolAccount: wsolAta,
  };
}

export interface ClaimSimulationInput {
  /** Pre-state lamports of [wallet, wallet coin account] (0 when absent). */
  preWalletLamports: bigint;
  preCoinAccountLamports: bigint;
  /** Simulation with accounts [wallet, wallet coin account]. */
  simulation: SimulationResult;
  /** SOL the review promises (claimable creator fees, lamports). */
  claimQuoteLamports: bigint;
  networkFeeLamports: bigint;
}

/**
 * The simulated claim must succeed and pay the wallet at least what the review shows: the wallet's
 * gain, plus the deposit of a coin account created for it, plus the network fee, covers the
 * claimable amount (fees only grow until the claim executes).
 */
export function verifyClaimSimulation(input: ClaimSimulationInput): void {
  const { simulation } = input;
  if (simulation.err) {
    fail(`The claim would fail on-chain: ${describeChainError(simulation.err, simulation.logs)}`);
  }
  const postWallet = simulation.accounts[0]?.lamports ?? BigInt(0);
  const postCoin = simulation.accounts[1]?.lamports ?? BigInt(0);
  const walletChange = postWallet - input.preWalletLamports;
  const newDeposit =
    postCoin > input.preCoinAccountLamports ? postCoin - input.preCoinAccountLamports : BigInt(0);
  if (walletChange + newDeposit + input.networkFeeLamports < input.claimQuoteLamports) {
    fail('The claim would pay your wallet less than shown. Refresh and try again.');
  }
}
