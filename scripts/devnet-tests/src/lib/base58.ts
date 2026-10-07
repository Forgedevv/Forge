/** Minimal base58 (Bitcoin alphabet) decoder, used to read inner-instruction data from RPC responses. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  for (const char of input) {
    let carry = INDEX.get(char);
    if (carry === undefined) throw new Error(`Invalid base58 character "${char}"`);
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
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== '1') break;
    leadingZeros++;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  out.set(bytes.reverse(), leadingZeros);
  return out;
}
