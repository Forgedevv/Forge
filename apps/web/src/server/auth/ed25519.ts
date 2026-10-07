import { createPublicKey, verify } from 'node:crypto';

/**
 * Verifies an ed25519 signature with node:crypto (no extra dependency). `publicKey` is the raw
 * 32-byte key (a Solana wallet address decoded from base58), `signature` the raw 64 bytes.
 * Returns false for malformed keys or signatures instead of throwing.
 */
export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') },
      format: 'jwk',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
