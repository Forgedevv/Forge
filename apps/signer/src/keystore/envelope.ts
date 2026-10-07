/**
 * Encrypted envelope: the on-disk format of one key.
 *
 * - KDF: scrypt (Node built-in), per-key random 32-byte salt. Defaults N = 2^17, r = 8,
 *   p = 1 (128 MiB, roughly 0.3-0.6 s per derivation on a modern server), the OWASP
 *   recommended minimum for scrypt. The parameters are stored in the file so they can be
 *   raised later without breaking existing keys.
 * - Cipher: AES-256-GCM, per-key random 96-bit nonce, 128-bit tag. The public metadata
 *   (version, ref, role, public key) is bound as additional authenticated data, so
 *   changing any of it invalidates the tag.
 * - Plaintext: the 64-byte Solana secret key (seed || public key).
 *
 * Nothing in this module logs. Errors carry static messages only.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { z } from 'zod';
import { KeystoreError, wrapError } from './errors.js';
import { REF_RE } from './roles.js';

function scrypt(
  passphrase: Buffer,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export const ENVELOPE_VERSION = 1;
export const KDF_NAME = 'scrypt';
export const CIPHER_NAME = 'aes-256-gcm';
export const AES_KEY_LENGTH = 32;
export const SALT_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const SOLANA_SECRET_KEY_LENGTH = 64;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Parameters used to create new keys. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

/**
 * Floors applied when creating keys. They are NOT applied when reading: a key written
 * with older (weaker) parameters must always stay readable, or funds are lost.
 */
export const MIN_SCRYPT: ScryptParams = { N: 1 << 14, r: 8, p: 1 };

/** Memory ceiling accepted when reading a file (bounds a tampered file's cost): 1 GiB. */
const MAX_SCRYPT_MEMORY_BYTES = 1024 * 1024 * 1024;

/** Public metadata bound into the GCM additional authenticated data. */
export interface EnvelopeMeta {
  ref: string;
  role: string;
  /** Base58 Solana public key. */
  publicKey: string;
}

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const Base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const Envelope = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    ref: z.string().regex(REF_RE),
    role: z.string().min(1).max(64),
    publicKey: Base58Address,
    createdAt: z.iso.datetime(),
    kdf: z
      .object({
        name: z.literal(KDF_NAME),
        N: z.number().int().positive(),
        r: z.number().int().positive(),
        p: z.number().int().positive(),
        salt: Base64,
        keyLength: z.literal(AES_KEY_LENGTH),
      })
      .strict(),
    cipher: z
      .object({
        name: z.literal(CIPHER_NAME),
        nonce: Base64,
        tag: Base64,
        ciphertext: Base64,
      })
      .strict(),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** Checks parameters used to create keys against the floors. */
export function assertCreationParams(params: ScryptParams): void {
  const ok =
    isPowerOfTwo(params.N) &&
    params.N >= MIN_SCRYPT.N &&
    Number.isInteger(params.r) &&
    params.r >= MIN_SCRYPT.r &&
    Number.isInteger(params.p) &&
    params.p >= MIN_SCRYPT.p &&
    scryptMemoryBytes(params) <= MAX_SCRYPT_MEMORY_BYTES;
  if (!ok) throw new KeystoreError('INVALID_PARAMS');
}

function scryptMemoryBytes(params: ScryptParams): number {
  return 128 * params.N * params.r;
}

function envelopeAad(meta: EnvelopeMeta): Buffer {
  // Fixed layout; the fields themselves cannot contain '\n' (ref/publicKey are validated,
  // role is validated by the caller) so the encoding is unambiguous.
  return Buffer.from(
    `forge-keystore/v${ENVELOPE_VERSION}\n${meta.ref}\n${meta.role}\n${meta.publicKey}\n`,
    'utf8',
  );
}

async function deriveKey(passphrase: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  if (!isPowerOfTwo(params.N) || scryptMemoryBytes(params) > MAX_SCRYPT_MEMORY_BYTES) {
    throw new KeystoreError('CORRUPT_FILE');
  }
  try {
    return await scrypt(passphrase, salt, AES_KEY_LENGTH, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: scryptMemoryBytes(params) * 2,
    });
  } catch (err) {
    throw wrapError(err, 'CORRUPT_FILE');
  }
}

/**
 * Encrypts a 64-byte Solana secret key. The caller keeps ownership of `secret` and must
 * zero it afterwards. `passphrase` is used as-is (UTF-8 bytes), never trimmed or normalized.
 */
export async function sealSecret(
  secret: Uint8Array,
  passphrase: Buffer,
  meta: EnvelopeMeta,
  params: ScryptParams = DEFAULT_SCRYPT,
  now: Date = new Date(),
): Promise<Envelope> {
  if (secret.length !== SOLANA_SECRET_KEY_LENGTH) throw new KeystoreError('INVALID_PARAMS');
  assertCreationParams(params);

  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = await deriveKey(passphrase, salt, params);
  try {
    const cipher = createCipheriv(CIPHER_NAME, key, nonce, { authTagLength: TAG_LENGTH });
    cipher.setAAD(envelopeAad(meta));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: ENVELOPE_VERSION,
      ref: meta.ref,
      role: meta.role,
      publicKey: meta.publicKey,
      createdAt: now.toISOString(),
      kdf: {
        name: KDF_NAME,
        N: params.N,
        r: params.r,
        p: params.p,
        salt: salt.toString('base64'),
        keyLength: AES_KEY_LENGTH,
      },
      cipher: {
        name: CIPHER_NAME,
        nonce: nonce.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypts an envelope. Returns the 64-byte secret key in a fresh Buffer that the caller
 * MUST zero (`fill(0)`) as soon as it is no longer needed. A wrong passphrase, a modified
 * ciphertext or modified metadata all fail with DECRYPT_FAILED (GCM authentication).
 */
export async function openEnvelope(envelope: Envelope, passphrase: Buffer): Promise<Buffer> {
  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  const nonce = Buffer.from(envelope.cipher.nonce, 'base64');
  const tag = Buffer.from(envelope.cipher.tag, 'base64');
  const ciphertext = Buffer.from(envelope.cipher.ciphertext, 'base64');
  if (
    salt.length !== SALT_LENGTH ||
    nonce.length !== NONCE_LENGTH ||
    tag.length !== TAG_LENGTH ||
    ciphertext.length !== SOLANA_SECRET_KEY_LENGTH
  ) {
    throw new KeystoreError('CORRUPT_FILE');
  }

  const key = await deriveKey(passphrase, salt, envelope.kdf);
  let head: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CIPHER_NAME, key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAAD(envelopeAad(envelope));
    decipher.setAuthTag(tag);
    head = decipher.update(ciphertext);
    tail = decipher.final(); // throws on authentication failure
    if (head.length + tail.length !== SOLANA_SECRET_KEY_LENGTH) {
      throw new KeystoreError('CORRUPT_FILE');
    }
    const secret = Buffer.alloc(SOLANA_SECRET_KEY_LENGTH);
    head.copy(secret, 0);
    tail.copy(secret, head.length);
    return secret;
  } catch (err) {
    throw wrapError(err, 'DECRYPT_FAILED');
  } finally {
    key.fill(0);
    head?.fill(0);
    tail?.fill(0);
  }
}
