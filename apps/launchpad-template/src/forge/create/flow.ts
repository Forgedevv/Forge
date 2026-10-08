import type { VersionedTransaction } from '@solana/web3.js';
import { LaunchApiError, readFileAsDataUrl, type LaunchApi } from './api';
import { bytesToBase64 } from './base64';
import {
  confirmSignature,
  describeChainError,
  type ChainClient,
  type ConfirmOptions,
} from './chain';
import { VerificationError, isSigned, verifyPreparedLaunch, type VerifiedLaunch } from './verify';
import type { ValidatedCoin } from './validation';

/**
 * LOCKED ZONE. The coin creation sequence, free of any UI:
 *
 *   prepareLaunch  (upload + build on the server, then verify)   -> review (summary shown)
 *   executeLaunch  (user signs, send, poll for confirmation)     -> success
 *
 * Signing is never attempted before `prepareLaunch` returned a verified review that the UI showed.
 * `executeLaunch` sends a given signed transaction once; if confirmation times out the caller
 * keeps the signature and calls `checkLaunch`, it never rebuilds or resends.
 */

export type LaunchStage = 'balance' | 'prepare' | 'verify' | 'sign' | 'send' | 'confirm';

export type TxErrorCode =
  | 'insufficient_balance'
  | 'prepare_failed'
  | 'verification_failed'
  | 'user_rejected'
  | 'sign_failed'
  | 'send_failed'
  | 'onchain_failed'
  | 'expired'
  | 'timeout';

export class TxError extends Error {
  constructor(
    readonly code: TxErrorCode,
    readonly stage: LaunchStage,
    message: string,
    /** Present once a transaction was sent: it may still land. */
    readonly signature?: string,
  ) {
    super(message);
    this.name = 'TxError';
  }
}

export type SignTransaction = <T extends VersionedTransaction>(tx: T) => Promise<T>;

export interface LaunchDeps {
  api: LaunchApi;
  chain: ChainClient;
  signTransaction: SignTransaction;
  /** Connected wallet, base58. */
  wallet: string;
  /** Creation fee of this launchpad, when present in forge.config.json. */
  poolCreationFeeLamports?: bigint;
  confirm?: ConfirmOptions;
}

export interface LaunchReview extends VerifiedLaunch {
  /** Wallet balance read before the review; null when the relay could not be reached. */
  balanceLamports: bigint | null;
  /** True when the balance is known and below the total to pay. */
  insufficientBalance: boolean;
}

export async function prepareLaunch(
  coin: ValidatedCoin,
  image: Blob,
  deps: LaunchDeps,
): Promise<LaunchReview> {
  let tokenLogo: string;
  try {
    tokenLogo = await readFileAsDataUrl(image);
  } catch (error) {
    throw new TxError('prepare_failed', 'prepare', messageOf(error));
  }

  let response;
  try {
    response = await deps.api.prepare({
      tokenName: coin.name,
      tokenSymbol: coin.symbol,
      description: coin.description,
      tokenLogo,
      userWallet: deps.wallet,
      firstBuyLamports: coin.firstBuyLamports.toString(),
    });
  } catch (error) {
    const message =
      error instanceof LaunchApiError ? error.message : 'Could not prepare the coin. Try again.';
    throw new TxError('prepare_failed', 'prepare', message);
  }

  let verified: VerifiedLaunch;
  try {
    verified = verifyPreparedLaunch(response, {
      wallet: deps.wallet,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: coin.firstBuyLamports,
      poolCreationFeeLamports: deps.poolCreationFeeLamports,
    });
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
    // The balance check is a convenience: the wallet and the cluster remain the authority.
  }

  return {
    ...verified,
    balanceLamports,
    insufficientBalance:
      balanceLamports !== null && balanceLamports < verified.summary.totalLamports,
  };
}

export type LaunchPhase = 'signing' | 'sending' | 'confirming';

export interface LaunchResult {
  signature: string;
  mint: string;
}

function isUserRejection(error: unknown): boolean {
  const text = `${(error as { name?: string })?.name ?? ''} ${(error as { message?: string })?.message ?? ''}`;
  return /reject|denied|declin|cancel/i.test(text);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

export interface SubmitDeps {
  chain: ChainClient;
  signTransaction: SignTransaction;
  confirm?: ConfirmOptions;
}

/**
 * Shared by the launch and the fee claim: the wallet signs, every required signature is checked,
 * the transaction is sent once through the relay, then polled until confirmed. Resolves with the
 * signature; throws a `TxError` (carrying the signature once the transaction was sent).
 */
export async function signSendConfirm(
  tx: VersionedTransaction,
  deps: SubmitDeps,
  onPhase?: (phase: LaunchPhase, signature?: string) => void,
): Promise<string> {
  onPhase?.('signing');
  let signed: VersionedTransaction;
  try {
    signed = await deps.signTransaction(tx);
  } catch (error) {
    if (isUserRejection(error)) {
      throw new TxError('user_rejected', 'sign', 'You declined the signature request.');
    }
    throw new TxError('sign_failed', 'sign', `Signing failed: ${messageOf(error)}`);
  }

  // Every required signature must be present before sending (wallet and any pre-signed signer).
  const required = signed.message.header.numRequiredSignatures;
  if (
    signed.signatures.length < required ||
    signed.signatures.slice(0, required).some((s) => !isSigned(s))
  ) {
    throw new TxError('sign_failed', 'sign', 'The signed transaction is incomplete.');
  }

  onPhase?.('sending');
  let signature: string;
  try {
    signature = await deps.chain.sendRawTransaction(bytesToBase64(signed.serialize()));
  } catch (error) {
    throw new TxError(
      'send_failed',
      'send',
      `The network rejected the transaction: ${messageOf(error)}`,
    );
  }

  onPhase?.('confirming', signature);
  await waitForSignature(signature, deps);
  return signature;
}

export async function executeLaunch(
  review: LaunchReview,
  deps: LaunchDeps,
  onPhase?: (phase: LaunchPhase, signature?: string) => void,
): Promise<LaunchResult> {
  if (review.insufficientBalance) {
    throw new TxError(
      'insufficient_balance',
      'balance',
      'Your wallet does not hold enough SOL for this launch.',
    );
  }
  const signature = await signSendConfirm(review.tx, deps, onPhase);
  return { signature, mint: review.mint };
}

/** Polls a sent transaction until confirmed. Throws `TxError` on failure or timeout. */
export async function waitForSignature(
  signature: string,
  deps: Pick<SubmitDeps, 'chain' | 'confirm'>,
): Promise<void> {
  const outcome = await confirmSignature(deps.chain, signature, deps.confirm);
  if (outcome.kind === 'confirmed') return;
  if (outcome.kind === 'failed') {
    throw new TxError(
      'onchain_failed',
      'confirm',
      `The transaction failed on-chain: ${describeChainError(outcome.err)}`,
      signature,
    );
  }
  if (outcome.kind === 'expired') {
    throw new TxError(
      'expired',
      'confirm',
      'The transaction expired before it was confirmed and was not executed. You can safely try again.',
      signature,
    );
  }
  throw new TxError(
    'timeout',
    'confirm',
    'The transaction was sent but is not confirmed yet. It may still land: check again before retrying.',
    signature,
  );
}

/** Polls an already sent launch transaction ("check again" after a timeout). */
export async function waitForLaunch(
  mint: string,
  signature: string,
  deps: Pick<LaunchDeps, 'chain' | 'confirm'>,
): Promise<LaunchResult> {
  await waitForSignature(signature, deps);
  return { signature, mint };
}
