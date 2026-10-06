/*
 * Types of the apps/web browser client (`apps/web/src/client/`), translated from
 * docs/frontend/CONTRACT.md. When a signature differs from that document, this file wins.
 * Framework-free: hooks are typed as plain functions returning the documented shapes.
 */
import type { GatingResponse, Lamports, OwnerTransactionSummary, Quote, Session } from './api.js';
import type { LaunchpadStatus, PaymentKind } from './db.js';
import type { FailedStage, JobStatus, JobType } from './jobs.js';
import type { LaunchpadSpec, LaunchpadSpecDraft, SpecValidation } from './spec.js';

// Lamports, Session, Quote, OwnerTransactionSummary (api.ts), LaunchpadStatus (db.ts),
// JobStatus / JobType / FailedStage (jobs.ts), LaunchpadSpecDraft / SpecValidation (spec.ts)
// are part of this contract too and are exported from the package root.

/** `enabled: false` before the $FORGE launch (then `ok: true`). Amounts are raw token units. */
export type Gating = GatingResponse;

export interface Flags {
  signupsPaused: boolean;
}

export interface Job {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  failedStage: FailedStage | null;
  error: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
  refund?: { lamports: Lamports; signature: string } | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  message: string;
  createdAt: string;
}

export interface LaunchpadSummary {
  id: string;
  name: string;
  slug: string;
  siteUrl: string | null;
  status: LaunchpadStatus;
  coin: { name: string; symbol: string; mint: string | null; imageUrl: string };
  coinsCount: number;
  claimablePartnerFeesLamports: Lamports;
  includedModificationsLeft: number;
  activeJobId: string | null;
}

export interface LaunchpadDetail extends LaunchpadSummary {
  /** Complete spec. */
  spec: LaunchpadSpecDraft;
  onchain: {
    launchpadConfig: string | null;
    launchpadCoinConfig: string | null;
    launchpadCoinMint: string | null;
  };
  versions: {
    jobId: string;
    createdAt: string;
    request: string | null;
    previewUrl: string | null;
  }[];
  jobs: Job[];
}

export type TxPhase =
  'idle' | 'awaiting_signature' | 'sending' | 'confirmed' | 'rejected' | 'error';

export interface TxResult {
  phase: TxPhase;
  signature?: string;
  error?: string;
}

export const CLIENT_ERROR_CODES = [
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'GATING_REQUIRED',
  'SIGNUPS_PAUSED',
  'QUOTE_EXPIRED',
  'WRONG_WALLET',
  'NETWORK',
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Rejection of client functions; `message` is readable by the end user. */
export class ClientError extends Error {
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

export function isClientError(value: unknown): value is ClientError {
  return value instanceof ClientError;
}

// ---------------------------------------------------------------------------
// Hook results
// ---------------------------------------------------------------------------

export interface UseSessionResult {
  session: Session | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status: 'idle' | 'signing' | 'error';
}

export interface UseGatingResult {
  gating: Gating | null;
  loading: boolean;
  recheck(): Promise<void>;
}

export interface UiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatOptions {
  conversationId?: string;
  launchpadId?: string;
}

export interface UseChatResult {
  messages: UiChatMessage[];
  send(text: string): void;
  streaming: boolean;
  spec: LaunchpadSpecDraft;
  validation: SpecValidation;
  rateLimited: boolean;
  conversationId: string | null;
}

export interface UseJobResult {
  job: Job | null;
  events: JobEvent[];
  loading: boolean;
}

export interface UseLaunchpadsResult {
  launchpads: LaunchpadSummary[];
  loading: boolean;
  refresh(): void;
}

export interface UseLaunchpadResult {
  launchpad: LaunchpadDetail | null;
  loading: boolean;
}

/** Options of `formatSol` (not detailed in CONTRACT.md). */
export interface FormatSolOptions {
  /** Maximum number of fraction digits. */
  maxFractionDigits?: number;
  /** Append the " SOL" unit. */
  withUnit?: boolean;
}

export type OnTxPhase = (phase: TxPhase) => void;

/** One `data:` line of the `POST /api/chat` event stream (INTERFACES §6). */
export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'spec'; spec: LaunchpadSpecDraft; validation: SpecValidation }
  | { type: 'error'; code: ClientErrorCode; message: string }
  | { type: 'done' };

/** Every function and hook exported by `apps/web/src/client/` (and by its mocks). */
export interface WebClient {
  useSession(): UseSessionResult;
  useFlags(): Flags;
  useGating(): UseGatingResult;
  useChat(opts: UseChatOptions): UseChatResult;
  confirmSpec(
    conversationId: string,
    spec: LaunchpadSpec,
  ): Promise<{ launchpadId: string; jobId: string }>;
  requestModification(
    launchpadId: string,
    conversationId: string,
    request: string,
  ): Promise<{ jobId: string }>;
  getQuote(jobId: string, kind: PaymentKind): Promise<Quote>;
  payQuote(quote: Quote, onPhase: OnTxPhase): Promise<TxResult>;
  useJob(jobId: string): UseJobResult;
  approvePreview(jobId: string): Promise<void>;
  getOwnerTransactionSummary(jobId: string): Promise<OwnerTransactionSummary>;
  signOwnerTransaction(jobId: string, onPhase: OnTxPhase): Promise<TxResult>;
  useLaunchpads(): UseLaunchpadsResult;
  useLaunchpad(id: string): UseLaunchpadResult;
  claimPartnerFees(launchpadId: string, onPhase: OnTxPhase): Promise<TxResult>;
  reactivateLaunchpad(launchpadId: string): Promise<void>;
  formatSol(lamports: Lamports, opts?: FormatSolOptions): string;
  formatUsd(n: number): string;
  shortAddress(a: string): string;
  explorerTxUrl(sig: string): string;
}

/** Client-facing labels of job statuses. For `failed`, show details according to `failedStage`. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  spec_ready: 'Awaiting payment',
  paid: 'Payment received',
  building: 'Building',
  preview_ready: 'Preview ready',
  approved: 'Approved',
  onchain_setup: 'Connecting to Meteora',
  awaiting_owner_signature: 'Your turn to sign the launch',
  owner_signed: 'Launch signed',
  deploying: 'Going live',
  live: 'Live',
  failed: 'Problem',
  refunded: 'Refunded',
};
