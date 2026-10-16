import type { VersionedTransaction } from '@solana/web3.js';
import { LaunchApiError, readFileAsDataUrl, type LaunchApi } from './api';
import { buildLaunchAuthMessage, randomNonce, sha256Hex } from './auth';
import { bytesToBase64 } from './base64';
import {
  confirmSignature,
  describeChainError,
  type ChainClient,
  type ConfirmOptions,
} from './chain';
import { sameBytes } from '../tx/decode';
import {
  VerificationError,
  isSigned,
  verifyLaunchSimulation,
  verifyPreparedLaunch,
  type VerifiedLaunch,
} from './verify';
import type { ValidatedCoin } from './validation';
import { launchPlatformFeeWallet } from './platform-fee';

/**
 * LOCKED ZONE. The coin creation sequence, free of any UI:
 *
 *   prepareLaunch  (wallet signs the upload request, server builds, browser decodes every
 *                   instruction and simulates)                   -> review (summary shown)
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
/** Wallet message signing (ed25519 over the raw bytes). */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface LaunchDeps {
  api: LaunchApi;
  chain: ChainClient;
  signTransaction: SignTransaction;
  /** Signs the upload authorization. Absent when the wallet cannot sign messages. */
  signMessage?: SignMessage;
  /** Connected wallet, base58. */
  wallet: string;
  /** `forge.config.json#onchain.launchpadConfig`. Creation is refused without it. */
  launchpadConfig?: string;
  /** `forge.config.json#onchain.poolCreationFeeSol` in lamports. Creation is refused without it. */
  poolCreationFeeLamports?: bigint;
  /** FORGE Meteora referral token account the first buy may carry (optional). */
  referralTokenAccount?: string | null;
  /** Site host bound into the signed message (default: `window.location.host`). */
  host?: string;
  /** Clock and nonce (tests). */
  now?: () => Date;
  nonce?: () => string;
  confirm?: ConfirmOptions;
}

export interface LaunchReview extends VerifiedLaunch {
  /** Wallet balance read before the review. */
  balanceLamports: bigint | null;
  /** True when the balance is below the total to pay (the transaction was then not simulated). */
  insufficientBalance: boolean;
}

export async function prepareLaunch(
  coin: ValidatedCoin,
  image: Blob,
  deps: LaunchDeps,
): Promise<LaunchReview> {
  if (!deps.launchpadConfig || deps.poolCreationFeeLamports === undefined) {
    // Without the on-chain configuration nothing the server returns could be checked.
    throw new TxError('prepare_failed', 'prepare', 'Coin creation is not configured on this site yet.');
  }
  // The first buy pays the FORGE platform fee to this site's (build-time) fee wallet only.
  const platformFeeWallet = launchPlatformFeeWallet();
  if (coin.firstBuyLamports > BigInt(0) && !platformFeeWallet) {
    throw new TxError(
      'prepare_failed',
      'prepare',
      'Coins with a first buy cannot be created on this site yet. Try without a first buy.',
    );
  }
  if (!deps.signMessage) {
    throw new TxError(
      'prepare_failed',
      'prepare',
      'Your wallet cannot sign messages, which is needed to authorize the coin upload.',
    );
  }

  let tokenLogo: string;
  let imageHash: string;
  let descriptionHash: string;
  try {
    tokenLogo = await readFileAsDataUrl(image);
    imageHash = await sha256Hex(new Uint8Array(await image.arrayBuffer()));
    descriptionHash = await sha256Hex(new TextEncoder().encode(coin.description));
  } catch (error) {
    throw new TxError('prepare_failed', 'prepare', messageOf(error));
  }

  // The wallet authorizes this exact upload (bound to the image, the coin and a single-use nonce).
  const nonce = (deps.nonce ?? randomNonce)();
  const issuedAt = (deps.now?.() ?? new Date()).toISOString();
  const message = buildLaunchAuthMessage({
    host: deps.host ?? (typeof window === 'undefined' ? '' : window.location.host),
    wallet: deps.wallet,
    name: coin.name,
    symbol: coin.symbol,
    firstBuyLamports: coin.firstBuyLamports.toString(),
    imageSha256: imageHash,
    descriptionSha256: descriptionHash,
    nonce,
    issuedAt,
  });
  let signature: Uint8Array;
  try {
    signature = await deps.signMessage(new TextEncoder().encode(message));
  } catch (error) {
    if (isUserRejection(error)) {
      throw new TxError('user_rejected', 'prepare', 'You declined the signature request.');
    }
    throw new TxError('prepare_failed', 'prepare', `Signing failed: ${messageOf(error)}`);
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
      auth: { nonce, issuedAt, signature: bytesToBase64(signature) },
    });
  } catch (error) {
    const text =
      error instanceof LaunchApiError ? error.message : 'Could not prepare the coin. Try again.';
    throw new TxError('prepare_failed', 'prepare', text);
  }

  let verified: VerifiedLaunch;
  try {
    verified = verifyPreparedLaunch(response, {
      wallet: deps.wallet,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: coin.firstBuyLamports,
      launchpadConfig: deps.launchpadConfig,
      poolCreationFeeLamports: deps.poolCreationFeeLamports,
      referralTokenAccount: deps.referralTokenAccount ?? null,
      platformFeeWallet,
    });
  } catch (error) {
    if (error instanceof VerificationError) {
      throw new TxError('verification_failed', 'verify', error.message);
    }
    throw error;
  }

  // Read the wallet before simulating. Without these reads the transaction cannot be checked
  // against the network, so nothing can be signed (fail closed).
  let pre;
  try {
    pre = await deps.chain.getAccounts([deps.wallet, verified.accounts.userWrappedSolAccount]);
  } catch {
    throw new TxError(
      'verification_failed',
      'verify',
      'Could not check the transaction against the network. Try again in a moment.',
    );
  }
  const balanceLamports = pre[0]?.lamports ?? BigInt(0);
  if (balanceLamports < verified.summary.totalLamports) {
    // Not enough SOL: the simulation would fail. The review says so and signing stays disabled.
    return { ...verified, balanceLamports, insufficientBalance: true };
  }

  let simulation;
  try {
    simulation = await deps.chain.simulateTransaction(bytesToBase64(verified.tx.serialize()), [
      deps.wallet,
      verified.accounts.userCoinAccount,
    ]);
  } catch {
    throw new TxError(
      'verification_failed',
      'verify',
      'Could not simulate the transaction. Try again in a moment.',
    );
  }
  try {
    verifyLaunchSimulation(verified, {
      preWalletLamports: balanceLamports,
      preWrappedSolLamports: pre[1]?.lamports ?? BigInt(0),
      simulation,
    });
  } catch (error) {
    if (error instanceof VerificationError) {
      throw new TxError('verification_failed', 'verify', error.message);
    }
    throw error;
  }

  return { ...verified, balanceLamports, insufficientBalance: false };
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

export interface SubmitOptions {
  /** The message that was verified and shown: the wallet must sign exactly this. */
  expectedMessage?: Uint8Array;
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
  options: SubmitOptions = {},
): Promise<string> {
  const expectedMessage = options.expectedMessage ?? Uint8Array.from(tx.message.serialize());
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

  // The wallet must have signed the very message that was verified and shown.
  if (!sameBytes(Uint8Array.from(signed.message.serialize()), expectedMessage)) {
    throw new TxError(
      'sign_failed',
      'sign',
      'The wallet returned a different transaction than the one you reviewed. Nothing was sent.',
    );
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
  const signature = await signSendConfirm(review.tx, deps, onPhase, {
    expectedMessage: review.messageBytes,
  });
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
