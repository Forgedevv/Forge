import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

/* Shared fixtures of the relay tests (no network). */

export const PK = new PublicKey('11111111111111111111111111111111').toBase58();
export const PK2 = Keypair.generate().publicKey.toBase58();
export const SIG = '5'.repeat(88);
/** Placeholder provider key used by every test (never a real one). */
export const FAKE_KEY = 'fake-helius-key-0123456789abcdef';
export const UPSTREAM_URL = `https://devnet.helius-rpc.com/?api-key=${FAKE_KEY}`;
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** A small, valid, signed legacy transaction, base64. */
export function smallTransactionBase64(): string {
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: DEVNET_GENESIS,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  tx.sign(payer);
  return tx.serialize().toString('base64');
}

/** Base64 of `bytes` zero bytes. */
export function base64OfSize(bytes: number): string {
  return Buffer.alloc(bytes).toString('base64');
}

export function call(method: string, params?: unknown, id: string | number | null = 1) {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}
