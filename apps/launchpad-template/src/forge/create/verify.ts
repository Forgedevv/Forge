import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { PrepareLaunchResponse } from './api';
import { base64ToBytes } from './base64';

/**
 * LOCKED ZONE. Everything the browser checks on a transaction prepared by the server BEFORE the
 * user is asked to sign it. The server summary is never trusted on its own: it must match what the
 * user typed, and the transaction itself must be shaped as expected (fee payer = the user, only
 * known programs, every other signer already signed).
 */

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** Meteora Dynamic Bonding Curve (same address on devnet and mainnet). */
export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Meteora DAMM v2 (graduated pools: creator fee claims on the migrated pool). */
export const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

/** Programs a coin launch transaction may invoke. */
export const LAUNCH_PROGRAMS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  DBC_PROGRAM,
]);

/** Programs a creator fee claim transaction may invoke. */
export const CLAIM_PROGRAMS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  DBC_PROGRAM,
  DAMM_V2_PROGRAM,
]);

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export function isSigned(signature: Uint8Array): boolean {
  return signature.some((byte) => byte !== 0);
}

export function decodeTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(base64ToBytes(base64));
  } catch {
    throw new VerificationError('The prepared transaction could not be decoded.');
  }
}

export interface TransactionChecks {
  /** The connected wallet: must be the fee payer, and the only signer still missing. */
  wallet: string;
  allowedPrograms: ReadonlySet<string>;
}

/**
 * Structural checks on a transaction. Throws unless the fee payer is the wallet, only allowed
 * programs are called, and the wallet is the only signer still missing.
 */
export function checkTransactionShape(tx: VersionedTransaction, checks: TransactionChecks): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const required = tx.message.header.numRequiredSignatures;

  if (keys[0] !== checks.wallet) {
    throw new VerificationError(
      'The transaction fee payer is not your wallet. Nothing was signed.',
    );
  }

  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || !checks.allowedPrograms.has(program)) {
      throw new VerificationError(
        `The transaction calls an unexpected program (${program ?? 'unknown'}). Nothing was signed.`,
      );
    }
  }

  const missing: string[] = [];
  for (let i = 0; i < required; i++) {
    const signature = tx.signatures[i];
    if (!signature || !isSigned(signature)) missing.push(keys[i] as string);
  }
  if (missing.length !== 1 || missing[0] !== checks.wallet) {
    throw new VerificationError(
      'The transaction is not ready for your signature alone. Nothing was signed.',
    );
  }
}

/** Amounts of a verified launch summary, in lamports. */
export interface VerifiedLaunchSummary {
  coinName: string;
  coinSymbol: string;
  creatorWallet: string;
  poolCreationFeeLamports: bigint;
  firstBuyLamports: bigint;
  estimatedNetworkFeeLamports: bigint;
  accountRentLamports: bigint;
  /** Everything the wallet pays in total (fees, first buy, network fee, rent). */
  totalLamports: bigint;
}

export interface LaunchExpectations {
  wallet: string;
  name: string;
  symbol: string;
  firstBuyLamports: bigint;
  /** Fee configured for this launchpad, when known: the server must not disagree. */
  poolCreationFeeLamports?: bigint;
}

export interface VerifiedLaunch {
  tx: VersionedTransaction;
  mint: string;
  summary: VerifiedLaunchSummary;
}

/** Verifies a server `prepare` answer against the form and the transaction. Throws on mismatch. */
export function verifyPreparedLaunch(
  response: PrepareLaunchResponse,
  expected: LaunchExpectations,
): VerifiedLaunch {
  const s = response.summary;

  if (s.coinName !== expected.name || s.coinSymbol !== expected.symbol) {
    throw new VerificationError('The prepared coin does not match what you entered.');
  }
  if (s.creatorWallet !== expected.wallet) {
    throw new VerificationError('The prepared coin would not be created by your wallet.');
  }
  const firstBuy = BigInt(s.firstBuyLamports);
  if (firstBuy !== expected.firstBuyLamports) {
    throw new VerificationError('The prepared first buy does not match the amount you entered.');
  }
  const fee = BigInt(s.poolCreationFeeLamports);
  if (expected.poolCreationFeeLamports !== undefined && fee !== expected.poolCreationFeeLamports) {
    throw new VerificationError(
      'The creation fee in the prepared transaction differs from this launchpad configuration.',
    );
  }

  const tx = decodeTransaction(response.poolTx);
  checkTransactionShape(tx, { wallet: expected.wallet, allowedPrograms: LAUNCH_PROGRAMS });

  const mintKey = new PublicKey(response.mint).toBase58();
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const mintIndex = keys.indexOf(mintKey);
  if (mintIndex < 0 || mintIndex >= tx.message.header.numRequiredSignatures) {
    throw new VerificationError('The coin mint is not part of the prepared transaction.');
  }

  const network = BigInt(s.estimatedNetworkFeeLamports);
  const rent = BigInt(s.accountRentLamports);
  return {
    tx,
    mint: response.mint,
    summary: {
      coinName: s.coinName,
      coinSymbol: s.coinSymbol,
      creatorWallet: s.creatorWallet,
      poolCreationFeeLamports: fee,
      firstBuyLamports: firstBuy,
      estimatedNetworkFeeLamports: network,
      accountRentLamports: rent,
      totalLamports: fee + firstBuy + network + rent,
    },
  };
}
