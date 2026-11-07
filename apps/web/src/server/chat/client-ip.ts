import { isIP } from 'node:net';

/*
 * Client IP for rate-limit keys (chat, spec confirmation, payment, gating, upload and RPC relay
 * routes). Never used for anything but a counter key.
 *
 * Trust model: the app runs behind one trusted proxy, named by `FORGE_TRUSTED_PROXY`:
 *
 * `cloudflare` (the app behind a Cloudflare tunnel, listening on 127.0.0.1 only): `cf-connecting-ip`
 * only. Cloudflare's edge sets it to the address it received the connection from and drops any
 * value sent by the client; every other header (`x-vercel-forwarded-for`, `x-real-ip`,
 * `x-forwarded-for`) reaches the app as the client wrote it, so none of them is read.
 *
 * `vercel` (unset, the default): in order of preference:
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

export type TrustedProxy = 'vercel' | 'cloudflare';

/**
 * The proxy in front of the app (`FORGE_TRUSTED_PROXY`). Unset or `vercel`: Vercel. Any other value
 * reads as `cloudflare`, so a typo fails closed: behind Vercel, `cf-connecting-ip` is absent and
 * every client shares the "unknown" bucket (strict limits), instead of trusting spoofable headers
 * behind Cloudflare.
 */
export function trustedProxy(env: Record<string, string | undefined> = process.env): TrustedProxy {
  const value = env.FORGE_TRUSTED_PROXY?.trim().toLowerCase();
  return !value || value === 'vercel' ? 'vercel' : 'cloudflare';
}

export function clientIp(request: Request, proxy: TrustedProxy = trustedProxy()): string {
  const h = request.headers;
  if (proxy === 'cloudflare') return clean(h.get('cf-connecting-ip')) ?? 'unknown';
  const platform =
    clean(h.get('x-vercel-forwarded-for')?.split(',')[0]) ?? clean(h.get('x-real-ip'));
  if (platform) return platform;
  const forwarded = h.get('x-forwarded-for')?.split(',');
  return clean(forwarded?.[forwarded.length - 1]) ?? 'unknown';
}
