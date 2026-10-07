/**
 * Text-level checks shared by every text file (code, CSS, Markdown, JSON, SVG):
 * Solana addresses, javascript: URLs, hidden Unicode, active HTML content.
 */

import { bytesToAddress, findBase58Fragments, findBase58Runs, findEncodedAddresses, isBase58Only, isCamelWords, looksRandomBase58 } from './base58.js';
import { hostMatches, type ResolvedConfig } from './config.js';
import { checkUrl, truncate } from './url.js';
import type { Finding, RuleId } from './types.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  sol: '/',
  bsol: '\\',
  period: '.',
  comma: ',',
  lpar: '(',
  rpar: ')',
  num: '#',
  excl: '!',
  quest: '?',
  equals: '=',
  tab: '\t',
  newline: '\n',
  shy: '\u00ad',
  zwj: '\u200d',
  zwnj: '\u200c',
};

/** Decodes HTML character references (numeric and the common named ones). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Decodes JS escapes (`\uXXXX`, `\u{...}`, `\xXX`) found in source text. */
export function decodeJsEscapes(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m, a?: string, b?: string, c?: string) => {
    const cp = parseInt(a ?? b ?? c ?? '', 16);
    return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Decodes CSS escapes (`\75 rl(`, `\:`). */
export function decodeCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n0-9a-fA-F])/g, (m, hex?: string, ch?: string) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ch ?? m;
  });
}

const INVISIBLE_RE = new RegExp(
  '[\\u00ad\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufeff\\uffa0]|\\u034f|\\u17b4|\\u17b5',
  'g',
);

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function lineOfValue(text: string, value: string): number {
  const i = text.indexOf(value);
  if (i >= 0) return lineAt(text, i);
  const j = text.indexOf(value.slice(0, 8));
  return j >= 0 ? lineAt(text, j) : 1;
}

/** Shared helper to collect address findings, honoring the allowlist. */
export class AddressCollector {
  readonly findings: Finding[] = [];
  constructor(
    private readonly text: string,
    private readonly config: ResolvedConfig,
  ) {}

  run(variant: string, source: string, line?: number, exempt?: ReadonlySet<string>): void {
    for (const hit of findBase58Runs(source, exempt)) {
      if (this.config.addressAllowlist.has(hit.value)) continue;
      const long = hit.value.length > 44;
      this.findings.push({
        rule: 'solana-address',
        key: `addr:${variant}:${hit.value}`,
        line: line ?? (source === this.text ? lineAt(this.text, hit.index) : lineOfValue(this.text, hit.value)),
        reason: long
          ? `long base58 string added (may embed an address or a key): ${truncate(hit.value, 20)}`
          : `Solana address added: ${hit.value}`,
      });
    }
  }

  encoded(variant: string, source: string, line?: number): void {
    for (const hit of findEncodedAddresses(source)) {
      if (this.config.addressAllowlist.has(hit.address)) continue;
      this.findings.push({
        rule: 'solana-address-encoded',
        key: `addr-enc:${variant}:${hit.address}`,
        line: line ?? lineAt(source === this.text ? this.text : '', hit.index),
        reason: `${hit.encoding}-encoded Solana address or key added (${hit.address})`,
      });
    }
  }

  bytes(values: readonly number[], line: number): void {
    const address = bytesToAddress(values);
    if (address === null || this.config.addressAllowlist.has(address)) return;
    this.findings.push({
      rule: 'solana-address-encoded',
      key: `addr-bytes:${address}`,
      line,
      reason: `byte array of ${values.length} bytes added (raw Solana key: ${address})`,
    });
  }

  /**
   * Pieces of an address split to stay under 32 characters: a random-looking
   * base58 run of 16 to 31 characters standing on its own.
   */
  fragments(variant: string, source: string, line?: number): void {
    for (const hit of findBase58Fragments(source)) {
      if ([...this.config.addressAllowlist].some((a) => a.includes(hit.value))) continue;
      this.findings.push({
        rule: 'solana-address',
        key: `addr-frag:${variant}:${hit.value}`,
        line: line ?? lineOfValue(this.text, hit.value),
        reason: `piece of a possible Solana address added: ${hit.value}`,
      });
    }
  }

