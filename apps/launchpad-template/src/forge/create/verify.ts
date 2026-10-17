import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { firstBuyPlatformFee } from './platform-fee';
import type { PrepareLaunchResponse } from './api';
import { base64ToBytes } from './base64';
import { describeChainError, type SimulationResult } from './chain';
import { decodeTransaction as decodeTx, type DecodedTransaction } from '../tx/decode';
import { VerificationError } from '../tx/errors';
import { networkFeeLamports } from '../tx/fees';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  DBC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  canonicalAddress,
  dbcEventAuthority,
  dbcPoolAddress,
  dbcPoolAuthority,
  dbcVaultAddress,
  metadataAddress,
} from '../tx/programs';
import {
  dbcInstructionName,
  parseComputeBudget,
  parseCreateAtaIdempotent,
  parseDbcInitializeSpl,
  parseDbcSwap,
  parseSystemTransfer,
  parseTokenIx,
} from '../tx/parse';

/**
 * LOCKED ZONE. Everything the browser checks on a coin launch prepared by the server BEFORE the
 * user is asked to sign it. The server is never trusted:
 *
 * 1. the summary must match what the user typed and this launchpad's configuration
 *    (`forge.config.json#onchain`: config address and creation fee);
 * 2. EVERY instruction is decoded against a strict allowlist (`verifyPreparedLaunch`):
 *    - compute budget (bounded priority fee);
 *    - DBC `initialize_virtual_pool_with_spl_token` on this launchpad's config, for the new mint,
 *      with the user as creator and payer, and the name and symbol the user typed;
 *    - when there is a first buy: idempotent creation of the user's wrapped SOL and coin accounts,
 *      one SOL transfer of exactly the first buy into the user's own wrapped SOL account,
 *      `SyncNative`, one DBC `swap` of exactly the first buy into the user's coin account (minimum
 *      out as summarized), `CloseAccount` of the wrapped SOL account back to the user, and, as
 *      the LAST instruction, one SOL transfer of exactly the FORGE platform fee (0.3% of the first
 *      buy, rounded up, computed here by @forge/core) to `FORGE_PLATFORM_FEE_WALLET` (read from
 *      this site's build-time environment, never from the server).
 *    Anything else (token approvals, authority changes, token transfers, transfers to any other
 *    account or of any other amount, account creation, other programs, lookup tables) is refused;
 * 3. the transaction is simulated with the user's accounts (`verifyLaunchSimulation`): it must
 *    succeed, the wallet must lose what the summary shows (only the network fee may differ) and
 *    the user's coin account must receive at least the summarized minimum.
 */

export { VerificationError };

export function isSigned(signature: Uint8Array): boolean {
  return signature.some((byte) => byte !== 0);
}

/** Decodes a base64 transaction. */
export function decodeBase64Transaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(base64ToBytes(base64));
  } catch {
    throw new VerificationError('The prepared transaction could not be decoded.');
  }
}

/** Largest slippage the server may apply to the first buy (same bound as @forge/core). */
export const MAX_FIRST_BUY_SLIPPAGE_BPS = 1000;
/** Metaplex limit on the metadata URI, in bytes. */
const MAX_URI_BYTES = 200;

/** Amounts of a verified launch summary, in lamports (token amounts in raw units). */
export interface VerifiedLaunchSummary {
  coinName: string;
  coinSymbol: string;
  creatorWallet: string;
  poolCreationFeeLamports: bigint;
  firstBuyLamports: bigint;
  firstBuyExpectedTokensOut: bigint;
  firstBuyMinimumTokensOut: bigint;
  /** FORGE platform fee on the first buy (0.3%, rounded up), computed here, not by the server. */
  platformFeeLamports: bigint;
  /** Computed from the transaction (signatures and priority fee), not taken from the server. */
  estimatedNetworkFeeLamports: bigint;
  accountRentLamports: bigint;
  metadataFeeLamports: bigint;
  /** Everything the wallet pays in total (fees, first buy, platform fee, network fee, rent). */
  totalLamports: bigint;
}

