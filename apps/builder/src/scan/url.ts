import { hostMatches, type ResolvedConfig } from './config.js';
import type { RuleId } from './types.js';

/** Placeholder origin standing for "the site's own origin" (`location.origin` etc.). */
export const SELF_ORIGIN = 'https://forge-self-origin.invalid';
const SELF_HOST = 'forge-self-origin.invalid';

/** A URL as far as static analysis can tell: its known prefix, and whether that prefix is the whole value. */
export interface UrlCandidate {
  text: string;
  complete: boolean;
}

/** `network`: fetch, scripts, sockets... `navigation`: redirects and window.open (link hosts allowed too). */
export type UrlKind = 'network' | 'navigation';

export type UrlVerdict = { ok: true } | { ok: false; rule: RuleId; reason: string };

const OK: UrlVerdict = { ok: true };
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SCHEME_CHARS_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

/** Mirrors what URL parsers do: tab/newline removed anywhere, C0 controls and spaces trimmed at the start. */
export function normalizeUrlText(text: string, complete: boolean): string {
  // eslint-disable-next-line no-control-regex
  let t = text.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  // eslint-disable-next-line no-control-regex
  if (complete) t = t.replace(/[\u0000-\u0020]+$/, '');
  return t;
}

/** True if a (decoded) string is a `javascript:` / `vbscript:` URL. */
export function isScriptUrl(text: string): boolean {
  return /^(?:javascript|vbscript|livescript):/i.test(normalizeUrlText(text, true));
}

function dynamicVerdict(kind: UrlKind, text: string): UrlVerdict {
  const shown = text.length > 0 ? `"${truncate(text)}..."` : 'a dynamic value';
  return kind === 'network'
    ? {
        ok: false,
        rule: 'network-dynamic-url',
        reason: `URL origin cannot be determined statically (${shown})`,
      }
    : {
        ok: false,
        rule: 'navigation-external',
        reason: `navigation target cannot be determined statically (${shown})`,
      };
}

export function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

function checkParsed(
  url: URL,
  kind: UrlKind,
  config: ResolvedConfig,
  original: string,
): UrlVerdict {
  const host = url.hostname.toLowerCase();
  if (host === SELF_HOST) return OK;
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      rule: kind === 'network' ? 'network-domain' : 'navigation-external',
      reason: `URL with credentials: "${truncate(original)}"`,
    };
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const allowed =
    hostMatches(host, config.allowedHosts) ||
    (kind === 'navigation' && hostMatches(host, config.linkHosts));
  if (!allowed) {
    return {
      ok: false,
      rule: kind === 'network' ? 'network-domain' : 'navigation-external',
      reason: `host "${host}" is not in the allowlist`,
    };
  }
  if (!secure) {
    return {
      ok: false,
      rule: kind === 'network' ? 'network-domain' : 'navigation-external',
      reason: `insecure scheme for "${host}"`,
    };
  }
  return OK;
}

function checkComplete(raw: string, kind: UrlKind, config: ResolvedConfig): UrlVerdict {
  const t = normalizeUrlText(raw, true);
  const scheme = SCHEME_RE.exec(t)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript') {
      return { ok: false, rule: 'javascript-url', reason: 'javascript: URL' };
    }
    if (kind === 'navigation' && (scheme === 'mailto' || scheme === 'tel' || scheme === 'sms'))
      return OK;
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) {
      return {
        ok: false,
        rule: kind === 'network' ? 'network-domain' : 'navigation-external',
        reason: `scheme "${scheme}:" is not allowed`,
      };
    }
  }
  let url: URL;
  try {
    url = new URL(t, `${SELF_ORIGIN}/`);
  } catch {
    return {
      ok: false,
      rule: kind === 'network' ? 'network-domain' : 'navigation-external',
      reason: `unparsable URL "${truncate(t)}"`,
    };
  }
  return checkParsed(url, kind, config, t);
}

/** Classifies a URL candidate. A partial prefix is accepted only if it fixes the origin. */
export function checkUrl(
  candidate: UrlCandidate,
  kind: UrlKind,
  config: ResolvedConfig,
): UrlVerdict {
  if (candidate.complete) return checkComplete(candidate.text, kind, config);

  const p = normalizeUrlText(candidate.text, false);
  const schemeMatch = SCHEME_RE.exec(p);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript') {
      return { ok: false, rule: 'javascript-url', reason: 'javascript: URL' };
    }
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) {
      if (kind === 'navigation' && (scheme === 'mailto' || scheme === 'tel' || scheme === 'sms'))
        return OK;
      return dynamicVerdict(kind, p);
    }
    const rest = p.slice(schemeMatch[0].length).replace(/^[/\\]+/, '');
    const end = rest.search(/[/\\?#]/);
    if (end < 0) return dynamicVerdict(kind, p);
    return checkComplete(`${scheme}://${rest.slice(0, end)}/`, kind, config);
  }
  if (p.startsWith('/') || p.startsWith('\\')) {
    const second = p[1];
    if (second === undefined) return dynamicVerdict(kind, p);
    if (second === '/' || second === '\\') {
      // Protocol-relative: the host must be terminated.
      const rest = p.replace(/^[/\\]+/, '');
      const end = rest.search(/[/\\?#]/);
      if (end < 0) return dynamicVerdict(kind, p);
      return checkComplete(`https://${rest.slice(0, end)}/`, kind, config);
    }
    return OK; // "/path..." stays on the same origin
  }
  if (p.length === 0) return dynamicVerdict(kind, p);
  // A prefix made only of scheme characters may still become "evil:" or "https:".
  if (SCHEME_CHARS_RE.test(p)) return dynamicVerdict(kind, p);
  return OK; // relative path such as "api/x" or "./x"
}
