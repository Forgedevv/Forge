/**
 * Link targets the library and section components accept. Site code passes them as props, so the
 * builder's scan sees plain strings, not links: the components check every target themselves and
 * drop the ones a site must not link to.
 *
 * Accepted: a path of this site (`/create-pool`, `/#markets`, `#faq`), or an `https://` page on one
 * of the hosts below (social and explorer pages). The list mirrors the scan's navigation hosts
 * (`apps/builder/src/scan/config.ts`, `DEFAULT_LINK_HOSTS`), checked by a builder test.
 */
export const LINK_HOSTS: readonly string[] = [
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

/** Origin used to resolve relative targets; never a real site. */
const BASE = 'https://site.invalid';

/** The link target, normalised, or `undefined` when the component must not link to it. */
export function safeHref(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const value = target.trim();
  if (value === '' || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin === BASE) {
    // An anchor on the current page stays one (`#faq`, not `/#faq`).
    if (value.startsWith('#')) return url.hash || undefined;
    // A path of this site (`//host` and `/\host` resolve to another origin and never reach here),
    // returned normalised, without the placeholder origin: the link cannot leave the site.
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (!LINK_HOSTS.includes(url.hostname)) return undefined;
  return url.href;
}

/** True for a target on another site (opened with `rel="noopener noreferrer"`). */
export function isExternalHref(href: string): boolean {
  return /^https:\/\//.test(href);
}
