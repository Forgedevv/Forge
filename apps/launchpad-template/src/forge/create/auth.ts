/**
 * LOCKED ZONE. Message the connected wallet signs to authorize a coin preparation request
 * (`POST /api/upload`). Shared by the browser (which asks the wallet to sign it) and the server
 * (which rebuilds it from the request and verifies the signature), so both always agree.
 *
 * Everything the server stores or builds is bound to the signature: the site, the wallet, the coin
 * name and symbol, the first buy, the exact image and description bytes (SHA-256), a single-use
 * nonce and the time it was issued. A replayed or edited request does not verify.
 */

export const LAUNCH_AUTH_VERSION = 1;
/** A signed request is accepted for this long after `issuedAt`. */
export const LAUNCH_AUTH_TTL_MS = 5 * 60 * 1000;
/** Clock skew tolerated for an `issuedAt` in the future. */
export const LAUNCH_AUTH_MAX_SKEW_MS = 60 * 1000;

export interface LaunchAuthFields {
  /** Host of the site, as in `window.location.host` / the `Host` header. */
  host: string;
  wallet: string;
  name: string;
  symbol: string;
  firstBuyLamports: string;
  imageSha256: string;
  descriptionSha256: string;
  /** 32 lowercase hex characters (16 random bytes). */
  nonce: string;
  /** ISO 8601 UTC timestamp. */
  issuedAt: string;
}

export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** The exact text signed by the wallet. */
export function buildLaunchAuthMessage(f: LaunchAuthFields): string {
  return [
    `${f.host} asks you to sign in to create a coin.`,
    '',
    'This signature authorizes the upload of the coin image and metadata. It does not move funds',
    'and is not a transaction.',
    '',
    `Version: ${LAUNCH_AUTH_VERSION}`,
    `Wallet: ${f.wallet}`,
    `Coin: ${f.name} (${f.symbol})`,
    `First buy (lamports): ${f.firstBuyLamports}`,
    `Image SHA-256: ${f.imageSha256}`,
    `Description SHA-256: ${f.descriptionSha256}`,
    `Nonce: ${f.nonce}`,
    `Issued at: ${f.issuedAt}`,
  ].join('\n');
}

/** Freshness of `issuedAt` relative to `now` (epoch ms). */
export function isFreshIssuedAt(issuedAt: string, now: number): boolean {
  if (!ISO_PATTERN.test(issuedAt)) return false;
  const at = Date.parse(issuedAt);
  if (!Number.isFinite(at)) return false;
  return at <= now + LAUNCH_AUTH_MAX_SKEW_MS && now - at <= LAUNCH_AUTH_TTL_MS;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 through Web Crypto (browser, and Node 20+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is not available in this browser.');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest('SHA-256', copy.buffer);
  return bytesToHex(new Uint8Array(digest));
}

/** 16 random bytes as hex. */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
