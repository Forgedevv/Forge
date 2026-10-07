import { z } from 'zod';
import { JobStatus } from './jobs.js';
import { PaymentKind, PaymentStatus } from './db.js';
import { LaunchpadSpec, SolanaAddress } from './spec.js';

/*
 * Request/response schemas of the apps/web API (docs/INTERFACES.md §6) and of the internal
 * builder -> signer API (§7). Request bodies are strict (unknown keys are rejected); responses
 * strip unknown keys.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Lamports serialized as a decimal string (bigint). 1 SOL = 1_000_000_000 lamports. */
export const Lamports = z
  .string()
  .regex(/^\d+$/, { error: 'Lamports must be a decimal integer string' });
export type Lamports = z.infer<typeof Lamports>;

/** Raw token amount (smallest units) serialized as a decimal string. */
export const RawTokenAmount = z.string().regex(/^\d+$/);

/** Base58 ed25519 signature (transaction signature or signed message). */
export const Base58Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, {
  error: 'Invalid base58 signature',
});

/** Serialized transaction, base64 encoded. */
export const Base64Transaction = z.base64().min(1);

export const Uuid = z.uuid();

/** ISO 8601 date-time (UTC `Z` or with an offset). */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Path params of routes with `:id`. */
export const RouteIdParams = z.strictObject({ id: Uuid });
export type RouteIdParams = z.infer<typeof RouteIdParams>;

// ---------------------------------------------------------------------------
// apps/web routes (§6)
// ---------------------------------------------------------------------------

export const WEB_API_ROUTES = {
  authNonce: { method: 'POST', path: '/api/auth/nonce' },
  authVerify: { method: 'POST', path: '/api/auth/verify' },
  authSession: { method: 'GET', path: '/api/auth/session' },
  authLogout: { method: 'POST', path: '/api/auth/logout' },
  authSupabaseToken: { method: 'GET', path: '/api/auth/supabase-token' },
  gating: { method: 'GET', path: '/api/gating' },
  flags: { method: 'GET', path: '/api/flags' },
  chat: { method: 'POST', path: '/api/chat' },
  specConfirm: { method: 'POST', path: '/api/spec/confirm' },
  launchpadModifications: { method: 'POST', path: '/api/launchpads/:id/modifications' },
  paymentsQuote: { method: 'POST', path: '/api/payments/quote' },
  paymentsConfirm: { method: 'POST', path: '/api/payments/confirm' },
  jobApprove: { method: 'POST', path: '/api/jobs/:id/approve' },
  ownerTransactionGet: { method: 'GET', path: '/api/jobs/:id/owner-transaction' },
  ownerTransactionSubmit: { method: 'POST', path: '/api/jobs/:id/owner-transaction' },
  claimTransaction: { method: 'GET', path: '/api/launchpads/:id/claim-transaction' },
  launchpadReactivate: { method: 'POST', path: '/api/launchpads/:id/reactivate' },
  rpc: { method: 'POST', path: '/api/rpc' },
} as const;

// POST /api/auth/nonce
export const AuthNonceRequest = z.strictObject({ wallet: SolanaAddress });
export type AuthNonceRequest = z.infer<typeof AuthNonceRequest>;
/**
 * `nonce` is an opaque server-signed token (stateless). `message` is the exact text the wallet
 * must sign; the client never builds it. The token is also set as an HttpOnly cookie.
 */