export interface LaunchExpectations {
  wallet: string;
  name: string;
  symbol: string;
  firstBuyLamports: bigint;
  /** `forge.config.json#onchain.launchpadConfig`: the only config coins may be created on. */
  launchpadConfig: string;
  /** `forge.config.json#onchain.poolCreationFeeSol`, in lamports. */
  poolCreationFeeLamports: bigint;
  /** FORGE Meteora referral token account, if the first buy may carry it. */
  referralTokenAccount?: string | null;
  /**
   * FORGE_PLATFORM_FEE_WALLET from this site's environment (`launchPlatformFeeWallet()`): the only
   * account the platform fee of a first buy may go to. Without it, a launch with a first buy is
   * refused.
   */
  platformFeeWallet?: string | null;
}

/** Addresses derived while verifying, needed to read the simulation. */
export interface LaunchAccounts {
  pool: string;
  userWrappedSolAccount: string;
  userCoinAccount: string;
}

export interface VerifiedLaunch {
  tx: VersionedTransaction;
  mint: string;
  summary: VerifiedLaunchSummary;
  accounts: LaunchAccounts;
  /** Serialized message the user is about to sign (compared again after signing). */
  messageBytes: Uint8Array;
}

function lamports(value: string): bigint {
  return BigInt(value);
}

function fail(message: string): never {
  throw new VerificationError(message);
}

