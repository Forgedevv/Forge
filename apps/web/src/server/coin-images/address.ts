import { BlockList, isIP } from 'node:net';

/*
 * What the coin image fetcher may connect to. Every URL it requests (the one given by the owner
 * and each redirect target) must pass `checkFetchUrl`, and every address its host resolves to
 * must pass `isPublicAddress`, before any connection is opened.
 */

const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (also used by some cloud metadata endpoints)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/**
 * Special ranges inside 2000::/3 (global unicast). Everything outside 2000::/3 is refused, which
 * covers loopback, unspecified, IPv4-mapped and IPv4-compatible addresses, NAT64 (64:ff9b::/96),
 * ULA (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
 */
const V6_DENY: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['2620:4f:8000::', 48], // AS112
  ['3fff::', 20], // documentation
];

const V6_GLOBAL = new BlockList();
V6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
const DENY = new BlockList();
for (const [address, prefix] of V4_DENY) DENY.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of V6_DENY) DENY.addSubnet(address, prefix, 'ipv6');

/** True only for a public unicast IPv4 or IPv6 address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !DENY.check(ip, 'ipv4');
  if (family === 6) {
    if (!V6_GLOBAL.check(ip, 'ipv6')) return false;
    return !DENY.check(ip, 'ipv6');
  }
  return false;
}

export const MAX_URL_LENGTH = 2048;

const LOCAL_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp|private|arpa|onion)$/;

/**
 * The URL when it may be fetched: https on the default port, no credentials, a DNS host name
 * (never an IP literal, `localhost`, a single label or a local-only suffix). Null otherwise.
 */
export function checkFetchUrl(value: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href.length > MAX_URL_LENGTH) return null;
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || isIP(host) !== 0) return null;
  if (host === 'localhost' || !host.includes('.') || LOCAL_SUFFIX.test(host)) return null;
  // WHATWG parsing already turned numeric hosts (2130706433, 0x7f.1) into dotted IPv4 above.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return url;
}
