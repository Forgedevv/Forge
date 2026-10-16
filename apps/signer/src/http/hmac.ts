import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SIGNER_MAX_CLOCK_SKEW_SECONDS,
  SIGNER_NONCE_HEADER,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
  signerSignedPayload,
} from '@forge/shared';

/** Minimum length of SIGNER_HMAC_SECRET, in bytes (256 bits, the HMAC-SHA256 block strength). */
export const MIN_HMAC_SECRET_BYTES = 32;

/** Unix seconds, digits only: no sign, no fraction, no whitespace, no exponent. */
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
/** Lowercase hex only, so that a signature has exactly one accepted spelling. */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
/** 16 bytes as lowercase hex: one spelling per nonce (replay cache key). */
const NONCE_RE = /^[0-9a-f]{32}$/;

export function assertHmacSecret(secret: string | Buffer | undefined): Buffer {
  if (secret === undefined) throw new Error('SIGNER_HMAC_SECRET is required');
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.length < MIN_HMAC_SECRET_BYTES) {
    throw new Error(`SIGNER_HMAC_SECRET must be at least ${MIN_HMAC_SECRET_BYTES} bytes`);
  }
  return bytes;
}

/** What the HMAC covers, as received (or as about to be sent). */
export interface SignedRequest {
  /** HTTP method, uppercase. */
  method: string;
  /** Request target: the path plus the query string, exactly as on the request line. */
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: Buffer;
}

/** A fresh nonce: 16 random bytes, lowercase hex. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Hex HMAC-SHA256 over `signerSignedPayload(...)` (packages/shared): the method, the path with its
 * query, the timestamp, the nonce and the SHA-256 of the raw body bytes. Throws when a field is
 * outside its format.
 */
export function computeSignature(secret: Buffer, req: SignedRequest): string {
  const payload = signerSignedPayload({
    method: req.method,
    path: req.path,
    timestamp: req.timestamp,
    nonce: req.nonce,
    bodySha256: createHash('sha256').update(req.rawBody).digest('hex'),
  });
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** The request a test or a tool signs with `signRequest`. */
export interface RequestToSign {
  method: string;
  /** Path plus query string, exactly as sent (`/v1/configs`). */
  path: string;
  /** Raw body; empty when absent. */
  body?: string | Buffer;
  /** Default: a fresh random nonce. */
  nonce?: string;
}

/**
 * Builds the authentication headers of a request (tests and tooling; the builder has its own
 * client). `now` is in milliseconds, like `Date.now()`.
 */
export function signRequest(
  secret: string | Buffer,
  request: RequestToSign,
  now: number = Date.now(),
): Record<string, string> {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const timestamp = String(Math.floor(now / 1000));
  const nonce = request.nonce ?? newNonce();
  const body = request.body ?? '';
  const signature = computeSignature(key, {
    method: request.method,
    path: request.path,
    timestamp,
    nonce,
    rawBody: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  });
  return {
    [SIGNER_TIMESTAMP_HEADER]: timestamp,
    [SIGNER_NONCE_HEADER]: nonce,
    [SIGNER_SIGNATURE_HEADER]: signature,
  };
}

export type TimestampCheck = { ok: true; seconds: number } | { ok: false };

/** Validates the timestamp header format and the clock skew (`nowMs` in milliseconds). */
export function checkTimestamp(header: string | undefined, nowMs: number): TimestampCheck {
  if (header === undefined || !TIMESTAMP_RE.test(header)) return { ok: false };
  const seconds = Number(header);
  if (!Number.isSafeInteger(seconds)) return { ok: false };
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - seconds) > SIGNER_MAX_CLOCK_SKEW_SECONDS) return { ok: false };
  return { ok: true, seconds };
}

/** Validates the nonce header format. */
export function isNonce(header: string | undefined): header is string {
  return header !== undefined && NONCE_RE.test(header);
}

/**
 * Constant-time comparison of the signature header with the expected MAC. A method, path,
 * timestamp or nonce outside its format never verifies.
 */
export function verifySignature(
  secret: Buffer,
  req: SignedRequest,
  header: string | undefined,
): boolean {
  if (header === undefined || !SIGNATURE_RE.test(header)) return false;
  let computed: string;
  try {
    computed = computeSignature(secret, req);
  } catch {
    return false;
  }
  const expected = Buffer.from(computed, 'hex');
  const received = Buffer.from(header, 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
