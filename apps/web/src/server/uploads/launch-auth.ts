import { createHash } from 'node:crypto';
import { base58DecodeExact } from '../auth/base58';
import { verifyEd25519 } from '../auth/ed25519';

/*
 * Wallet authorization of a coin upload, version 1: the exact message a client site asks the
 * wallet to sign. This is a byte-for-byte reimplementation of `buildLaunchAuthMessage` in
 * apps/launchpad-template/src/forge/create/auth.ts (the two apps cannot import each other); the
 * tests pin the text, so any drift on either side breaks them.
 */

export const LAUNCH_AUTH_VERSION = 1;
/** A signed request is accepted for this long after `issuedAt`. */
export const LAUNCH_AUTH_TTL_MS = 5 * 60 * 1000;
/** Clock skew tolerated for an `issuedAt` in the future. */
export const LAUNCH_AUTH_MAX_SKEW_MS = 60 * 1000;

export interface LaunchAuthFields {
  host: string;
  wallet: string;
  name: string;
  symbol: string;
  firstBuyLamports: string;
  imageSha256: string;
  descriptionSha256: string;
  nonce: string;
  issuedAt: string;
}

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

/** `issuedAt` is at most 5 minutes old and at most 60 seconds in the future. */
export function isFreshIssuedAt(issuedAt: string, nowMs: number): boolean {
  if (!ISO_PATTERN.test(issuedAt)) return false;
  const at = Date.parse(issuedAt);
  if (!Number.isFinite(at)) return false;
  return at <= nowMs + LAUNCH_AUTH_MAX_SKEW_MS && nowMs - at <= LAUNCH_AUTH_TTL_MS;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Strict base64 of exactly 64 bytes (what client sites send), else null. */
export function decodeSignature(base64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(base64)) return null;
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  return bytes.length === 64 ? bytes : null;
}

/** ed25519 check of `message` (UTF-8) against the wallet's base58 public key. */
export function verifyLaunchAuth(
  wallet: string,
  message: string,
  signatureBase64: string,
): boolean {
  const publicKey = base58DecodeExact(wallet, 32);
  const signature = decodeSignature(signatureBase64);
  if (publicKey === null || signature === null) return false;
  return verifyEd25519(Buffer.from(message, 'utf8'), signature, publicKey);
}
