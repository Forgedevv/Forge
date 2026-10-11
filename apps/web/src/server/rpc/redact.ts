/*
 * Secret detection for upstream answers. RPC_URL carries the provider key, either as a query
 * value (`?api-key=...`, Helius), as userinfo, or as a path segment (`/<token>/`, other providers).
 * Any upstream body containing one of these fragments is never forwarded (handler.ts answers a
 * generic upstream error instead).
 */

/** Shorter fragments are too generic to be a credential (and could match legitimate data). */
const MIN_FRAGMENT_LENGTH = 8;
/** Path segments shorter than this are route names (`/rpc`, `/v1`), not tokens. */
const MIN_PATH_TOKEN_LENGTH = 16;

function variants(value: string): string[] {
  const out = new Set<string>([value]);
  try {
    out.add(decodeURIComponent(value));
  } catch {
    // keep the raw value only
  }
  out.add(encodeURIComponent(value));
  // JSON string form (escaped characters), as it would appear inside a JSON body.
  out.add(JSON.stringify(value).slice(1, -1));
  return [...out];
}

/** Fragments of the upstream URL that must never leave the server. */
export function secretFragments(upstreamUrl: string): string[] {
  const fragments = new Set<string>();
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    return [upstreamUrl];
  }
  const add = (value: string, min = MIN_FRAGMENT_LENGTH) => {
    if (value.length < min) return;
    for (const v of variants(value)) if (v.length >= min) fragments.add(v);
  };
  // Raw query values as written in RPC_URL (URLSearchParams would turn `+` into a space), plus
  // their form-decoded value.
  for (const pair of url.search.replace(/^\?/, '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const raw = pair.slice(eq + 1);
    add(raw);
    add(new URLSearchParams(`v=${raw}`).get('v') ?? raw);
  }
  if (url.username) add(url.username, 4);
  if (url.password) add(url.password, 4);
  for (const segment of url.pathname.split('/')) add(segment, MIN_PATH_TOKEN_LENGTH);
  if (url.search || url.username || url.password || fragments.size > 0) {
    // The full URL too (only meaningful when it carries a credential).
    add(upstreamUrl);
  }
  return [...fragments];
}

export function containsSecret(text: string, fragments: readonly string[]): boolean {
  for (const fragment of fragments) {
    if (fragment && text.includes(fragment)) return true;
  }
  return false;
}
