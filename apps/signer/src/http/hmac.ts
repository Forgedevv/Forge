import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SIGNER_MAX_CLOCK_SKEW_SECONDS,
  SIGNER_SIGNATURE_HEADER,
  SIGNER_TIMESTAMP_HEADER,
  signerSignedPayload,
} from '@forge/shared';

/** Minimum length of SIGNER_HMAC_SECRET, in bytes (256 bits, the HMAC-SHA256 block strength). */
export const MIN_HMAC_SECRET_BYTES = 32;

/** Unix seconds, digits only: no sign, no fraction, no whitespace, no exponent. */
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
/** Lowercase hex only, so that a signature has exactly one accepted spelling (replay cache key). */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

export function assertHmacSecret(secret: string | Buffer | undefined): Buffer {
  if (secret === undefined) throw new Error('SIGNER_HMAC_SECRET is required');
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.length < MIN_HMAC_SECRET_BYTES) {
    throw new Error(`SIGNER_HMAC_SECRET must be at least ${MIN_HMAC_SECRET_BYTES} bytes`);
  }
  return bytes;
}

/** Hex HMAC-SHA256 over the raw bytes of `<timestamp>.<raw body>`. */
export function computeSignature(secret: Buffer, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`, 'utf8'))
    .update(rawBody)
    .digest('hex');
}

/**
 * Builds the authentication headers of a request (tests and tooling; the builder has its own
 * client). `now` is in milliseconds, like `Date.now()`.
 */
export function signRequest(
  secret: string | Buffer,
  body: string,
  now: number = Date.now(),
): Record<string, string> {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac('sha256', key)
    .update(signerSignedPayload(timestamp, body), 'utf8')
    .digest('hex');
  return {
    [SIGNER_TIMESTAMP_HEADER]: timestamp,
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

/** Constant-time comparison of the signature header with the expected MAC. */
export function verifySignature(
  secret: Buffer,
  timestamp: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (header === undefined || !SIGNATURE_RE.test(header)) return false;
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
  const received = Buffer.from(header, 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
