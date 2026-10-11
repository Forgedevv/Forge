import type { VersionedTransaction } from '@solana/web3.js';
import { signSendConfirm, TxError, type LaunchPhase, type SubmitDeps } from '../create/flow';
import { VerificationError } from '../create/verify';
import { verifyCreatorClaimTx } from './verify';
import type { ChainClient } from '../create/chain';
import type { ClaimsCore, CreatorClaimCosts, CreatorCoin } from './core-adapter';

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
  /** Rent of the wallet's coin account on a first claim (kept in that account), else 0. */
  coinAccountRentLamports: bigint;
  /** WSOL rent advanced during the transaction and refunded in it. */
  temporaryLamports: bigint;
  /** What the wallet balance decreases by: network fee + one-time rent. */
  totalCostLamports: bigint;
  /** Balance the wallet needs before signing (total + temporary). */
  requiredBalanceLamports: bigint;
  balanceLamports: bigint | null;
  /** The wallet balance is below `requiredBalanceLamports`. */
  insufficientBalance: boolean;
}

export function estimateBaseFee(tx: VersionedTransaction): bigint {
  return BigInt(tx.message.header.numRequiredSignatures) * BASE_FEE_PER_SIGNATURE_LAMPORTS;
}

export interface ClaimCostView {
  networkFeeLamports: bigint;
  coinAccountRentLamports: bigint;
  temporaryLamports: bigint;
  totalCostLamports: bigint;
  requiredBalanceLamports: bigint;
}

/**
 * Costs shown and checked for a claim: the core's figures, with the network fee raised to the
 * signature count of the transaction actually signed if the core ever reported less.
 */
export function claimCosts(tx: VersionedTransaction, costs: CreatorClaimCosts): ClaimCostView {
  const values = [
    costs.networkFeeLamports,
    costs.receiverTokenAccountRentLamports,
    costs.temporaryLamports,
    costs.payerTotalLamports,
    costs.payerRequiredBalanceLamports,
  ];
  if (values.some((value) => typeof value !== 'bigint' || value < BigInt(0))) {
    throw new VerificationError('The claim costs returned by the core are invalid.');
  }
  if (
    costs.payerTotalLamports < costs.networkFeeLamports + costs.receiverTokenAccountRentLamports ||
    costs.payerRequiredBalanceLamports < costs.payerTotalLamports + costs.temporaryLamports
  ) {
    throw new VerificationError('The claim costs returned by the core do not add up.');
  }
  const baseFee = estimateBaseFee(tx);
  const extra = baseFee > costs.networkFeeLamports ? baseFee - costs.networkFeeLamports : BigInt(0);
  return {
    networkFeeLamports: costs.networkFeeLamports + extra,
    coinAccountRentLamports: costs.receiverTokenAccountRentLamports,
    temporaryLamports: costs.temporaryLamports,
    totalCostLamports: costs.payerTotalLamports + extra,
    requiredBalanceLamports: costs.payerRequiredBalanceLamports + extra,
  };
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
  let builtCosts: CreatorClaimCosts;
  try {
    ({ tx, costs: builtCosts } = await deps.core.buildCreatorClaimTx({
      pool: coin.pool,
      creator: deps.wallet,
      receiver: deps.wallet,
    }));
  } catch (error) {
    throw new TxError(
      'prepare_failed',
      'prepare',
      `Could not build the claim: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  let costs: ClaimCostView;
  try {
    verifyCreatorClaimTx(tx, { wallet: deps.wallet, coin, launchpadConfigs: deps.launchpadConfigs });
    costs = claimCosts(tx, builtCosts);
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
  return {
    coin,
    tx,
    receiver: deps.wallet,
    claimQuoteLamports: coin.claimableQuoteLamports,
    claimBaseRaw: coin.claimableBaseRaw,
    estimatedNetworkFeeLamports: costs.networkFeeLamports,
    coinAccountRentLamports: costs.coinAccountRentLamports,
    temporaryLamports: costs.temporaryLamports,
    totalCostLamports: costs.totalCostLamports,
    requiredBalanceLamports: costs.requiredBalanceLamports,
    balanceLamports,
    insufficientBalance: balanceLamports !== null && balanceLamports < costs.requiredBalanceLamports,
  };
}

export async function executeClaim(
  review: ClaimReview,
  deps: ClaimDeps,
  onPhase?: (phase: LaunchPhase, signature?: string) => void,
): Promise<string> {
  if (review.insufficientBalance) {
    throw new TxError(
      'insufficient_balance',
      'balance',
      'Your wallet does not hold enough SOL for the network fee and account rent of this claim.',
    );
  }
  return signSendConfirm(review.tx, deps, onPhase);
}

export type { ChainClient };
