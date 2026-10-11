import { createHash, createHmac } from 'node:crypto';

/*
 * AWS Signature Version 4, query-string flavour (presigned URLs), as accepted by S3 and
 * Cloudflare R2. Pure functions over node:crypto, no SDK. Reference: "Authenticating Requests:
 * Using Query Parameters (AWS Signature Version 4)" in the Amazon S3 API documentation; the test
 * file checks the published example vectors.
 */

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** Longest validity S3 and R2 accept for a presigned URL. */
export const MAX_PRESIGN_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignInput {
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  /** Absolute https URL of the object (no query string). */
  url: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** Signing time; truncated to the second. */
  date: Date;
  expiresSeconds: number;
  /** Headers the request must carry, signed. `host` is always signed and must not be listed. */
  headers?: Record<string, string>;
}

export interface PresignedRequest {
  url: string;
  /** Headers to send with the request, exactly as signed. */
  headers: Record<string, string>;
}

/** RFC 3986 percent-encoding (unreserved characters kept), as SigV4 requires. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `kSigning` = HMAC chain over the date stamp, region, service and "aws4_request". */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** `20130524T000000Z`. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export interface CanonicalParts {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  query: string;
}

/** Builds every intermediate value of the signature (exported for the vector tests). */
export function presignParts(input: PresignInput): CanonicalParts & { signedHeaders: string } {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '') {
    throw new Error('presign: the object URL must be https without query or fragment');
  }
  if (
    !Number.isInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS
  ) {
    throw new Error('presign: invalid expiry');
  }
  const time = amzDate(input.date);
  const dateStamp = time.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  const headers = new Map<string, string>([['host', url.host]]);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'host' || headers.has(lower)) {
      throw new Error('presign: duplicate or reserved header');
    }
    headers.set(lower, canonicalHeaderValue(value));
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name)}\n`).join('');

  const params: [string, string][] = [
    ['X-Amz-Algorithm', SIGV4_ALGORITHM],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', time],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const query = params
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // The URL parser already percent-encodes the path; decode then encode each segment once.
  const canonicalUri = url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = [SIGV4_ALGORITHM, time, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = deriveSigningKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return { canonicalRequest, stringToSign, signature, query, signedHeaders };
}

/** Presigned URL plus the headers the caller must send with it. */
export function presign(input: PresignInput): PresignedRequest {
  const parts = presignParts(input);
  const url = new URL(input.url);
  const pathname = url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
  return {
    url: `${url.origin}${pathname}?${parts.query}&X-Amz-Signature=${parts.signature}`,
    headers: { ...(input.headers ?? {}) },
  };
}
