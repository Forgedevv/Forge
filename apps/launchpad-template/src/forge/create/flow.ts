import type { VersionedTransaction } from '@solana/web3.js';
import {
  LaunchApiError,
  readFileAsDataUrl,
  type LaunchApi,
  type PrepareLaunchResponse,
} from './api';
import { buildLaunchAuthMessage, randomNonce, sha256Hex } from './auth';
import { bytesToBase64 } from './base64';
import {
  BLOCKHASH_LIFETIME_BLOCKS,
  EXPIRY_MARGIN_BLOCKS,
  confirmSignature,
  describeChainError,
  type ChainClient,
  type ConfirmOptions,
} from './chain';
import { WALLET_ERROR_TEXT, describeSendFailure, isUserRejection } from './errors';
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
 *   rebuildLaunch  (same mint, image and metadata; fresh blockhash or another first buy; verified
 *                   and simulated again)                         -> review (summary shown)
 *   executeLaunch  (user signs, send, poll for confirmation)     -> success
 *
 * Signing is never attempted before a verified review was shown. `executeLaunch` sends a given
 * signed transaction once; if confirmation times out the caller keeps the signature and calls
 * `waitForLaunch`, it never rebuilds or resends. A rebuild is only offered when the previous
 * transaction can no longer land (never signed, expired, or failed on-chain): it reuses the same
 * mint, so two launches of the same coin can never both succeed.
 *
 * Every message carried by a `TxError` is a human sentence (`errors.ts`); the raw wallet, RPC or
 * program error stays in `cause`.
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
  | 'timeout'
  /** The server no longer holds the prepared launch: a full `prepareLaunch` is needed. */
  | 'prepare_again'
  /** The coin of this mint already exists on-chain. */
  | 'already_launched';

export class TxError extends Error {
  constructor(
    readonly code: TxErrorCode,
    readonly stage: LaunchStage,
    message: string,
    /** Present once a transaction was sent: it may still land. */
    readonly signature?: string,
    /** Raw error (wallet, RPC, program) kept for diagnostics; never shown as is. */
    options?: { cause?: unknown; expiryHeight?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TxError';
    this.expiryHeight = options?.expiryHeight;
  }

  /** Block height after which a sent transaction can no longer land (when it was measured). */
  readonly expiryHeight?: number;
}

/**
 * The text to show for any thrown value: a `TxError` carries a human sentence; anything else
 * (wallet adapter, RPC, unexpected) gets the caller's calm fallback instead of its raw text.
 */
export function messageForUser(error: unknown, fallback: string): string {
  return error instanceof TxError ? error.message : fallback;
}

/** A prepared transaction older than this is rebuilt before signing (its blockhash lives ~60 s). */
export const REVIEW_FRESH_MS = 20_000;
/** Beyond this age, a transaction that cannot be rebuilt is not offered for signing any more. */
export const REVIEW_MAX_AGE_MS = 45_000;

/** Progress of `prepareLaunch`, for the stepper. */
export type PrepareStep = 'sign' | 'upload' | 'check';

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
  /** The coin the review was prepared for (as validated, first buy included). */
  coin: ValidatedCoin;
  /** When the transaction was received (epoch ms, `deps.now` clock): it expires with its blockhash. */
  preparedAt: number;
  /** Capability to rebuild this launch without a new upload, when the server handed one out. */
  rebuildToken: string | null;
}

function nowMs(deps: Pick<LaunchDeps, 'now'>): number {
  return (deps.now?.() ?? new Date()).getTime();
}

function notConfigured(): TxError {
  // Without the on-chain configuration nothing the server returns could be checked.
  return new TxError('prepare_failed', 'prepare', 'Coin creation is not configured on this site yet.');
}

function firstBuyUnavailable(): TxError {
  return new TxError(
    'prepare_failed',
    'prepare',
    'Coins with a first buy cannot be created on this site yet. Try without a first buy.',
  );
}

