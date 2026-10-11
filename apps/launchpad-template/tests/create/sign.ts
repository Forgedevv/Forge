import { createPrivateKey, sign } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** ed25519 signature by a test keypair, as a wallet's `signMessage` would produce. */
export function signWithKeypair(keypair: Keypair, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return Uint8Array.from(sign(null, Buffer.from(message), key));
}
