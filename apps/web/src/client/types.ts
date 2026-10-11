import type {
  ClaimTransactionSummary,
  LaunchpadDetail,
  LaunchpadSummary,
  OnTxPhase,
  OwnerTransactionSummary,
  Quote,
  TxResult,
  UseLaunchpadResult,
  UseLaunchpadsResult,
  WebClient,
} from '@forge/shared';

/*
 * What the FORGE site client offers on top of the shared `WebClient` contract
 * (packages/shared/src/web-client.ts). Every extra field is optional and every extra method has a
 * neutral default (`withClientExtensions`), so a plain `WebClient` (the UI mocks) still fits.
 * Type-only module: safe to import from the UI without pulling the wallet stack.
 */

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/**
 * Where a payment stands once its transaction has been sent:
 * - `confirmed`: the server confirmed it;
 * - `confirming`: sent, not confirmed yet; retrying re-confirms the same signature;
 * - `late`: received after the quote expired, refunded by hand: never pay again for this job;
 * - `rejected`: the server refused it after it was sent: support handles it, never pay again;
 * - `failed`: it failed on-chain, no SOL moved (besides the network fee): a new quote is fine.
 */
export type PaymentOutcome = 'confirmed' | 'confirming' | 'late' | 'rejected' | 'failed';

export interface PaymentResult extends TxResult {
  /** Set once a payment transaction was sent. `signature` is then always set too. */
  outcome?: PaymentOutcome;
}

/** A payment sent for a job and not settled yet (kept for the browser tab session). */
export interface PendingPayment {
  jobId: string;
  paymentId: string;
  signature: string;
  outcome: 'confirming' | 'late' | 'rejected';
  /** Readable explanation for `late` and `rejected`. */
  message: string | null;
}

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

/** Whether the server simulated the exact launch transaction; otherwise amounts are a minimum. */
export type LaunchSimulation = 'ok' | 'failed' | 'unavailable';

export interface LaunchReview extends OwnerTransactionSummary {
  /** Missing when the server did not say: treat as `unavailable`. */
  simulation?: LaunchSimulation;
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

export interface ClaimOptions {
  /**
   * Called with the summary of the claim transaction before the wallet is asked to sign it.
   * Resolve `true` to sign, `false` to stop (nothing is signed). `null`: the server sent no summary.
   */
  review?(summary: ClaimTransactionSummary | null): Promise<boolean>;
}

export interface ClaimResult extends TxResult {
  /** Summary of the claim transaction that was reviewed (and signed when confirmed). */
  summary?: ClaimTransactionSummary | null;
}

// ---------------------------------------------------------------------------------------------
// Launchpads
// ---------------------------------------------------------------------------------------------

export interface LaunchpadSummaryView extends LaunchpadSummary {
  /** False when the server could not read the chain: coins and fees are then unknown, not 0. */
  onchainAvailable?: boolean;
}

export interface LaunchpadDetailView extends LaunchpadDetail {
  onchainAvailable?: boolean;
}

export interface UseLaunchpadsView extends UseLaunchpadsResult {
  launchpads: LaunchpadSummaryView[];
  /** Readable error of the last failed load (the list then keeps its previous content). */
  error?: string | null;
}

export interface UseLaunchpadView extends UseLaunchpadResult {
  launchpad: LaunchpadDetailView | null;
  error?: string | null;
  refresh?(): void;
}

// ---------------------------------------------------------------------------------------------
// Private beta
// ---------------------------------------------------------------------------------------------

export interface BetaAccess {
  /** The server refused this wallet: FORGE is in private beta and it is not invited. */
  notInvited: boolean;
  /** Clears the notice (e.g. before connecting another wallet). */
  dismiss(): void;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface ForgeClientExtensions {
  useBetaAccess(): BetaAccess;
  /** The payment already sent for this job and not settled, if any. */
  getPendingPayment(jobId: string): PendingPayment | null;
  /** Re-confirms the payment already sent for this job (same signature, never a new payment). */
  resumePayment(jobId: string, onPhase: OnTxPhase): Promise<PaymentResult>;
}

type Extended =
  'payQuote' | 'getOwnerTransactionSummary' | 'claimPartnerFees' | 'useLaunchpads' | 'useLaunchpad';

/** The client the FORGE screens use: the shared contract, with richer results. */
export interface ForgeWebClient extends Omit<WebClient, Extended>, ForgeClientExtensions {
  payQuote(quote: Quote, onPhase: OnTxPhase): Promise<PaymentResult>;
  getOwnerTransactionSummary(jobId: string): Promise<LaunchReview>;
  claimPartnerFees(
    launchpadId: string,
    onPhase: OnTxPhase,
    options?: ClaimOptions,
  ): Promise<ClaimResult>;
  useLaunchpads(): UseLaunchpadsView;
  useLaunchpad(id: string): UseLaunchpadView;
}

/** A `ForgeWebClient` whose extension methods may be missing (e.g. a plain `WebClient`). */
export type ForgeClientInput = Omit<ForgeWebClient, keyof ForgeClientExtensions> &
  Partial<ForgeClientExtensions>;
