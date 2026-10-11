import type { VersionedTransaction } from '@solana/web3.js';
import { signSendConfirm, TxError, type LaunchPhase, type SubmitDeps } from '../create/flow';
import { VerificationError } from '../create/verify';
import { verifyCreatorClaimTx } from './verify';
import type { ChainClient } from '../create/chain';
import type { ClaimsCore, CreatorCoin } from './core-adapter';

/**
 * LOCKED ZONE. Creator fee claim sequence, free of any UI:
 *   prepareClaim (core builds, shape verified, balance read) -> review (shown) ->
 *   executeClaim (user signs, send, poll) -> done.
 * The receiver is always the connected wallet.
 */

/** Base network fee per signature, lamports (cluster constant; priority fee excluded). */
export const BASE_FEE_PER_SIGNATURE_LAMPORTS = BigInt(5000);

export interface ClaimDeps extends SubmitDeps {
  core: ClaimsCore;
  /** Connected wallet, base58: pool creator, fee payer and receiver. */
  wallet: string;
  /** Only pools derived from these configured launchpad addresses may be claimed here. */
  launchpadConfigs: readonly string[];
}

export interface ClaimReview {
  coin: CreatorCoin;
  tx: VersionedTransaction;
  receiver: string;
  /** SOL that will be sent to the receiver. */
  claimQuoteLamports: bigint;
  claimBaseRaw: bigint;
  /** At least this much (base fee; a priority fee may add to it). */
  estimatedNetworkFeeLamports: bigint;
  balanceLamports: bigint | null;
  insufficientForFee: boolean;
}

export function estimateBaseFee(tx: VersionedTransaction): bigint {
  return BigInt(tx.message.header.numRequiredSignatures) * BASE_FEE_PER_SIGNATURE_LAMPORTS;
}

export async function loadCreatorCoins(core: ClaimsCore, wallet: string): Promise<CreatorCoin[]> {
  const coins = await core.listCreatorCoins(wallet);
  // Largest claim first, then stable by pool address.
  return [...coins].sort((a, b) =>
    a.claimableQuoteLamports === b.claimableQuoteLamports
      ? a.pool.localeCompare(b.pool)
      : a.claimableQuoteLamports > b.claimableQuoteLamports
        ? -1
        : 1,
  );
}

export async function prepareClaim(coin: CreatorCoin, deps: ClaimDeps): Promise<ClaimReview> {
  if (coin.claimableQuoteLamports <= BigInt(0) && coin.claimableBaseRaw <= BigInt(0)) {
    throw new TxError('prepare_failed', 'prepare', 'There is nothing to claim for this coin.');
  }

  let tx: VersionedTransaction;
  try {
    tx = await deps.core.buildCreatorClaimTx({
      pool: coin.pool,
      creator: deps.wallet,
      receiver: deps.wallet,
    });
  } catch (error) {
    throw new TxError(
      'prepare_failed',
      'prepare',
      `Could not build the claim: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  try {
    verifyCreatorClaimTx(tx, { wallet: deps.wallet, coin, launchpadConfigs: deps.launchpadConfigs });
  } catch (error) {
    if (error instanceof VerificationError) {
      throw new TxError('verification_failed', 'verify', error.message);
    }
    throw error;
  }

  let balanceLamports: bigint | null = null;
  try {
    balanceLamports = await deps.chain.getBalanceLamports(deps.wallet);
  } catch {
    // Convenience check only.
  }
  const fee = estimateBaseFee(tx);
  return {
    coin,
    tx,
    receiver: deps.wallet,
    claimQuoteLamports: coin.claimableQuoteLamports,
    claimBaseRaw: coin.claimableBaseRaw,
    estimatedNetworkFeeLamports: fee,
    balanceLamports,
    insufficientForFee: balanceLamports !== null && balanceLamports < fee,
  };
}

export async function executeClaim(
  review: ClaimReview,
  deps: ClaimDeps,
  onPhase?: (phase: LaunchPhase, signature?: string) => void,
): Promise<string> {
  if (review.insufficientForFee) {
    throw new TxError(
      'insufficient_balance',
      'balance',
      'Your wallet does not hold enough SOL to pay the network fee.',
    );
  }
  return signSendConfirm(review.tx, deps, onPhase);
}

export type { ChainClient };
