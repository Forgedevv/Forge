import { isIP } from 'node:net';

/*
 * Client IP for rate-limit keys (chat, spec confirmation, payment, gating, upload and RPC relay
 * routes). Never used for anything but a counter key.
 *
 * Trust model: the app runs behind one trusted proxy (Vercel). In order of preference:
 *  1. `x-vercel-forwarded-for`: set by the Vercel edge to the address it received the connection
 *     from; a value sent by the client is overwritten.
 *  2. `x-real-ip`: also set by the platform proxy.
 *  3. The LAST `x-forwarded-for` entry: a client can put anything at the start of this header, but
 *     each proxy APPENDS the address it saw, so the last entry is the one written by the proxy in
 *     front of the app. (The first entry, used before, was spoofable behind an appending proxy.)
 * Values that are not an IP address are ignored. Falls back to "unknown" (one shared bucket, so a
 * missing header never disables the per-IP limit).
 *
 * IPv6 clients are bucketed by /64: one subscriber line usually gets a whole /64, so keying on the
 * full address would let a single client rotate through 2^64 buckets. IPv4-mapped IPv6 addresses
 * (`::ffff:203.0.113.7`) count as their IPv4 address.
 */

const MAX_IP_CHARS = 45;

/** Eight 16-bit groups of an address already validated as IPv6 by `isIP`, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  // Embedded IPv4 in the last 32 bits (`::ffff:1.2.3.4`): rewrite it as two hex groups.
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    if (isIP(last) !== 4) return null;
    const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number];
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex(a, b)}:${hex(c, d)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length;
  if (halves.length === 1) return known === 8 ? head : null;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

/** Rate-limit key of one address: the IPv4 address itself, or the IPv6 /64 prefix. */
export function ipBucket(address: string): string | null {
  const value = address.trim();
  if (value.length === 0 || value.length > MAX_IP_CHARS) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const groups = ipv6Groups(value);
  if (groups === null) return null;
  // IPv4-mapped: ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6] ?? 0, groups[7] ?? 0];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

function clean(value: string | undefined | null): string | null {
  return value ? ipBucket(value) : null;
}

export function clientIp(request: Request): string {
  const h = request.headers;
  const platform =
    clean(h.get('x-vercel-forwarded-for')?.split(',')[0]) ?? clean(h.get('x-real-ip'));
  if (platform) return platform;
  const forwarded = h.get('x-forwarded-for')?.split(',');
  return clean(forwarded?.[forwarded.length - 1]) ?? 'unknown';
}
