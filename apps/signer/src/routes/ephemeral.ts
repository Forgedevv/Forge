/**
 * One-time keys: the config accounts, the durable nonce account and the coin mint.
 *
 * Each of these keys signs exactly one transaction (the one that creates its account) and is
 * useless afterwards: a config or nonce account is controlled by its program/authority once
 * created, and the coin mint's authority is the pool. So the key is generated here, signs, and is
 * dropped: it is never written anywhere, never returned, never logged. Idempotency does not need
 * it: the signed bytes are journaled before sending and only ever re-sent as they are; a
 * transaction that can no longer land is replaced by a new one with a NEW key.
 *
 * The private key is a Node `KeyObject` (Ed25519, kept by OpenSSL, never exported to a JS
 * buffer); only the 32-byte public key leaves this module.
 */
import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto';
import { PublicKey, type Transaction } from '@solana/web3.js';

const PUBLIC_KEY_LENGTH = 32;

export interface EphemeralKey {
  readonly publicKey: PublicKey;
  /** Adds this key's signature to a legacy transaction (its slot must already be required). */
  signTransaction(tx: Transaction): void;
  /** Drops the private key: every later call throws. */
  destroy(): void;
}

export function createEphemeralKey(): EphemeralKey {
  const { privateKey: generated, publicKey: pub } = generateKeyPairSync('ed25519');
  let privateKey: KeyObject | undefined = generated;
  const spki = pub.export({ format: 'der', type: 'spki' });
  const publicKey = new PublicKey(new Uint8Array(spki.subarray(spki.length - PUBLIC_KEY_LENGTH)));
  return {
    publicKey,
    signTransaction(tx) {
      if (!privateKey) throw new Error('one-time key already destroyed');
      const message = tx.serializeMessage();
      const signature = ed25519Sign(null, message, privateKey);
      tx.addSignature(publicKey, signature);
    },
    destroy() {
      privateKey = undefined;
    },
  };
}
