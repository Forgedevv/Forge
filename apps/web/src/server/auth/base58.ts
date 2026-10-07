/*
 * Minimal Bitcoin-alphabet base58 codec (the encoding used by Solana for public keys and
 * signatures). Kept local to avoid relying on a transitive dependency.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((char, i) => [char, i]));

/** Decodes a base58 string. Returns null on any invalid character or empty input. */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === '1') leadingZeros++;

  // Little-endian base-256 accumulator.
  const bytes: number[] = [];
  for (const char of input) {
    const value = INDEX.get(char);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

/** Decodes a base58 string that must decode to exactly `length` bytes. */
export function base58DecodeExact(input: string, length: number): Uint8Array | null {
  const bytes = base58Decode(input);
  return bytes !== null && bytes.length === length ? bytes : null;
}

export function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  // Little-endian base-58 accumulator.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