export async function prepareLaunch(
  coin: ValidatedCoin,
  image: Blob,
  deps: LaunchDeps,
  onStep?: (step: PrepareStep) => void,
): Promise<LaunchReview> {
  if (!deps.launchpadConfig || deps.poolCreationFeeLamports === undefined) throw notConfigured();
  // The first buy pays the FORGE platform fee to this site's (build-time) fee wallet only.
  const platformFeeWallet = launchPlatformFeeWallet();
  if (coin.firstBuyLamports > BigInt(0) && !platformFeeWallet) throw firstBuyUnavailable();
  if (!deps.signMessage) {
    throw new TxError(
      'prepare_failed',
      'prepare',
      'Your wallet cannot sign messages, which is needed to authorize the coin upload. Connect a wallet that supports it, such as Phantom or Solflare.',
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
    throw new TxError(
      'prepare_failed',
      'prepare',
      'Could not read the selected image. Pick it again and retry.',
      undefined,
      { cause: error },
    );
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
  onStep?.('sign');
  let signature: Uint8Array;
  try {
    signature = await deps.signMessage(new TextEncoder().encode(message));
  } catch (error) {
    if (isUserRejection(error)) {
      throw new TxError('user_rejected', 'prepare', WALLET_ERROR_TEXT.rejected, undefined, {
        cause: error,
      });
    }
    throw new TxError('prepare_failed', 'prepare', WALLET_ERROR_TEXT.messageFailed, undefined, {
      cause: error,
    });
  }

  onStep?.('upload');
  let response: PrepareLaunchResponse;
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
    throw apiFailure(error);
  }

  onStep?.('check');
  return checkPrepared(response, coin, deps, platformFeeWallet);
}

function apiFailure(error: unknown): TxError {
  if (error instanceof LaunchApiError) {
    const code: TxErrorCode =
      error.code === 'prepare_again'
        ? 'prepare_again'
        : error.code === 'already_launched'
          ? 'already_launched'
          : 'prepare_failed';
    return new TxError(code, 'prepare', error.message, undefined, { cause: error });
  }
  return new TxError(
    'prepare_failed',
    'prepare',
    'Could not prepare the coin. Try again.',
    undefined,
    { cause: error },
  );
}

/** True when this review can be rebuilt by the server without a new upload. */
export function canRebuild(review: LaunchReview, deps: Pick<LaunchDeps, 'api'>): boolean {
  return Boolean(review.rebuildToken && deps.api.rebuild);
}

/** Age of the prepared transaction, in ms. */
export function reviewAge(review: LaunchReview, deps: Pick<LaunchDeps, 'now'> = {}): number {
  return nowMs(deps) - review.preparedAt;
}

/** True when the rebuilt launch costs more than the one the user reviewed. */
export function costRose(previous: LaunchReview, next: LaunchReview): boolean {
  return next.summary.totalLamports > previous.summary.totalLamports;
}

/**
 * Rebuilds a reviewed launch on the server (same mint, image and metadata; fresh blockhash; the
 * given first buy) and checks the new transaction exactly like a first preparation. Only call it
 * when the previous transaction can no longer land (never signed, expired or failed on-chain).
 *
 * @throws TxError `prepare_again` when the server no longer holds the launch (the caller then
 *   runs a full `prepareLaunch`), or any error `prepareLaunch` can throw after the upload.
 */
export async function rebuildLaunch(
  review: LaunchReview,
  firstBuyLamports: bigint,
  deps: LaunchDeps,
): Promise<LaunchReview> {
  if (!deps.launchpadConfig || deps.poolCreationFeeLamports === undefined) throw notConfigured();
  if (!review.rebuildToken || !deps.api.rebuild) {
    throw new TxError('prepare_again', 'prepare', 'This launch must be prepared again.');
  }
  if (review.summary.creatorWallet !== deps.wallet) {
    throw new TxError('prepare_again', 'prepare', 'The wallet changed: prepare the launch again.');
  }
  const platformFeeWallet = launchPlatformFeeWallet();
  if (firstBuyLamports > BigInt(0) && !platformFeeWallet) throw firstBuyUnavailable();

  let response: PrepareLaunchResponse;
  try {
    response = await deps.api.rebuild({
      mint: review.mint,
      rebuildToken: review.rebuildToken,
      userWallet: deps.wallet,
      firstBuyLamports: firstBuyLamports.toString(),
    });
  } catch (error) {
    throw apiFailure(error);
  }
  if (response.mint !== review.mint) {
    throw new TxError(
      'verification_failed',
      'verify',
      'The rebuilt transaction is for another coin address. Nothing was signed.',
    );
  }
  const next = await checkPrepared(response, { ...review.coin, firstBuyLamports }, deps, platformFeeWallet);
  // The capability belongs to the launch, not to one transaction: keep it.
  return { ...next, rebuildToken: next.rebuildToken ?? review.rebuildToken };
}

/** Verifies a prepared or rebuilt launch, reads the wallet and simulates (fail closed). */
async function checkPrepared(
  response: PrepareLaunchResponse,
  coin: ValidatedCoin,
  deps: LaunchDeps,
  platformFeeWallet: string | null,
): Promise<LaunchReview> {
  const preparedAt = nowMs(deps);
  const rebuildToken = response.rebuildToken ?? null;

  let verified: VerifiedLaunch;
  try {
    verified = verifyPreparedLaunch(response, {
      wallet: deps.wallet,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: coin.firstBuyLamports,
      launchpadConfig: deps.launchpadConfig as string,
      poolCreationFeeLamports: deps.poolCreationFeeLamports as bigint,
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
  } catch (error) {
    throw new TxError(
      'verification_failed',
      'verify',
      'Could not check the transaction against the network. Try again in a moment.',
      undefined,
      { cause: error },
    );
  }
  const balanceLamports = pre[0]?.lamports ?? BigInt(0);
  const base = { ...verified, balanceLamports, coin, preparedAt, rebuildToken };
  if (balanceLamports < verified.summary.totalLamports) {
    // Not enough SOL: the simulation would fail. The review says so and signing stays disabled.
    return { ...base, insufficientBalance: true };
  }

  let simulation;
  try {
    simulation = await deps.chain.simulateTransaction(bytesToBase64(verified.tx.serialize()), [
      deps.wallet,
      verified.accounts.userCoinAccount,
    ]);
  } catch (error) {
    throw new TxError(
      'verification_failed',
      'verify',
      'Could not simulate the transaction. Try again in a moment.',
      undefined,
      { cause: error },
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

  return { ...base, insufficientBalance: false };
}

/**
 * Largest first buy the wallet balance covers with the other costs of `review` unchanged (its
 * platform fee included, a small margin kept), rounded down to 0.001 SOL; 0 when none fits.
 */
export function affordableFirstBuyLamports(review: LaunchReview, platformFeeBps: number): bigint {
  const balance = review.balanceLamports;
  if (balance === null) return BigInt(0);
  const s = review.summary;
  const others = s.totalLamports - s.firstBuyLamports - s.platformFeeLamports;
  // Margin for the rounding of the platform fee and a slightly higher network fee.
  const room = balance - others - BigInt(100000);
  if (room <= BigInt(0)) return BigInt(0);
  const bps = BigInt(10000);
  const max = (room * bps) / (bps + BigInt(platformFeeBps));
  const step = BigInt(1000000);
  return (max / step) * step;
}

export type LaunchPhase = 'signing' | 'sending' | 'confirming';

export interface LaunchResult {
  signature: string;
  mint: string;
}

export interface SubmitDeps {
  chain: ChainClient;
  signTransaction: SignTransaction;
  confirm?: ConfirmOptions;
}

export interface SubmitOptions {
  /** The message that was verified and shown: the wallet must sign exactly this. */
  expectedMessage?: Uint8Array;
  /**
   * Reads the block height before sending so that a transaction whose blockhash expired is
   * reported as `expired` (safe to rebuild) instead of `timeout`. Needs `chain.getBlockHeight`.
   */
  detectExpiry?: boolean;
}

/** Confirmation deadline when the expiry is watched: the expiry ends the wait well before it. */
const EXPIRY_WATCH_TIMEOUT_MS = 120_000;

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
      throw new TxError('user_rejected', 'sign', WALLET_ERROR_TEXT.rejected, undefined, {
        cause: error,
      });
    }
    throw new TxError('sign_failed', 'sign', WALLET_ERROR_TEXT.transactionFailed, undefined, {
      cause: error,
    });
  }

  // The wallet must have signed the very message that was verified and shown.
  if (!sameBytes(Uint8Array.from(signed.message.serialize()), expectedMessage)) {
    throw new TxError('sign_failed', 'sign', WALLET_ERROR_TEXT.differentTransaction);
  }

  // Every required signature must be present before sending (wallet and any pre-signed signer).
  const required = signed.message.header.numRequiredSignatures;
  if (
    signed.signatures.length < required ||
    signed.signatures.slice(0, required).some((s) => !isSigned(s))
  ) {
    throw new TxError('sign_failed', 'sign', WALLET_ERROR_TEXT.incomplete);
  }

  onPhase?.('sending');
  // Read after the blockhash was fetched (server side): an upper bound of its expiry height.
  let expiryHeight: number | undefined;
  if (options.detectExpiry && deps.chain.getBlockHeight) {
    try {
      expiryHeight =
        (await deps.chain.getBlockHeight()) + BLOCKHASH_LIFETIME_BLOCKS + EXPIRY_MARGIN_BLOCKS;
    } catch {
      // Without it a slow confirmation ends as `timeout` ("check again"), never as `expired`.
    }
  }
  let signature: string;
  try {
    signature = await deps.chain.sendRawTransaction(bytesToBase64(signed.serialize()));
  } catch (error) {
    throw new TxError('send_failed', 'send', describeSendFailure(error), undefined, {
      cause: error,
    });
  }

  onPhase?.('confirming', signature);
  await waitForSignature(signature, deps, expiryHeight);
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
    detectExpiry: true,
  });
  return { signature, mint: review.mint };
}

