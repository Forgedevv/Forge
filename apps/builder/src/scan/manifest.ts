/**
 * JSON-aware checks of forge.config.json, package.json and lockfiles.
 */

import ts from 'typescript';

import { activeHtmlFindings, jsonStrings, lineAt } from './text.js';
import type { Violation } from './types.js';
import { isScriptUrl } from './url.js';

/** Keys of forge.config.json the agent may change (docs/INTERFACES.md section 3). */
const AGENT_EDITABLE_KEYS = new Set(['theme', 'content']);

function lineOfKey(text: string, key: string): number | null {
  const i = text.indexOf(`"${key}"`);
  return i >= 0 ? lineAt(text, i) : null;
}

/** JSON parse that also rejects duplicate keys (parsers disagree on which one wins). */
export function parseStrictJson(
  path: string,
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON (${(e as Error).message.slice(0, 80)})` };
  }
  const sf = ts.parseJsonText(path, text);
  let dup: string | null = null;
  const visit = (n: ts.Node): void => {
    if (dup) return;
    if (ts.isObjectLiteralExpression(n)) {
      const seen = new Set<string>();
      for (const p of n.properties) {
        if (!p.name) continue;
        const k =
          ts.isStringLiteral(p.name) || ts.isIdentifier(p.name) || ts.isNumericLiteral(p.name)
            ? p.name.text
            : null;
        if (k === null) continue;
        if (seen.has(k)) {
          dup = k;
          return;
        }
        seen.add(k);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (dup) return { ok: false, reason: `duplicate key "${dup}"` };
  return { ok: true, value };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Theme values end up in CSS: only plain tokens (colors, sizes, font names) are accepted. */
const SAFE_THEME_VALUE_RE = /^[A-Za-z0-9 #%.,()'"_+\-/]*$/;

export function checkForgeConfig(
  status: 'added' | 'modified' | 'deleted' | 'renamed',
  oldText: string | null,
  newText: string | null,
  file: string,
): Violation[] {
  const out: Violation[] = [];
  if (status !== 'modified' || oldText === null || newText === null) {
    out.push({
      rule: 'forge-config-locked-field',
      file,
      line: null,
      reason: `forge.config.json must not be ${status === 'modified' ? 'emptied' : status}`,
    });
    return out;
  }
  const parsedNew = parseStrictJson(file, newText);
  if (!parsedNew.ok) {
    out.push({ rule: 'forge-config-invalid', file, line: null, reason: parsedNew.reason });
    return out;
  }
  const parsedOld = parseStrictJson(file, oldText);
  const oldValue = parsedOld.ok ? parsedOld.value : undefined;
  const newValue = parsedNew.value;
  if (!isPlainObject(newValue) || !isPlainObject(oldValue)) {
    out.push({
      rule: 'forge-config-invalid',
      file,
      line: null,
      reason: 'forge.config.json must be a JSON object',
    });
    return out;
  }
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  for (const key of keys) {
    if (AGENT_EDITABLE_KEYS.has(key)) continue;
    if (!deepEqual(oldValue[key], newValue[key])) {
      out.push({
        rule: 'forge-config-locked-field',
        file,
        line: lineOfKey(newText, key),
        reason: `field "${key}" may not be changed by the agent`,
      });
    }
  }
  for (const key of AGENT_EDITABLE_KEYS) {
    const v = newValue[key];
    if (v !== undefined && !isPlainObject(v)) {
      out.push({
        rule: 'forge-config-invalid',
        file,
        line: lineOfKey(newText, key),
        reason: `field "${key}" must be an object`,
      });
    }
  }
  for (const s of jsonStrings(newValue.theme, '$.theme')) {
    if (!SAFE_THEME_VALUE_RE.test(s.value) || /url\s*\(|expression\s*\(|\/\*/i.test(s.value)) {
      out.push({
        rule: 'forge-config-unsafe-value',
        file,
        line: lineOfKey(newText, s.path.split('.').pop() ?? ''),
        reason: `unsafe theme value at ${s.path}`,
      });
    }
  }
  for (const s of jsonStrings(newValue.content, '$.content')) {
    if (isScriptUrl(s.value) || activeHtmlFindings(s.value).length > 0) {
      out.push({
        rule: 'forge-config-unsafe-value',
        file,
        line: lineOfKey(newText, s.path.split('.').pop() ?? ''),
        reason: `active content at ${s.path}`,
      });
    }
  }
  return out;
}

/**
 * FORGE packages, under the name the site imports (`@forge/core`, `@forge/shared`) and under their
 * public npm name (`@forgedevv/core`, `@forgedevv/shared`, decision D26: client repos depend on
 * them through exact `npm:` aliases). Matched anywhere in a key or a value, with or without the
 * scope `@` and with an URL-encoded slash, so aliases, overrides, patches and lockfile keys of
 * either name are all caught.
 */
const FORGE_PACKAGE_RE = /forge(?:devv)?(?:\/|%2f)(?:core|shared)/i;

const FORGE_PACKAGES_LABEL = '@forge/core, @forge/shared (npm: @forgedevv/core, @forgedevv/shared)';

/**
 * package.json sections that replace, redirect or patch installed packages. Any change there is
 * refused, whatever package it names: a FORGE package runs its own dependencies (the Meteora SDK,
 * @solana/web3.js...), so overriding or patching one of them changes FORGE code too.
 */
const RESOLUTION_SECTIONS: readonly (readonly string[])[] = [
  ['overrides'],
  ['resolutions'],
  ['patchedDependencies'],
  ['pnpm', 'overrides'],
  ['pnpm', 'patchedDependencies'],
  ['pnpm', 'packageExtensions'],
];

/** Every JSON leaf whose path or value names a FORGE package, as `path=value`. */
function forgeEntries(value: unknown, path: string[] = []): string[] {
  const here = path.join('>');
  if (typeof value !== 'object' || value === null) {
    const s = JSON.stringify(value);
    return FORGE_PACKAGE_RE.test(here) || FORGE_PACKAGE_RE.test(String(value))
      ? [`${here}=${s}`]
      : [];
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const out = entries.flatMap(([k, v]) => forgeEntries(v, [...path, k]));
  if (entries.length === 0 && FORGE_PACKAGE_RE.test(here)) out.push(`${here}={}`);
  return out;
}

/** Items of `b` that are not in `a` (multiset). */
function multisetExtra(a: readonly string[], b: readonly string[]): string[] {
  const pool = new Map<string, number>();
  for (const x of a) pool.set(x, (pool.get(x) ?? 0) + 1);
  const extra: string[] = [];
  for (const x of b) {
    const n = pool.get(x) ?? 0;
    if (n > 0) pool.set(x, n - 1);
    else extra.push(x);
  }
  return extra;
}

function multisetDiff(a: readonly string[], b: readonly string[]): boolean {
  return a.length !== b.length || multisetExtra(a, b).length > 0;
}

function sectionAt(value: unknown, keys: readonly string[]): unknown {
  let v = value;
  for (const k of keys) {
    if (!isPlainObject(v) || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/** Line of the first FORGE package name in `text`, if any. */
function lineOfForgePackage(text: string): number | null {
  const m = FORGE_PACKAGE_RE.exec(text);
  return m ? lineAt(text, m.index) : null;
}

export function checkPackageJson(
  status: string,
  oldText: string | null,
  newText: string | null,
  file: string,
): Violation[] {
  const out: Violation[] = [];
  if (newText === null) {
    out.push({
      rule: 'forge-core-dependency',
      file,
      line: null,
      reason: `package.json ${status} (the FORGE package dependencies would be lost)`,
    });
    return out;
  }
  const parsedNew = parseStrictJson(file, newText);
  if (!parsedNew.ok) {
    out.push({
      rule: 'forge-core-dependency',
      file,
      line: null,
      reason: `package.json: ${parsedNew.reason}`,
    });
    return out;
  }
  const parsedOld = oldText === null ? null : parseStrictJson(file, oldText);
  const oldValue = parsedOld?.ok ? parsedOld.value : undefined;
  const newValue = parsedNew.value;
  if (multisetDiff(forgeEntries(oldValue), forgeEntries(newValue))) {
    out.push({
      rule: 'forge-core-dependency',
      file,
      line: lineOfForgePackage(newText),
      reason: `change to a FORGE package dependency (${FORGE_PACKAGES_LABEL}): spec, version, alias, presence, override, resolution or patch`,
    });
  }
  for (const keys of RESOLUTION_SECTIONS) {
    if (deepEqual(sectionAt(oldValue, keys), sectionAt(newValue, keys))) continue;
    const name = keys.join('.');
    out.push({
      rule: 'forge-core-dependency',
      file,
      line: lineOfKey(newText, keys[keys.length - 1] ?? name),
      reason: `"${name}" changed: overrides, resolutions and patches can replace a FORGE package or one of its dependencies`,
    });
  }
  const mentions = (t: string | null): number =>
    t ? (t.match(/patch-package|patchedDependencies/g) ?? []).length : 0;
  if (mentions(newText) > mentions(oldText)) {
    out.push({
      rule: 'patch-package',
      file,
      line: null,
      reason: 'patch-package / patchedDependencies added',
    });
  }
  return out;
}

/**
 * Text lockfile sections that apply overrides, patches, package extensions or a pnpmfile to the
 * whole tree (pnpm-lock.yaml, bun.lock): any change there is a change to what FORGE packages run.
 */
const LOCK_SECTION_RE =
  /^["']?(?:overrides|resolutions|patchedDependencies|packageExtensionsChecksum|pnpmfileChecksum)["']?\s*:/;

/**
 * Decodes the escapes a YAML or JSON string may use to spell a package name without its plain
 * characters (`\x40`, `@`, `\U00000040`, `\/`), and URL-encoded characters (`%2f`).
 */
export function decodeLockEscapes(s: string): string {
  return s.replace(
    /\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|%([0-9a-fA-F]{2})|\\(\/)/g,
    (m: string, x?: string, u?: string, U?: string, pct?: string, slash?: string) => {
      if (slash) return '/';
      const cp = parseInt(x ?? u ?? U ?? pct ?? '', 16);
      return Number.isInteger(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    },
  );
}

/**
 * YAML syntax a generated lockfile never uses, but that could hide or re-parent an entry from a
 * line-based reading: backslash escapes and escaped line breaks, explicit keys and values
 * (`? key` / `: value`), anchors, aliases, tags, merge keys, block scalars, document markers and
 * directives. Counted per occurrence; a lockfile change adding any of them is refused.
 */
const HIDDEN_YAML_RE =
  /\\|^[ \t]*[?:](?:[ \t]|$)|(?:^|[\s,[{])[&*!][^\s,\]}]|<<[ \t]*:|:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$|^(?:---|\.\.\.)(?:[ \t]|$)|^%/gm;

function hiddenSyntaxCount(text: string): number {
  return (text.match(HIDDEN_YAML_RE) ?? []).length;
}

interface LockBlock {
  /** Parent keys, then the block lines with their indentation. */
  key: string;
  /** 1-based line where the block starts. */
  line: number;
}

/**
 * Indentation blocks of a text lockfile (YAML-like, yarn, bun.lock) that start at a line naming a
 * FORGE package (after decoding escapes) or opening an override/patch section. Each block keeps
 * its parent keys and its exact indentation, so moving, re-indenting or editing it is a change.
 * Only outermost blocks are kept (a nested one is part of its outer block).
 */
function lockBlocks(text: string): LockBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const blocks: LockBlock[] = [];
  const parents: { indent: number; text: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const indent = indentOf(line);
    while (parents.length > 0 && (parents[parents.length - 1]?.indent ?? 0) >= indent) {
      parents.pop();
    }
    const trimmed = line.trim();
    const watched = FORGE_PACKAGE_RE.test(decodeLockEscapes(line)) || LOCK_SECTION_RE.test(trimmed);
    if (!watched) {
      parents.push({ indent, text: trimmed });
      i += 1;
      continue;
    }
    const body = [line.trimEnd()];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (indentOf(next) <= indent) break;
      body.push(next.trimEnd());
    }
    blocks.push({ key: [...parents.map((p) => p.text), '', ...body].join('\n'), line: i + 1 });
    i = j;
  }
  return blocks;
}

export function checkLockfile(
  path: string,
  oldContent: string | Uint8Array | null,
  newContent: string | Uint8Array | null,
  file: string,
): Violation[] {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const asText = (c: string | Uint8Array | null): string | null =>
    c === null ? null : typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
  const oldText = asText(oldContent);
  const newText = asText(newContent);
  const violation: Violation = {
    rule: 'lockfile-forge-core',
    file,
    line: null,
    reason: `lockfile change touching a FORGE package (${FORGE_PACKAGES_LABEL}), an override or a patch`,
  };
  if (base === 'bun.lockb' || oldText === null || newText === null) {
    if (
      base !== 'bun.lockb' &&
      oldText === null &&
      newText !== null &&
      !FORGE_PACKAGE_RE.test(decodeLockEscapes(newText))
    ) {
      return [];
    }
    return [
      {
        ...violation,
        reason:
          'lockfile added, deleted or binary: the FORGE package resolution cannot be verified',
      },
    ];
  }
  if (base.endsWith('.json')) {
    const a = parseStrictJson(file, oldText);
    const b = parseStrictJson(file, newText);
    if (!b.ok) return [{ ...violation, reason: `lockfile: ${b.reason}` }];
    const oldEntries = a.ok ? forgeEntries(a.value) : [];
    const newEntries = forgeEntries(b.value);
    if (!multisetDiff(oldEntries, newEntries)) return [];
    return [{ ...violation, line: lineOfForgePackage(newText) }];
  }
  const out: Violation[] = [];
  const oldBlocks = lockBlocks(oldText);
  const newBlocks = lockBlocks(newText);
  const oldKeys = oldBlocks.map((b) => b.key);
  const newKeys = newBlocks.map((b) => b.key);
  if (multisetDiff(oldKeys, newKeys)) {
    const added = new Set(multisetExtra(oldKeys, newKeys));
    const first = newBlocks.find((b) => added.has(b.key));
    out.push({ ...violation, line: first?.line ?? null });
  }
  if (hiddenSyntaxCount(newText) > hiddenSyntaxCount(oldText)) {
    out.push({
      ...violation,
      reason:
        'lockfile change adds YAML escapes, explicit keys, anchors, tags or block scalars that can hide a FORGE package entry',
    });
  }
  return out;
}
