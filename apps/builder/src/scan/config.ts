import type { ScanOptions } from './types.js';

/**
 * Default hosts client code may contact. Only first-party hosts: shared-tenant
 * domains (`*.vercel.app`, `*.r2.dev`, `*.github.io`...) are never wildcarded,
 * since anyone can host content there.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  // Jupiter (plugin, data API, trench stream, swap APIs)
  'jup.ag',
  '*.jup.ag',
  // Vercel first-party scripts (analytics, speed insights, toolbar)
  'va.vercel-scripts.com',
  'vitals.vercel-insights.com',
  'vercel.live',
];

/** Default navigation-only hosts (social links, explorers). Not usable for fetch or scripts. */
export const DEFAULT_LINK_HOSTS: readonly string[] = [
  'x.com',
  'twitter.com',
  't.me',
  'telegram.me',
  'discord.gg',
  'discord.com',
  'github.com',
  'youtube.com',
  'www.youtube.com',
  'instagram.com',
  'www.instagram.com',
  'tiktok.com',
  'www.tiktok.com',
  'solscan.io',
  'explorer.solana.com',
  'birdeye.so',
  'dexscreener.com',
];

export interface ResolvedConfig {
  allowedHosts: readonly string[];
  linkHosts: readonly string[];
  addressAllowlist: ReadonlySet<string>;
  maxTextBytes: number;
  maxBinaryBytes: number;
}

function normalizeHostPattern(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed.includes('://')) {
    // Accept a full URL for convenience (e.g. the RPC relay URL).
    return new URL(trimmed).hostname;
  }
  return trimmed;
}

export function resolveConfig(options: ScanOptions = {}): ResolvedConfig {
  const hosts = [
    ...(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS),
    ...(options.extraAllowedHosts ?? []),
  ];
  if (options.rpcRelayHost) hosts.push(options.rpcRelayHost);
  if (options.r2PublicHost) hosts.push(options.r2PublicHost);
  return {
    allowedHosts: hosts.map(normalizeHostPattern).filter((h) => h.length > 0),
    linkHosts: (options.linkHosts ?? DEFAULT_LINK_HOSTS).map(normalizeHostPattern),
    addressAllowlist: new Set(options.addressAllowlist ?? []),
    maxTextBytes: options.maxTextBytes ?? 512 * 1024,
    maxBinaryBytes: options.maxBinaryBytes ?? 5 * 1024 * 1024,
  };
}

export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.length === 0) return false;
  for (const p of patterns) {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}
