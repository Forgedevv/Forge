import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT,
  Envelope,
  MIN_SCRYPT,
  assertCreationParams,
  openEnvelope,
  sealSecret,
} from './envelope.js';
import { isKeystoreError } from './errors.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const passphrase = Buffer.from('correct horse battery staple correct horse battery staple', 'utf8');
const otherPassphrase = Buffer.from(
  'correct horse battery staple correct horse battery stable',
  'utf8',
);
const meta = {
  ref: 'ks_0123456789abcdef0123456789abcdef',
  role: 'payer',
  publicKey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
};

async function sealed() {
  const secret = randomBytes(64);
  const envelope = await sealSecret(secret, passphrase, meta, FAST);
  return { secret, envelope };
}

function flipByte(base64: string, index = 0): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('envelope', () => {
  it('round-trips a 64-byte secret', async () => {
    const { secret, envelope } = await sealed();
    expect(Envelope.safeParse(JSON.parse(JSON.stringify(envelope))).success).toBe(true);
    const opened = await openEnvelope(envelope, passphrase);
    expect(opened.equals(secret)).toBe(true);
  });

  it('never stores the plaintext in any encoding', async () => {
    const { secret, envelope } = await sealed();
    const text = JSON.stringify(envelope);
    expect(text).not.toContain(secret.toString('base64'));
    expect(text).not.toContain(secret.toString('hex'));
    expect(text).not.toContain(secret.subarray(0, 32).toString('base64'));
    expect(text).not.toContain(secret.subarray(0, 32).toString('hex'));
  });

  it('uses a fresh salt and nonce for every key', async () => {
    const a = await sealed();
    const b = await sealed();
    expect(a.envelope.kdf.salt).not.toBe(b.envelope.kdf.salt);
    expect(a.envelope.cipher.nonce).not.toBe(b.envelope.cipher.nonce);
  });

  it('rejects a wrong passphrase', async () => {
    const { envelope } = await sealed();
    await expect(openEnvelope(envelope, otherPassphrase)).rejects.toSatisfy((e) =>
      isKeystoreError(e, 'DECRYPT_FAILED'),
    );
  });

  it('rejects a tampered ciphertext, tag or nonce', async () => {
    const { envelope } = await sealed();
    for (const field of ['ciphertext', 'tag', 'nonce'] as const) {
      const tampered = {
        ...envelope,
        cipher: { ...envelope.cipher, [field]: flipByte(envelope.cipher[field]) },
      };
      await expect(openEnvelope(tampered, passphrase)).rejects.toSatisfy((e) =>
        isKeystoreError(e, 'DECRYPT_FAILED'),
      );
    }
  });

  it('rejects tampered authenticated metadata (ref, role, public key)', async () => {
    const { envelope } = await sealed();
    const cases = [
      { ...envelope, ref: 'ks_ffffffffffffffffffffffffffffffff' },
      { ...envelope, role: 'cashbox' },
      { ...envelope, publicKey: '11111111111111111111111111111111' },
    ];
    for (const tampered of cases) {
      await expect(openEnvelope(tampered, passphrase)).rejects.toSatisfy((e) =>
        isKeystoreError(e, 'DECRYPT_FAILED'),
      );
    }
  });

  it('rejects malformed lengths without trying to decrypt', async () => {
    const { envelope } = await sealed();
    const short = {
      ...envelope,
      cipher: { ...envelope.cipher, ciphertext: Buffer.alloc(10).toString('base64') },
    };
    await expect(openEnvelope(short, passphrase)).rejects.toSatisfy((e) =>
      isKeystoreError(e, 'CORRUPT_FILE'),
    );
  });

  it('refuses to seal anything but a 64-byte secret', async () => {
    await expect(sealSecret(randomBytes(32), passphrase, meta, FAST)).rejects.toSatisfy((e) =>
      isKeystoreError(e, 'INVALID_PARAMS'),
    );
  });

  it('enforces KDF floors on creation only', async () => {
    expect(() => assertCreationParams(DEFAULT_SCRYPT)).not.toThrow();
    expect(() => assertCreationParams(MIN_SCRYPT)).not.toThrow();
    expect(() => assertCreationParams({ N: 1 << 10, r: 8, p: 1 })).toThrow();
    expect(() => assertCreationParams({ N: 1 << 14, r: 4, p: 1 })).toThrow();
    expect(() => assertCreationParams({ N: 12345, r: 8, p: 1 })).toThrow();
    expect(() => assertCreationParams({ N: 1 << 30, r: 8, p: 1 })).toThrow();
  });

  it('defaults to scrypt N=2^17, r=8, p=1 and still opens', { timeout: 60_000 }, async () => {
    const secret = randomBytes(64);
    const envelope = await sealSecret(secret, passphrase, meta);
    expect(envelope.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1, keyLength: 32 });
    expect(envelope.cipher.name).toBe('aes-256-gcm');
    const opened = await openEnvelope(envelope, passphrase);
    expect(opened.equals(secret)).toBe(true);
  });
});