  /**
   * Consecutive values (string literals, JSON strings) glued together: an
   * address split into short pieces that are joined at runtime.
   */
  joined(variant: string, parts: readonly (string | null)[], line?: number): void {
    let current = '';
    const flush = (): void => {
      if (current.length >= 32 && current.length <= 400 && !isCamelWords(current) && /[0-9]/.test(current) && /[A-Z]/.test(current) && /[a-z]/.test(current)) {
        this.run(variant, current, line);
      }
      current = '';
    };
    for (const p of parts) {
      // Values of 32+ characters are checked on their own: they only separate pieces here.
      if (p !== null && p.length > 0 && p.length < 32 && isBase58Only(p)) current += p;
      else flush();
    }
    flush();
  }

  /** Markdown and plain text: inline markup removed (emphasis, code, tags, comments), then addresses and pieces. */
  markup(): void {
    const t = stripInvisible(decodeEntities(this.text));
    const stripped = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/[*_`~\\]/g, '');
    for (const hit of findBase58Runs(stripped)) {
      if (!isCamelWords(hit.value)) this.run('markup', hit.value);
    }
    // Pieces: URLs removed first (random-looking file names are not addresses).
    this.fragments('markup', stripped.replace(/\]\([^)]*\)/g, '] ').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' '));
  }

  /** JSON: string values glued in document order, and pieces standing alone. */
  jsonValues(values: readonly string[]): void {
    this.joined('json', values);
    for (const v of values) if (looksRandomBase58(v.trim())) this.fragments('json', v.trim());
  }

  /** Raw text plus decoded variants (escapes/entities, invisible characters removed). */
  textVariants(exempt?: ReadonlySet<string>): void {
    const t = this.text;
    this.run('raw', t, undefined, exempt);
    const decoded = decodeEntities(decodeJsEscapes(t));
    if (decoded !== t) this.run('decoded', decoded, undefined, exempt);
    const visible = stripInvisible(decoded);
    if (visible !== decoded) this.run('visible', visible, undefined, exempt);
    this.encoded('raw', stripDataImages(t));
  }
}

/** Removes base64 payloads of image/font data URIs (binary noise for address detection). */
function stripDataImages(text: string): string {
  return text.replace(/data:(?:image|font|application\/font-[a-z]+|application\/x-font-[a-z]+)\/?[a-z0-9.+-]*;base64,[A-Za-z0-9+/=]+/gi, 'data:');
}

/** javascript: URLs anywhere in the text (after decoding escapes and entities). */
export function scriptUrlFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const decoded = decodeEntities(decodeJsEscapes(decodeCssEscapes(text)));
  // eslint-disable-next-line no-control-regex
  const normalized = decoded.replace(/[\t\n\r\u0000]/g, '');
  const re = /(?:java|vb|live)script\s*:/gi;
  for (const m of normalized.matchAll(re)) {
    const context = normalized.slice(m.index ?? 0, (m.index ?? 0) + 40);
    out.push({ rule: 'javascript-url', key: `jsurl:${context}`, line: lineOfValue(text, 'script') || 1, reason: 'javascript: URL' });
  }
  return out;
}

const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ZERO_WIDTH_RE = /[\u00ad\u200b\u200c\u2060-\u2064\ufeff]/g;

/** Bidi controls anywhere; zero-width characters too in code (they can hide content). */
export function hiddenUnicodeFindings(text: string, code: boolean): Finding[] {
  const out: Finding[] = [];
  const body = text.startsWith('\ufeff') ? text.slice(1) : text;
  const offset = text.length - body.length;
  for (const re of code ? [BIDI_RE, ZERO_WIDTH_RE] : [BIDI_RE]) {
    for (const m of body.matchAll(re)) {
      const idx = (m.index ?? 0) + offset;
      const cp = (m[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0');
      out.push({
        rule: 'hidden-unicode',
        key: `unicode:${cp}:${text.slice(Math.max(0, idx - 15), idx + 15)}`,
        line: lineAt(text, idx),
        reason: `hidden Unicode control character U+${cp.toUpperCase()}`,
      });
    }
  }
  return out;
}

const ACTIVE_TAG_RE = /<\s*(script|iframe|frame|frameset|object|embed|form|meta|base|link|style|portal|foreignobject|applet)\b/gi;
const EVENT_ATTR_RE = /<[^>]*?[\s/"']on[a-z]+\s*=/gi;

/** Active HTML in Markdown, SVG or content strings. */
export function activeHtmlFindings(text: string, allowStyle = false): Finding[] {
  const out: Finding[] = [];
  const t = decodeEntities(text);
  for (const m of t.matchAll(ACTIVE_TAG_RE)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (allowStyle && tag === 'style') continue;
    const rule: RuleId = tag === 'script' ? 'inline-script' : 'html-active-content';
    out.push({ rule, key: `html:${tag}:${t.slice(m.index ?? 0, (m.index ?? 0) + 60)}`, line: lineAt(t, m.index ?? 0), reason: `<${tag}> is not allowed here` });
  }
  for (const m of t.matchAll(EVENT_ATTR_RE)) {
    out.push({ rule: 'html-active-content', key: `html:on:${m[0].slice(-60)}`, line: lineAt(t, m.index ?? 0), reason: 'inline event handler attribute' });
  }
  if (/<!\s*(?:entity|doctype)/i.test(t)) {
    out.push({ rule: 'html-active-content', key: 'html:doctype', line: 1, reason: 'DOCTYPE/ENTITY declaration' });
  }
  return out;
}

const SAFE_DATA_URI_RE = /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon)|font\/[a-z0-9.+-]+|application\/(?:x-)?font-[a-z0-9.+-]+)[;,]/i;

/** URLs referenced from CSS (`url()`, `@import`). */
export function cssFindings(text: string, config: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  const t = decodeCssEscapes(text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')));
  const urls: { value: string; index: number }[] = [];
  for (const m of t.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi)) {
    urls.push({ value: m[1] ?? m[2] ?? m[3] ?? '', index: m.index ?? 0 });
  }
  for (const m of t.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    urls.push({ value: m[1] ?? m[2] ?? '', index: m.index ?? 0 });
  }
  for (const u of urls) {
    const line = lineAt(t, u.index);
    if (/#\{|\$\{|var\(/.test(u.value)) {
      out.push({ rule: 'network-dynamic-url', key: `css:dyn:${u.value}`, line, reason: `dynamic CSS URL "${truncate(u.value)}"` });
      continue;
    }
    if (/^\s*data:/i.test(u.value)) {
      if (!SAFE_DATA_URI_RE.test(u.value.trim()) || /^\s*data:image\/svg/i.test(u.value)) {
        out.push({ rule: 'html-active-content', key: `css:data:${u.value.slice(0, 40)}`, line, reason: 'CSS data: URL of a non-image type' });
      }
      continue;
    }
    const v = checkUrl({ text: u.value, complete: true }, 'network', config);
    if (!v.ok) out.push({ rule: v.rule, key: `css:url:${u.value}`, line, reason: `CSS URL: ${v.reason}` });
  }
  for (const m of t.matchAll(/expression\s*\(|behavior\s*:|-moz-binding\s*:/gi)) {
    out.push({ rule: 'html-active-content', key: `css:active:${m[0]}`, line: lineAt(t, m.index ?? 0), reason: `active CSS construct "${m[0]}"` });
  }
  return out;
}

/** External references inside SVG (href / xlink:href). */
export function svgFindings(text: string, config: ResolvedConfig): Finding[] {
  const out: Finding[] = [...activeHtmlFindings(text, true), ...cssFindings(text, config)];
  const t = decodeEntities(text);
  for (const m of t.matchAll(/(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = (m[1] ?? m[2] ?? '').trim();
    if (value.startsWith('#') || SAFE_DATA_URI_RE.test(value)) continue;
    const line = lineAt(t, m.index ?? 0);
    const v = checkUrl({ text: value, complete: true }, 'network', config);
    const isRelative = v.ok && !/^[a-z][a-z0-9+.-]*:|^[/\\]{2}/i.test(value);
    if (!v.ok || !isRelative) {
      out.push({ rule: v.ok ? 'embed-external' : v.rule, key: `svg:href:${value}`, line, reason: `SVG reference "${truncate(value)}" is not allowed` });
    }
  }
  return out;
}

/** String values of a JSON document, with their JSON path. */
export function jsonStrings(value: unknown, path = '$'): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => jsonStrings(v, `${path}.${k}`));
  }
  return [];
}

export function jsonFindings(text: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ rule: 'parse-error', key: 'json:invalid', line: 1, reason: 'invalid JSON' }];
  }
  const out: Finding[] = [];
  for (const s of jsonStrings(parsed)) {
    for (const f of activeHtmlFindings(s.value)) out.push({ ...f, key: `json:${s.path}:${f.key}`, line: lineOfValue(text, s.value.slice(0, 20)) });
  }
  return out;
}

/** True if the host is allowed for network use (used by callers needing a direct test). */
export function isAllowedHost(host: string, config: ResolvedConfig): boolean {
  return hostMatches(host, config.allowedHosts);
}
