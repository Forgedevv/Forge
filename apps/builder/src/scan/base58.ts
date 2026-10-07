/**
 * Detection of Solana addresses (base58, 32 to 44 characters) and of their
 * common encodings (base64, hex, byte arrays).
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58 = '1-9A-HJ-NP-Za-km-z';

/** Base58 runs of 32+ characters, not glued to other alphanumerics. */
const BASE58_RUN_RE = new RegExp(`(?<![A-Za-z0-9])[${B58}]{32,}(?![A-Za-z0-9])`, 'g');

/** Plain camelCase / PascalCase words (e.g. a long component name), exempted when they are identifiers. */
const CAMEL_WORDS_RE = /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)*$/;

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] ?? 0];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error('invalid base58 character');
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export interface Base58Hit {
  value: string;
  index: number;
}

/**
 * Finds base58 runs of 32+ characters. Runs over 44 characters are reported too
 * (they may embed an address that gets sliced out, or a secret key).
 */
export function findBase58Runs(text: string, exemptIdentifiers?: ReadonlySet<string>): Base58Hit[] {
  const hits: Base58Hit[] = [];
  for (const m of text.matchAll(BASE58_RUN_RE)) {
    const value = m[0];
    if (exemptIdentifiers?.has(value) && CAMEL_WORDS_RE.test(value)) continue;
    hits.push({ value, index: m.index ?? 0 });
  }
  return hits;
}

export function isCamelWords(value: string): boolean {
  return CAMEL_WORDS_RE.test(value);
}

function decodeBase64(token: string): Uint8Array | null {
  const std = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (std.length % 4 === 1) return null;
  try {
    return new Uint8Array(Buffer.from(std, 'base64'));
  } catch {
    return null;
  }
}

function isPrintable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const b of bytes) {
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) return false;
  }
  return true;
}

export interface EncodedHit {
  /** Address (base58) hidden in the encoded token. */
  address: string;
  index: number;
  encoding: 'base64' | 'hex';
}

/**
 * Looks for addresses hidden in base64 or hex tokens: a token decoding to
 * exactly 32 or 64 bytes (raw public / secret key), or to text containing a
 * base58 address.
 */
export function findEncodedAddresses(text: string): EncodedHit[] {
  const hits: EncodedHit[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const token = m[0];
    const index = m.index ?? 0;
    // Plain words and camelCase identifiers are not encoded data.
    if (CAMEL_WORDS_RE.test(token)) continue;
    if (/^[0-9a-fA-F]+$/.test(token)) {
      if (token.length === 64 || token.length === 128) {
        hits.push({ address: base58Encode(new Uint8Array(Buffer.from(token, 'hex'))), index, encoding: 'hex' });
      }
      continue;
    }
    const bytes = decodeBase64(token);
    if (!bytes) continue;
    if (bytes.length === 32 || bytes.length === 64) {
      hits.push({ address: base58Encode(bytes), index, encoding: 'base64' });
      continue;
    }
    if (isPrintable(bytes)) {
      const decoded = Buffer.from(bytes).toString('latin1');
      for (const run of findBase58Runs(decoded)) hits.push({ address: run.value, index, encoding: 'base64' });
    }
  }
  return hits;
}

/** A byte array literal of 32 or 64 bytes is a raw public or secret key. */
export function bytesToAddress(values: readonly number[]): string | null {
  if (values.length !== 32 && values.length !== 64) return null;
  if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  return base58Encode(Uint8Array.from(values));
}