/**
 * Polls a sent transaction until confirmed. Throws `TxError` on failure or timeout. With
 * `expiryHeight` (and `chain.getBlockHeight`), a transaction still unknown once the chain passed
 * that height is reported as `expired`: it can never land.
 */
export async function waitForSignature(
  signature: string,
  deps: Pick<SubmitDeps, 'chain' | 'confirm'>,
  expiryHeight?: number,
): Promise<void> {
  const readHeight = deps.chain.getBlockHeight?.bind(deps.chain);
  const options: ConfirmOptions | undefined =
    expiryHeight !== undefined && readHeight !== undefined
      ? {
          timeoutMs: EXPIRY_WATCH_TIMEOUT_MS,
          isExpired: async () => (await readHeight()) > expiryHeight,
          ...deps.confirm,
        }
      : deps.confirm;
  const outcome = await confirmSignature(deps.chain, signature, options);
  const extra = { expiryHeight };
  if (outcome.kind === 'confirmed') return;
  if (outcome.kind === 'failed') {
    throw new TxError(
      'onchain_failed',
      'confirm',
      `The transaction failed on-chain. ${describeChainError(outcome.err)} Only the network fee was charged.`,
      signature,
      { cause: outcome.err, ...extra },
    );
  }
  if (outcome.kind === 'expired') {
    throw new TxError(
      'expired',
      'confirm',
      'The transaction expired before it was confirmed and was not executed. Nothing was charged: you can safely try again.',
      signature,
      extra,
    );
  }
  throw new TxError(
    'timeout',
    'confirm',
    'The transaction was sent but is not confirmed yet. It may still land: check again before retrying.',
    signature,
    extra,
  );
}

/** Polls an already sent launch transaction ("check again" after a timeout). */
export async function waitForLaunch(
  mint: string,
  signature: string,
  deps: Pick<LaunchDeps, 'chain' | 'confirm'>,
  expiryHeight?: number,
): Promise<LaunchResult> {
  await waitForSignature(signature, deps, expiryHeight);
  return { signature, mint };
}