function isHttpsUri(uri: string): boolean {
  if (new TextEncoder().encode(uri).length > MAX_URI_BYTES) return false;
  try {
    return new URL(uri).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Verifies a server `prepare` answer against the form, the config and the transaction. */
export function verifyPreparedLaunch(
  response: PrepareLaunchResponse,
  expected: LaunchExpectations,
): VerifiedLaunch {
  const s = response.summary;
  const wallet = canonicalAddress(expected.wallet) ?? fail('Invalid wallet.');
  const config = canonicalAddress(expected.launchpadConfig) ?? fail('Invalid launchpad config.');

  // 1. Summary against the form and the launchpad configuration.
  if (s.coinName !== expected.name || s.coinSymbol !== expected.symbol) {
    fail('The prepared coin does not match what you entered.');
  }
  if (s.creatorWallet !== wallet) {
    fail('The prepared coin would not be created by your wallet.');
  }
  const firstBuy = lamports(s.firstBuyLamports);
  if (firstBuy !== expected.firstBuyLamports) {
    fail('The prepared first buy does not match the amount you entered.');
  }
  const creationFee = lamports(s.poolCreationFeeLamports);
  if (creationFee !== expected.poolCreationFeeLamports) {
    fail('The creation fee in the prepared transaction differs from this launchpad configuration.');
  }
  const expectedTokens = lamports(s.firstBuyExpectedTokensOut);
  const minimumTokens = lamports(s.firstBuyMinimumTokensOut);
  if (firstBuy === BigInt(0)) {
    if (expectedTokens !== BigInt(0) || minimumTokens !== BigInt(0)) {
      fail('The prepared coin announces a first buy you did not ask for.');
    }
  } else {
    const floor =
      (expectedTokens * BigInt(10_000 - MAX_FIRST_BUY_SLIPPAGE_BPS)) / BigInt(10_000);
    if (minimumTokens <= BigInt(0) || minimumTokens > expectedTokens || minimumTokens < floor) {
      fail('The minimum amount of coins for your first buy is not consistent with the quote.');
    }
  }

  // The platform fee is computed here (by @forge/core), never taken from the server.
  const platformFee = firstBuyPlatformFee(firstBuy);
  if (lamports(s.platformFeeLamports) !== platformFee) {
    fail('The FORGE platform fee in the prepared coin is not 0.3% of your first buy.');
  }
  const platformFeeWallet =
    platformFee > BigInt(0)
      ? (canonicalAddress(expected.platformFeeWallet ?? undefined) ??
        fail('Coins with a first buy cannot be created on this site yet (platform fee not configured).'))
      : null;

  const mint = canonicalAddress(response.mint) ?? fail('The prepared coin mint is invalid.');
  if (mint === wallet) fail('The prepared coin mint is invalid.');

  // 2. Transaction shape and signers.
  const tx = decodeBase64Transaction(response.poolTx);
  const decoded = decodeTx(tx);
  if (decoded.feePayer !== wallet) {
    fail('The transaction fee payer is not your wallet. Nothing was signed.');
  }
  if (
    decoded.requiredSigners.length !== 2 ||
    decoded.requiredSigners[1] !== mint ||
    decoded.signed.size !== 1 ||
    !decoded.signed.has(mint)
  ) {
    fail('The transaction is not ready for your signature alone. Nothing was signed.');
  }

  // 3. Every instruction.
  const accounts = checkLaunchInstructions(decoded, {
    wallet,
    config,
    mint,
    name: expected.name,
    symbol: expected.symbol,
    firstBuy,
    minimumTokens,
    referral: expected.referralTokenAccount ?? null,
    platformFee,
    platformFeeWallet,
  });

  // 4. Amounts. The network fee shown is the one computed from the transaction.
  const network = networkFeeLamports(decoded);
  if (lamports(s.estimatedNetworkFeeLamports) !== network) {
    fail('The network fee announced by the server does not match the transaction.');
  }
  const rent = lamports(s.accountRentLamports);
  const metadataFee = lamports(s.metadataFeeLamports);

  return {
    tx,
    mint,
    accounts,
    messageBytes: decoded.messageBytes,
    summary: {
      coinName: s.coinName,
      coinSymbol: s.coinSymbol,
      creatorWallet: s.creatorWallet,
      poolCreationFeeLamports: creationFee,
      firstBuyLamports: firstBuy,
      firstBuyExpectedTokensOut: expectedTokens,
      firstBuyMinimumTokensOut: minimumTokens,
      platformFeeLamports: platformFee,
      estimatedNetworkFeeLamports: network,
      accountRentLamports: rent,
      metadataFeeLamports: metadataFee,
      totalLamports: creationFee + firstBuy + platformFee + network + rent + metadataFee,
    },
  };
}

interface LaunchCheck {
  wallet: string;
  config: string;
  mint: string;
  name: string;
  symbol: string;
  firstBuy: bigint;
  minimumTokens: bigint;
  referral: string | null;
  /** Platform fee of the first buy (0 without one). */
  platformFee: bigint;
  /** FORGE_PLATFORM_FEE_WALLET; non-null whenever `platformFee` is positive. */
  platformFeeWallet: string | null;
}

function checkLaunchInstructions(decoded: DecodedTransaction, c: LaunchCheck): LaunchAccounts {
  const pool = dbcPoolAddress(c.config, c.mint);
  const baseVault = dbcVaultAddress(pool, c.mint);
  const quoteVault = dbcVaultAddress(pool, WSOL_MINT);
  const wsolAta = associatedTokenAddress(c.wallet, WSOL_MINT, TOKEN_PROGRAM_ID);
  const coinAta = associatedTokenAddress(c.wallet, c.mint, TOKEN_PROGRAM_ID);
  const hasBuy = c.firstBuy > BigInt(0);
  const feeWallet = c.platformFee > BigInt(0) ? c.platformFeeWallet : null;
  if (
    feeWallet !== null &&
    [c.wallet, c.mint, c.config, pool, wsolAta, coinAta, baseVault, quoteVault].includes(feeWallet)
  ) {
    fail('The platform fee wallet of this site is invalid. Nothing was signed.');
  }
  const counts = {
    init: 0,
    swap: 0,
    wrap: 0,
    sync: 0,
    close: 0,
    wsolAta: 0,
    coinAta: 0,
    platformFee: 0,
  };
  let initIndex = -1;
  let swapIndex = -1;
  let platformFeeIndex = -1;

  for (const ix of decoded.instructions) {
    const where = `instruction #${ix.index + 1}`;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        parseComputeBudget(ix);
        break;
      case SYSTEM_PROGRAM_ID: {
        const t = parseSystemTransfer(ix);
        if (hasBuy && t.from === c.wallet && t.to === wsolAta && t.lamports === c.firstBuy) {
          counts.wrap += 1;
        } else if (
          feeWallet !== null &&
          t.from === c.wallet &&
          t.to === feeWallet &&
          t.lamports === c.platformFee
        ) {
          counts.platformFee += 1;
          platformFeeIndex = ix.index;
        } else {
          fail(`The transaction moves SOL to an unexpected account (${where}). Nothing was signed.`);
        }
        break;
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        const a = parseCreateAtaIdempotent(ix);
        if (!hasBuy || a.payer !== c.wallet || a.owner !== c.wallet) {
          fail(`The transaction creates an unexpected token account (${where}).`);
        }
        if (a.mint === WSOL_MINT && a.ata === wsolAta && a.tokenProgram === TOKEN_PROGRAM_ID) {
          counts.wsolAta += 1;
        } else if (a.mint === c.mint && a.ata === coinAta && a.tokenProgram === TOKEN_PROGRAM_ID) {
          counts.coinAta += 1;
        } else {
          fail(`The transaction creates an unexpected token account (${where}).`);
        }
        break;
      }
      case TOKEN_PROGRAM_ID: {
        const t = parseTokenIx(ix);
        if (!hasBuy || t.account !== wsolAta) {
          fail(`The transaction touches an unexpected token account (${where}).`);
        }
        if (t.kind === 'syncNative') counts.sync += 1;
        else if (t.destination === c.wallet && t.owner === c.wallet) counts.close += 1;
        else fail(`The transaction sends wrapped SOL to another account (${where}).`);
        break;
      }
      case DBC_PROGRAM_ID: {
        const name = dbcInstructionName(ix);
        if (name === 'initializeVirtualPoolWithSplToken') {
          const p = parseDbcInitializeSpl(ix);
          const ok =
            p.config === c.config &&
            p.poolAuthority === dbcPoolAuthority() &&
            p.creator === c.wallet &&
            p.baseMint === c.mint &&
            p.quoteMint === WSOL_MINT &&
            p.pool === pool &&
            p.baseVault === baseVault &&
            p.quoteVault === quoteVault &&
            p.mintMetadata === metadataAddress(c.mint) &&
            p.metadataProgram === TOKEN_METADATA_PROGRAM_ID &&
            p.payer === c.wallet &&
            p.tokenQuoteProgram === TOKEN_PROGRAM_ID &&
            p.tokenProgram === TOKEN_PROGRAM_ID &&
            p.systemProgram === SYSTEM_PROGRAM_ID &&
            p.eventAuthority === dbcEventAuthority() &&
            p.program === DBC_PROGRAM_ID;
          if (!ok) {
            fail('The pool creation does not use this launchpad, your wallet or the new coin.');
          }
          if (p.name !== c.name || p.symbol !== c.symbol) {
            fail('The coin name or symbol in the transaction differs from what you entered.');
          }
          if (!isHttpsUri(p.uri)) fail('The coin metadata link is invalid.');
          counts.init += 1;
          initIndex = ix.index;
        } else if (name === 'swap') {
          const p = parseDbcSwap(ix);
          const referralOk =
            p.referralTokenAccount === DBC_PROGRAM_ID ||
            (c.referral !== null && p.referralTokenAccount === c.referral);
          const remainingOk =
            p.remaining.length === 0 ||
            (p.remaining.length === 1 && p.remaining[0] === SYSVAR_INSTRUCTIONS_ID);
          const ok =
            hasBuy &&
            p.poolAuthority === dbcPoolAuthority() &&
            p.config === c.config &&
            p.pool === pool &&
            p.inputTokenAccount === wsolAta &&
            p.outputTokenAccount === coinAta &&
            p.baseVault === baseVault &&
            p.quoteVault === quoteVault &&
            p.baseMint === c.mint &&
            p.quoteMint === WSOL_MINT &&
            p.payer === c.wallet &&
            p.tokenBaseProgram === TOKEN_PROGRAM_ID &&
            p.tokenQuoteProgram === TOKEN_PROGRAM_ID &&
            referralOk &&
            p.eventAuthority === dbcEventAuthority() &&
            p.program === DBC_PROGRAM_ID &&
            remainingOk;
          if (!ok) fail('The first buy does not go from your wallet to your coin account.');
          if (p.amountIn !== c.firstBuy) {
            fail('The first buy in the transaction differs from the amount you entered.');
          }
          if (p.minimumAmountOut !== c.minimumTokens) {
            fail('The minimum amount of coins in the transaction differs from the summary.');
          }
          counts.swap += 1;
          swapIndex = ix.index;
        } else {
          fail(`The transaction calls an unexpected pool instruction (${where}).`);
        }
        break;
      }
      default:
        fail(`The transaction calls an unexpected program (${ix.programId}). Nothing was signed.`);
    }
  }

  if (counts.init !== 1) fail('The transaction does not create exactly one pool.');
  if (hasBuy) {
    const ok =
      counts.swap === 1 &&
      counts.wrap === 1 &&
      counts.sync === 1 &&
      counts.close === 1 &&
      counts.wsolAta <= 1 &&
      counts.coinAta <= 1 &&
      initIndex < swapIndex;
    if (!ok) fail('The first buy in the transaction is not shaped as expected.');
  } else if (counts.swap !== 0) {
    fail('The transaction contains a first buy you did not ask for.');
  }
  // Exactly one platform fee transfer, the last instruction, whenever the first buy owes one.
  const expectedFeeTransfers = feeWallet !== null ? 1 : 0;
  if (
    counts.platformFee !== expectedFeeTransfers ||
    (expectedFeeTransfers === 1 &&
      platformFeeIndex !== decoded.instructions[decoded.instructions.length - 1]?.index)
  ) {
    fail('The FORGE platform fee in the transaction is not shaped as expected.');
  }
  return { pool, userWrappedSolAccount: wsolAta, userCoinAccount: coinAta };
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

/** SPL token account layout: mint (0..32), owner (32..64), amount (u64 at 64). */
export function readTokenAccount(
  data: Uint8Array,
): { mint: string; owner: string; amount: bigint } | null {
  if (data.length < 72) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: view.getBigUint64(64, true),
  };
}

export interface LaunchSimulationInput {
  /** Wallet lamports read just before the simulation. */
  preWalletLamports: bigint;
  /** Lamports of the user's wrapped SOL account before (0 if absent): refunded by the close. */
  preWrappedSolLamports: bigint;
  /** Simulation of the prepared transaction with accounts [wallet, user coin account]. */
  simulation: SimulationResult;
}

/**
 * Checks the simulated execution against the verified summary. The wallet may only differ from
 * the shown total by the network fee (a simulation may or may not charge it).
 */
export function verifyLaunchSimulation(launch: VerifiedLaunch, input: LaunchSimulationInput): void {
  const { simulation } = input;
  if (simulation.err) {
    fail(`The launch would fail on-chain: ${describeChainError(simulation.err, simulation.logs)}`);
  }
  const s = launch.summary;
  const postWallet = simulation.accounts[0]?.lamports ?? BigInt(0);
  const spent = input.preWalletLamports - postWallet;
  const refund = s.firstBuyLamports > BigInt(0) ? input.preWrappedSolLamports : BigInt(0);
  const highest = s.totalLamports - refund;
  const lowest = highest - s.estimatedNetworkFeeLamports;
  if (spent > highest) {
    fail('The transaction would take more SOL from your wallet than the summary shows.');
  }
  if (spent < lowest) {
    fail('The cost summary does not match what the transaction does.');
  }

  const coin = simulation.accounts[1];
  if (s.firstBuyLamports > BigInt(0)) {
    const token = coin && coin.owner === TOKEN_PROGRAM_ID ? readTokenAccount(coin.data) : null;
    if (
      !token ||
      token.mint !== launch.mint ||
      token.owner !== s.creatorWallet ||
      token.amount < s.firstBuyMinimumTokensOut
    ) {
      fail('Your first buy would not deliver the coins shown in the summary.');
    }
  }
}
