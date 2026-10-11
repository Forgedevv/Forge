import { z } from 'zod';

/*
 * Presigned coin-image upload contract, version 1. The client is the server side of each client
 * site (apps/launchpad-template, src/forge/create/upload-client.ts, whose header comment is the
 * reference). Request bodies are strict; errors are `{ error: { code, message } }`.
 *
 *   POST /api/launchpads/{id}/uploads                      UploadRequest -> UploadTicket
 *   PUT  {ticket.image.uploadUrl} (to R2, write-once)
 *   POST /api/launchpads/{id}/uploads/{uploadId}/complete  { mint } -> UploadReceipt
 *
 * `{id}` is the launchpad slug (what client sites send) or its uuid. Both POSTs must carry the
 * launchpad's server token in `X-Forge-Relay-Token` (the same per-launchpad token as the RPC
 * relay's server tier, rpc/server-token.ts; the client site holds it as the server-only variable
 * FORGE_RPC_RELAY_TOKEN). It identifies the calling site: limits are keyed on it and it must name
 * the launchpad of the route.
 *
 * The presigned PUT targets a staging key (`pending/{slug}/{mint}.{ext}`), signed with
 * `Content-Type`, `If-None-Match: *`, `x-amz-checksum-sha256` (all in `image.headers`) and
 * `Content-Length` = `image.size` (not listed: HTTP clients derive it from the body, which must
 * therefore be exactly `image.size` bytes, not chunked). `complete` verifies the staged bytes and
 * only then writes the public image key (`image.publicUrl`) itself, so bytes that were never
 * verified never appear at a public coin URL. Staged objects are deleted by `complete`, by the
 * sweep (sweep.ts) and, as a second guard, by an R2 lifecycle rule on `pending/`.
 */

export const UPLOAD_CONTRACT_VERSION = 1;

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Presigned PUT validity (the contract caps it at 10 minutes). */
export const TICKET_TTL_SECONDS = 10 * 60;
/** `complete` is accepted this long after the ticket was issued. */
export const COMPLETE_WINDOW_SECONDS = 60 * 60;
/**
 * The sweep waits this long past the presigned URL expiry (or the complete window) before
 * cleaning a ticket's objects: covers clock skew and a `complete` still running.
 */
export const SWEEP_GRACE_SECONDS = 10 * 60;
/** Metaplex caps the metadata URI at 200 bytes; the client site refuses longer URLs. */
export const MAX_METADATA_URL_BYTES = 200;

/** Largest accepted JSON bodies. */
export const MAX_TICKET_BODY_BYTES = 16 * 1024;
export const MAX_COMPLETE_BODY_BYTES = 1024;

// Control characters and bidirectional overrides have no place in coin texts.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const noForbidden = (value: string) => !FORBIDDEN_CHARS.test(value);
const noForbiddenMultiline = (value: string) =>
  !FORBIDDEN_CHARS.test(value.replace(/[\n\r\t]/g, ' '));

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export const UploadRequest = z
  .object({
    version: z.literal(UPLOAD_CONTRACT_VERSION),
    mint: Base58Address,
    wallet: Base58Address,
    coin: z
      .object({
        name: z.string().min(1).max(32).refine(noForbidden, 'unsupported characters'),
        symbol: z.string().min(1).max(10).refine(noForbidden, 'unsupported characters'),
        description: z.string().max(500).refine(noForbiddenMultiline, 'unsupported characters'),
      })
      .strict(),
    firstBuyLamports: z
      .string()
      .regex(/^\d{1,20}$/)
      .refine((value) => BigInt(value) <= U64_MAX, 'out of range'),
    image: z
      .object({
        contentType: z.enum(IMAGE_TYPES),
        size: z.number().int().min(1).max(IMAGE_MAX_BYTES),
        sha256: Hex64,
      })
      .strict(),
    auth: z
      .object({
        host: z.string().min(1).max(253),
        nonce: z.string().regex(/^[0-9a-f]{32}$/),
        issuedAt: z.string().min(1).max(32),
        signature: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type UploadRequest = z.infer<typeof UploadRequest>;

export const CompleteRequest = z.object({ mint: Base58Address }).strict();
export type CompleteRequest = z.infer<typeof CompleteRequest>;

export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export interface UploadTicket {
  uploadId: string;
  expiresAt: string;
  image: {
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    publicUrl: string;
  };
  metadata: { publicUrl: string };
}

export interface UploadReceipt {
  image: { publicUrl: string; sha256: string };
  metadata: { publicUrl: string; sha256: string };
}

/** Durable rate limits (counted from issued tickets) and per-instance pre-limits. */
export const UPLOAD_RATE_LIMITS = {
  /** Tickets per wallet, across launchpads. */
  wallet: { limit: 10, windowMs: 10 * 60_000 },
  /** Tickets per launchpad, across wallets. */
  launchpad: { limit: 120, windowMs: 10 * 60_000 },
  /** `complete` calls per upload (each one may read the image back from storage). */
  complete: { limit: 10, windowMs: 60_000 },
} as const;

/**
 * Per-instance limits checked by the route handlers before any database, storage or RPC work.
 * Client-site servers share the Vercel egress IPs, hence the coarse per-IP rule; the real keys
 * are the per-launchpad server tokens.
 */
export const UPLOAD_PRE_LIMITS = {
  /** Requests per client IP, both routes together (valid or not). */
  ip: { limit: 600, windowMs: 60_000 },
  /** Ticket requests per launchpad server token (retries and refusals included). */
  serverIssue: { limit: 240, windowMs: 10 * 60_000 },
  /** `complete` calls per launchpad server token, across uploads. */
  serverComplete: { limit: 600, windowMs: 10 * 60_000 },
} as const;

export type UploadErrorCode =
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'AUTH_EXPIRED'
  | 'BAD_SIGNATURE'
  | 'SERVER_TOKEN_REQUIRED'
  | 'SERVER_TOKEN_MISMATCH'
  | 'HOST_MISMATCH'
  | 'LAUNCHPAD_NOT_FOUND'
  | 'LAUNCHPAD_NOT_LIVE'
  | 'NONCE_USED'
  | 'MINT_USED'
  | 'RATE_LIMITED'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_EXPIRED'
  | 'IMAGE_MISSING'
  | 'IMAGE_REJECTED'
  | 'METADATA_CONFLICT'
  | 'IMAGE_CONFLICT'
  | 'STORAGE_UNAVAILABLE'
  | 'CHAIN_UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'SERVER_ERROR';

export class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: UploadErrorCode,
    message: string,
    /** Seconds, sent as `Retry-After` (429). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'UploadHttpError';
  }
}

export function uploadErrorResponse(error: UploadHttpError): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (error.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterSeconds)));
  }
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers },
  );
}