export const AuthNonceResponse = z.object({
  nonce: z.string().min(1),
  message: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type AuthNonceResponse = z.infer<typeof AuthNonceResponse>;

// POST /api/auth/verify — signature of the message containing the nonce
export const AuthVerifyRequest = z.strictObject({
  wallet: SolanaAddress,
  signature: Base58Signature,
  /** The token returned by /api/auth/nonce; optional because it is also sent as a cookie. */
  nonce: z.string().min(1).optional(),
});
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequest>;
/** The session. */
export const AuthVerifyResponse = z.object({ wallet: SolanaAddress });
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;
// POST /api/auth/logout
export const AuthLogoutResponse = z.object({ ok: z.literal(true) });
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponse>;

// GET /api/auth/supabase-token — short-lived JWT for Supabase RLS / Realtime (claim `wallet`)
export const SupabaseTokenResponse = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type SupabaseTokenResponse = z.infer<typeof SupabaseTokenResponse>;

export const Session = AuthVerifyResponse;
export type Session = AuthVerifyResponse;

// GET /api/gating — FORGE_GATING_AMOUNT of mint FORGE_MINT. Without FORGE_MINT, gating is
// disabled: `enabled: false` and `ok: true`.
export const GatingResponse = z.object({
  ok: z.boolean(),
  /** Required raw amount (smallest units). */
  required: RawTokenAmount,
  /** Wallet raw balance (smallest units). */
  balance: RawTokenAmount,
  enabled: z.boolean(),
});
export type GatingResponse = z.infer<typeof GatingResponse>;

// GET /api/flags — public kill-switch state needed by the UI
export const FlagsResponse = z.object({ signupsPaused: z.boolean() });
export type FlagsResponse = z.infer<typeof FlagsResponse>;

// POST /api/chat — text/event-stream of ChatStreamEvent (web-client.ts); always starts with
// { type: 'conversation', conversationId } and ends with { type: 'done' }.
export const ChatRequest = z.strictObject({
  conversationId: Uuid.optional(),
  /** Set for a modification of an existing launchpad. */
  launchpadId: Uuid.optional(),
  message: z.string().min(1),
});
export type ChatRequest = z.infer<typeof ChatRequest>;
/** Payload of the first stream event. */
export const ChatResponse = z.object({ conversationId: Uuid });
export type ChatResponse = z.infer<typeof ChatResponse>;

// POST /api/spec/confirm
export const SpecConfirmRequest = z.strictObject({ conversationId: Uuid, spec: LaunchpadSpec });
export type SpecConfirmRequest = z.input<typeof SpecConfirmRequest>;
export const SpecConfirmResponse = z.object({ launchpadId: Uuid, jobId: Uuid });
export type SpecConfirmResponse = z.infer<typeof SpecConfirmResponse>;

// POST /api/launchpads/:id/modifications
export const LaunchpadModificationRequest = z.strictObject({
  conversationId: Uuid,
  request: z.string().min(1),
});
export type LaunchpadModificationRequest = z.infer<typeof LaunchpadModificationRequest>;
export const LaunchpadModificationResponse = z.object({ jobId: Uuid });
export type LaunchpadModificationResponse = z.infer<typeof LaunchpadModificationResponse>;

// POST /api/payments/quote
export const PaymentsQuoteRequest = z.strictObject({ jobId: Uuid, kind: PaymentKind });
export type PaymentsQuoteRequest = z.infer<typeof PaymentsQuoteRequest>;
/** Quote as seen by the UI (docs/frontend/CONTRACT.md). */
export const Quote = z.object({
  paymentId: Uuid,
  kind: PaymentKind,
  lamports: Lamports,
  usdAmount: z.number().nonnegative(),
  expiresAt: IsoDateTime,
});
export type Quote = z.infer<typeof Quote>;
/**
 * `transaction` is the unsigned payment transaction (base64). It is null when lamports = "0"
 * (an included modification remains and the job goes straight to `paid`).
 */
export const PaymentsQuoteResponse = Quote.extend({ transaction: Base64Transaction.nullable() });
export type PaymentsQuoteResponse = z.infer<typeof PaymentsQuoteResponse>;

// POST /api/payments/confirm
export const PaymentsConfirmRequest = z.strictObject({
  paymentId: Uuid,
  signature: Base58Signature,
});
export type PaymentsConfirmRequest = z.infer<typeof PaymentsConfirmRequest>;
export const PaymentsConfirmResponse = z.object({ status: PaymentStatus });
export type PaymentsConfirmResponse = z.infer<typeof PaymentsConfirmResponse>;

// POST /api/jobs/:id/approve (no body)
export const JobApproveResponse = z.object({ status: JobStatus });
export type JobApproveResponse = z.infer<typeof JobApproveResponse>;

/** Summary shown before the client signs the launch transaction. */
export const OwnerTransactionSummary = z.object({
  coinName: z.string(),
  coinSymbol: z.string(),
  firstBuyLamports: Lamports,
  estimatedNetworkFeeLamports: Lamports,
  ownerWallet: SolanaAddress,
});
export type OwnerTransactionSummary = z.infer<typeof OwnerTransactionSummary>;

// GET /api/jobs/:id/owner-transaction — launch transaction partially signed by FORGE
export const OwnerTransactionGetResponse = z.object({
  transaction: Base64Transaction,
  /** Shown to the client before signing (INTERFACES §6). */
  summary: OwnerTransactionSummary,
});
export type OwnerTransactionGetResponse = z.infer<typeof OwnerTransactionGetResponse>;

// POST /api/jobs/:id/owner-transaction
export const OwnerTransactionSubmitRequest = z.strictObject({
  signedTransaction: Base64Transaction,
});
export type OwnerTransactionSubmitRequest = z.infer<typeof OwnerTransactionSubmitRequest>;
export const OwnerTransactionSubmitResponse = z.object({ signature: Base58Signature });
export type OwnerTransactionSubmitResponse = z.infer<typeof OwnerTransactionSubmitResponse>;

// GET /api/launchpads/:id/claim-transaction — client partner fee claim
export const ClaimTransactionResponse = z.object({ transaction: Base64Transaction });
export type ClaimTransactionResponse = z.infer<typeof ClaimTransactionResponse>;

// POST /api/rpc — Helius relay (method allow-list and per-IP rate limit enforced by apps/web)
const JsonRpcId = z.union([z.string(), z.number(), z.null()]);
export const RpcRequest = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcId,
  method: z.string().min(1),
  params: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;
export const RpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcId,
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

// ---------------------------------------------------------------------------
// Internal builder -> signer API (§7)
// ---------------------------------------------------------------------------

/** Hex HMAC-SHA256 computed with SIGNER_HMAC_SECRET over `signerSignedPayload(...)`. */
export const SIGNER_SIGNATURE_HEADER = 'X-Forge-Signature';
/** Unix time in seconds, as a decimal string. */
export const SIGNER_TIMESTAMP_HEADER = 'X-Forge-Timestamp';
/** Requests whose timestamp differs from the signer clock by more than this are rejected. */
export const SIGNER_MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * Exact string fed to HMAC-SHA256: `<timestamp>.<raw body>`. The timestamp is covered by the MAC
 * so that a captured request cannot be replayed with a fresh timestamp.
 */
export function signerSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export const SIGNER_ROUTES = {
  configs: { method: 'POST', path: '/v1/configs' },
  launchCoinPrepare: { method: 'POST', path: '/v1/launch-coin/prepare' },
  health: { method: 'GET', path: '/v1/health' },
} as const;

/*
 * The signer never takes an address or an amount from the request: it re-reads everything in
 * Supabase. Requests are therefore strict and carry only the job id. Both routes are idempotent.
 */

// POST /v1/configs
export const SignerConfigsRequest = z.strictObject({ jobId: Uuid });
export type SignerConfigsRequest = z.infer<typeof SignerConfigsRequest>;
export const SignerConfigsResponse = z.object({
  launchpadConfig: SolanaAddress,
  launchpadCoinConfig: SolanaAddress,
});
export type SignerConfigsResponse = z.infer<typeof SignerConfigsResponse>;

// POST /v1/launch-coin/prepare — durable-nonce transaction signed by the creator wallet
export const SignerLaunchPrepareRequest = z.strictObject({ jobId: Uuid });
export type SignerLaunchPrepareRequest = z.infer<typeof SignerLaunchPrepareRequest>;
export const SignerLaunchPrepareResponse = z.object({
  partiallySignedTx: Base64Transaction,
  mint: SolanaAddress,
});
export type SignerLaunchPrepareResponse = z.infer<typeof SignerLaunchPrepareResponse>;

// GET /v1/health
export const SignerHealthResponse = z.object({ ok: z.boolean() });
export type SignerHealthResponse = z.infer<typeof SignerHealthResponse>;
