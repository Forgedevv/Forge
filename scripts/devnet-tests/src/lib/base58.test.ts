import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { base58Decode } from './base58.js';

describe('base58Decode', () => {
  it('decodes a public key back to its 32 bytes', () => {
    const key = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
    expect(Buffer.from(base58Decode(key.toBase58()))).toEqual(key.toBuffer());
  });
  it('keeps leading zero bytes', () => {
    expect(Array.from(base58Decode('11'))).toEqual([0, 0]);
    expect(Array.from(base58Decode('1112'))).toEqual([0, 0, 0, 1]);
  });
  it('decodes the system program id to 32 zero bytes', () => {
    expect(Array.from(base58Decode('11111111111111111111111111111111'))).toEqual(
      new Array(32).fill(0),
    );
  });
  it('rejects invalid characters', () => {
    expect(() => base58Decode('0OIl')).toThrow(/Invalid base58/);
  });
});
