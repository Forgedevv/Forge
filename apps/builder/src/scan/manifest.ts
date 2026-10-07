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
export function parseStrictJson(path: string, text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
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
        const k = ts.isStringLiteral(p.name) || ts.isIdentifier(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
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
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
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
    out.push({ rule: 'forge-config-locked-field', file, line: null, reason: `forge.config.json must not be ${status === 'modified' ? 'emptied' : status}` });
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
    out.push({ rule: 'forge-config-invalid', file, line: null, reason: 'forge.config.json must be a JSON object' });
    return out;
  }
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  for (const key of keys) {
    if (AGENT_EDITABLE_KEYS.has(key)) continue;
    if (!deepEqual(oldValue[key], newValue[key])) {
      out.push({ rule: 'forge-config-locked-field', file, line: lineOfKey(newText, key), reason: `field "${key}" may not be changed by the agent` });
    }
  }
  for (const key of AGENT_EDITABLE_KEYS) {
    const v = newValue[key];
    if (v !== undefined && !isPlainObject(v)) {
      out.push({ rule: 'forge-config-invalid', file, line: lineOfKey(newText, key), reason: `field "${key}" must be an object` });
    }
  }
  for (const s of jsonStrings(newValue.theme, '$.theme')) {
    if (!SAFE_THEME_VALUE_RE.test(s.value) || /url\s*\(|expression\s*\(|\/\*/i.test(s.value)) {
      out.push({ rule: 'forge-config-unsafe-value', file, line: lineOfKey(newText, s.path.split('.').pop() ?? ''), reason: `unsafe theme value at ${s.path}` });
    }
  }
  for (const s of jsonStrings(newValue.content, '$.content')) {
    if (isScriptUrl(s.value) || activeHtmlFindings(s.value).length > 0) {
      out.push({ rule: 'forge-config-unsafe-value', file, line: lineOfKey(newText, s.path.split('.').pop() ?? ''), reason: `active content at ${s.path}` });
    }
  }
  return out;
}

const FORGE_CORE = /forge\/core/i;

/** Every JSON leaf whose path or value mentions @forge/core. */
function forgeCoreEntries(value: unknown, path: string[] = []): string[] {
  const here = path.join('>');
  if (typeof value !== 'object' || value === null) {
    const s = JSON.stringify(value);
    return FORGE_CORE.test(here) || FORGE_CORE.test(String(value)) ? [`${here}=${s}`] : [];
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const out = entries.flatMap(([k, v]) => forgeCoreEntries(v, [...path, k]));
  if (entries.length === 0 && FORGE_CORE.test(here)) out.push(`${here}={}`);
  return out;
}

function multisetDiff(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.some((x, i) => x !== sb[i]);
}

export function checkPackageJson(status: string, oldText: string | null, newText: string | null, file: string): Violation[] {
  const out: Violation[] = [];
  if (newText === null) {
    out.push({ rule: 'forge-core-dependency', file, line: null, reason: `package.json ${status} (the @forge/core dependency would be lost)` });
    return out;
  }
  const parsedNew = parseStrictJson(file, newText);
  if (!parsedNew.ok) {
    out.push({ rule: 'forge-core-dependency', file, line: null, reason: `package.json: ${parsedNew.reason}` });
    return out;
  }
  const parsedOld = oldText === null ? null : parseStrictJson(file, oldText);
  const oldEntries = parsedOld?.ok ? forgeCoreEntries(parsedOld.value) : [];
  const newEntries = forgeCoreEntries(parsedNew.value);
  if (multisetDiff(oldEntries, newEntries)) {
    out.push({ rule: 'forge-core-dependency', file, line: lineOfKey(newText, '@forge/core'), reason: 'change to the @forge/core dependency (version, presence, alias or override)' });
  }
  const mentions = (t: string | null): number => (t ? (t.match(/patch-package|patchedDependencies/g) ?? []).length : 0);
  if (mentions(newText) > mentions(oldText)) {
    out.push({ rule: 'patch-package', file, line: null, reason: 'patch-package / patchedDependencies added' });
  }
  return out;
}

/** Indentation blocks (YAML-like lockfiles) starting at a line that mentions @forge/core. */
function forgeCoreBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!FORGE_CORE.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const block = [line.trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (next.length - next.trimStart().length <= indent) break;
      block.push(next.trim());
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

export function checkLockfile(path: string, oldContent: string | Uint8Array | null, newContent: string | Uint8Array | null, file: string): Violation[] {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const asText = (c: string | Uint8Array | null): string | null => (c === null ? null : typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
  const oldText = asText(oldContent);
  const newText = asText(newContent);
  const violation: Violation = { rule: 'lockfile-forge-core', file, line: null, reason: 'lockfile change touching @forge/core' };
  if (base === 'bun.lockb' || oldText === null || newText === null) {
    if (oldText === null && newText !== null && !FORGE_CORE.test(newText)) return [];
    return [{ ...violation, reason: 'lockfile added, deleted or binary: @forge/core resolution cannot be verified' }];
  }
  if (base.endsWith('.json')) {
    const a = parseStrictJson(file, oldText);
    const b = parseStrictJson(file, newText);
    if (!b.ok) return [{ ...violation, reason: `lockfile: ${b.reason}` }];
    return multisetDiff(a.ok ? forgeCoreEntries(a.value) : [], forgeCoreEntries(b.value)) ? [violation] : [];
  }
  return multisetDiff(forgeCoreBlocks(oldText), forgeCoreBlocks(newText)) ? [violation] : [];
}
