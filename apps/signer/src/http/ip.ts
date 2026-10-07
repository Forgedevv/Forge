import { isIP } from 'node:net';

/*
 * Client IP allowlist (docs/SECURITY.md §6). The signer is reached directly on the private
 * network, so the client IP is the TCP peer address (`socket.remoteAddress`). Proxy headers such
 * as `X-Forwarded-For` are never trusted: anyone can set them.
 *
 * Policy:
 * - a non-empty allowlist: only those exact addresses are accepted;
 * - an empty allowlist in production: every request is denied (fail closed);
 * - an empty allowlist outside production: only loopback addresses are accepted.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** `::ffff:10.0.0.1` (IPv4-mapped IPv6, as reported by dual-stack sockets) -> `10.0.0.1`. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return trimmed;
}

/**
 * Parses `SIGNER_ALLOWED_IPS` (comma separated, exact addresses, no CIDR). Throws on an invalid
 * entry so that a typo cannot silently widen or break the allowlist.
 */
export function parseAllowedIps(value: string | undefined): string[] {
  if (value === undefined) return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.map((entry) => {
    const ip = normalizeIp(entry);
    if (isIP(ip) === 0) throw new Error('SIGNER_ALLOWED_IPS contains an invalid IP address');
    return ip;
  });
}

export interface IpPolicy {
  allowedIps: readonly string[];
  production: boolean;
}

export function createIpFilter(policy: IpPolicy): (remoteAddress: string | undefined) => boolean {
  const allowed = new Set(policy.allowedIps.map(normalizeIp));
  for (const ip of allowed) {
    if (isIP(ip) === 0) throw new Error('allowedIps contains an invalid IP address');
  }
  return (remoteAddress) => {
    if (remoteAddress === undefined) return false;
    const ip = normalizeIp(remoteAddress);
    if (allowed.size > 0) return allowed.has(ip);
    if (policy.production) return false;
    return LOOPBACK.has(ip);
  };
}
