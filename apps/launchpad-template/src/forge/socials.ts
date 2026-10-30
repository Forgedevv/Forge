/**
 * LOCKED ZONE. The X (Twitter) link of a coin. Pure functions, used by the creation form
 * (`create/validation.ts`), the server of `/api/upload` (`create/prepare-handler.ts`), the
 * on-chain data fallback (`data/onchain/service.ts`) and the link shown on the coin page
 * (`CoinXLink.tsx`).
 *
 * One canonical form, `https://x.com/<handle>` (handle: 1 to 15 letters, digits or `_`). It is
 * what the wallet signs, what FORGE writes into the metadata JSON as `"twitter"` (the key Jupiter
 * and pump-style indexers read) and the only value ever rendered as a link. The FORGE upload
 * endpoint (apps/web `src/server/uploads/contract.ts`) checks the same pattern again.
 */

export const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
/** The canonical X link, exactly. */
export const X_URL_PATTERN = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/;
/** Longest input the form accepts before parsing it. */
export const X_INPUT_MAX = 200;

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

/** X paths that look like a handle but are pages of X itself. */
const X_RESERVED_PATHS = new Set([
  'home',
  'explore',
  'search',
  'notifications',
  'messages',
  'settings',
  'i',
  'intent',
  'share',
  'login',
  'signup',
  'tos',
  'privacy',
]);

/** The value when it is exactly a canonical X link, else null. Never normalises. */
export function canonicalXUrl(value: unknown): string | null {
  return typeof value === 'string' && X_URL_PATTERN.test(value) ? value : null;
}

/** The handle of a canonical X link (`forge` for `https://x.com/forge`), else null. */
export function xHandle(value: unknown): string | null {
  const url = canonicalXUrl(value);
  return url ? url.slice('https://x.com/'.length) : null;
}

export type XLinkInput = { ok: true; url: string | null } | { ok: false };

/**
 * What a visitor typed in the X field: empty (no link), a handle (`forge`, `@forge`) or a profile
 * link on x.com or twitter.com (with or without `https://`, `www.`, a trailing slash or a query),
 * normalised to `https://x.com/<handle>`. Anything else (another site, a post link, a handle that
 * X would refuse) is `{ ok: false }`.
 */
export function parseXLink(raw: string): XLinkInput {
  const value = raw.trim();
  if (value === '') return { ok: true, url: null };
  if (value.length > X_INPUT_MAX) return { ok: false };

  const bare = value.startsWith('@') ? value.slice(1) : value;
  if (X_HANDLE_PATTERN.test(bare)) {
    return X_RESERVED_PATHS.has(bare.toLowerCase())
      ? { ok: false }
      : { ok: true, url: `https://x.com/${bare}` };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false };
  if (url.username || url.password || url.port || !X_HOSTS.has(url.hostname)) return { ok: false };
  const handle = url.pathname.replace(/^\/|\/$/g, '');
  if (!X_HANDLE_PATTERN.test(handle) || X_RESERVED_PATHS.has(handle.toLowerCase())) {
    return { ok: false };
  }
  return { ok: true, url: `https://x.com/${handle}` };
}

/**
 * Another social link of a coin (website, Telegram) from the data API, which this site does not
 * control: the URL when it is https without credentials, else null. Never a `javascript:` or
 * `data:` link in an `href`.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > X_INPUT_MAX * 10) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href;
}
