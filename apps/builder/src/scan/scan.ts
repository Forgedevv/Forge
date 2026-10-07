/**
 * Blocking security scan run before every push (docs/SECURITY.md section 1).
 *
 * Path rules apply to every changed file. Content rules are diff-aware: a
 * finding blocks only if it is new compared to the baseline content of the
 * same file (so the template's own code never blocks a job).
 */

import { analyzeCode } from './code.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { checkForgeConfig, checkLockfile, checkPackageJson } from './manifest.js';
import { classifyPath, extensionOf, kindOf, normalizePath, type FileKind } from './paths.js';
import { AddressCollector, cssFindings, hiddenUnicodeFindings, jsonFindings, jsonStrings, activeHtmlFindings, scriptUrlFindings, svgFindings } from './text.js';
import type { ChangedFile, FileContent, Finding, ScanInput, ScanOptions, ScanResult, Violation } from './types.js';

const STATUSES = new Set(['added', 'modified', 'deleted', 'renamed']);

function byteLength(c: FileContent): number {
  return typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.byteLength;
}

/** Strict UTF-8 decoding; `null` if the content is not clean text. */
export function decodeText(c: FileContent): string | null {
  let text: string;
  if (typeof c === 'string') {
    text = c;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(c);
    } catch {
      return null;
    }
  }
  if (text.includes('\u0000')) return null;
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** Checks that a binary file really is the image/font its extension claims. */
export function matchesMagic(ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'));
    case 'webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
    case 'avif':
      return startsWith(bytes, ascii('ftyp'), 4) && (startsWith(bytes, ascii('avif'), 8) || startsWith(bytes, ascii('avis'), 8));
    case 'ico':
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
    case 'woff':
      return startsWith(bytes, ascii('wOFF'));
    case 'woff2':
      return startsWith(bytes, ascii('wOF2'));
    case 'ttf':
      return startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || startsWith(bytes, ascii('true'));
    case 'otf':
      return startsWith(bytes, ascii('OTTO'));
    default:
      return false;
  }
}

/** Content findings for one text file. */
export function analyzeText(path: string, kind: FileKind, text: string, config: ResolvedConfig): Finding[] {
  if (kind === 'code') return analyzeCode(path, text, config);
  const out: Finding[] = [];
  const addresses = new AddressCollector(text, config);
  addresses.textVariants();
  if (kind === 'markdown' || kind === 'text') addresses.markup();
  if (kind === 'json') {
    try {
      addresses.jsonValues(jsonStrings(JSON.parse(text)).map((s) => s.value));
    } catch {
      // Invalid JSON is reported by jsonFindings.
    }
  }
  out.push(...addresses.findings, ...scriptUrlFindings(text), ...hiddenUnicodeFindings(text, false));
  if (kind === 'style') out.push(...cssFindings(text, config));
  if (kind === 'svg') out.push(...svgFindings(text, config));
  if (kind === 'markdown' || kind === 'text') out.push(...activeHtmlFindings(text));
  if (kind === 'json') out.push(...jsonFindings(text));
  return out;
}

/** Lines of `next` that do not exist in `prev` (multiset, trimmed). */
function addedLines(prev: string | null, next: string): Set<number> {
  const pool = new Map<string, number>();
  for (const l of (prev ?? '').split(/\r?\n/)) pool.set(l.trim(), (pool.get(l.trim()) ?? 0) + 1);
  const added = new Set<number>();
  next.split(/\r?\n/).forEach((l, i) => {
    const k = l.trim();
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else added.add(i + 1);
  });
  return added;
}

/** Findings of `next` not present in `prev` (by key, as a multiset). */
export function newFindings(prev: Finding[], next: Finding[], added: Set<number>): Finding[] {
  const oldCount = new Map<string, number>();
  for (const f of prev) oldCount.set(f.key, (oldCount.get(f.key) ?? 0) + 1);
  const groups = new Map<string, Finding[]>();
  for (const f of next) {
    const g = groups.get(f.key);
    if (g) g.push(f);
    else groups.set(f.key, [f]);
  }
  const out: Finding[] = [];
  for (const [key, list] of groups) {
    const extra = list.length - (oldCount.get(key) ?? 0);
    if (extra <= 0) continue;
    const sorted = [...list].sort((a, b) => Number(added.has(b.line)) - Number(added.has(a.line)));
    out.push(...sorted.slice(0, extra));
  }
  return out;
}

function fileModeViolation(file: ChangedFile, path: string): Violation | null {
  const mode = file.mode ?? '100644';
  if (mode === '100644') return null;
  const what = mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : mode === '100755' ? 'executable file' : `file mode ${mode}`;
  return { rule: 'file-mode', file: path, line: null, reason: `${what} not allowed` };
}

function scanFile(file: ChangedFile, config: ResolvedConfig): Violation[] {
  const out: Violation[] = [];
  const rawPath = typeof file.path === 'string' ? file.path : '';
  if (!STATUSES.has(file.status)) {
    return [{ rule: 'path-invalid', file: rawPath || '<unknown>', line: null, reason: `unknown status "${String(file.status)}"` }];
  }
  const p = normalizePath(rawPath);
  if (!p.ok) return [{ rule: 'path-invalid', file: rawPath || '<empty>', line: null, reason: p.reason }];
  const path = p.path;

  let oldPath = path;
  if (file.status === 'renamed') {
    const op = normalizePath(file.oldPath ?? '');
    if (!op.ok) return [{ rule: 'path-invalid', file: file.oldPath ?? '<missing oldPath>', line: null, reason: `rename source: ${op.reason}` }];
    oldPath = op.path;
  }

  const deleted = file.status === 'deleted';
  const paths = file.status === 'renamed' ? [oldPath, path] : [path];
  let contentPolicy: FileKind | 'skip' = 'skip';

  for (const candidate of paths) {
    const isTarget = candidate === path;
    const zone = classifyPath(candidate);
    switch (zone.zone) {
      case 'blocked':
        out.push({ rule: zone.rule, file: candidate, line: null, reason: zone.reason });
        break;
      case 'forge-config': {
        const asText = (c: FileContent | null): string | null => (c === null ? null : decodeText(c));
        const status = file.status === 'renamed' ? 'renamed' : file.status;
        out.push(...checkForgeConfig(status, asText(file.oldContent), asText(file.newContent), candidate));
        if (isTarget && !deleted) contentPolicy = 'json';
        break;
      }
      case 'package-json': {
        out.push({ rule: 'zone-outside-allowed', file: candidate, line: null, reason: 'package.json is locked' });
        const asText = (c: FileContent | null): string | null => (c === null ? null : decodeText(c));
        const newText = isTarget && !deleted ? asText(file.newContent) : null;
        out.push(...checkPackageJson(file.status, asText(file.oldContent), newText, candidate));
        break;
      }
      case 'lockfile':
        out.push({ rule: 'zone-outside-allowed', file: candidate, line: null, reason: 'lockfiles are locked' });
        out.push(...checkLockfile(candidate, file.oldContent, isTarget && !deleted ? file.newContent : null, candidate));
        break;
      case 'free':
        if (isTarget && !deleted) contentPolicy = zone.kind;
        break;
    }
  }

  if (deleted) return out;

  const modeViolation = fileModeViolation(file, path);
  if (modeViolation) out.push(modeViolation);

  const content = file.newContent;
  if (content === null || content === undefined) {
    out.push({ rule: 'encoding-invalid', file: path, line: null, reason: 'missing new content' });
    return out;
  }
  if (contentPolicy === 'skip') return out;
  const kind = contentPolicy;

  if (kind === 'binary') {
    if (byteLength(content) > config.maxBinaryBytes) {
      out.push({ rule: 'file-too-large', file: path, line: null, reason: `binary file over ${config.maxBinaryBytes} bytes` });
    }
    const ext = extensionOf(path);
    if (typeof content === 'string') {
      out.push({ rule: 'binary-file', file: path, line: null, reason: 'binary file content must be provided as bytes' });
    } else if (!matchesMagic(ext, content)) {
      out.push({ rule: 'binary-file', file: path, line: null, reason: `content is not a valid .${ext} file` });
    }
    return out;
  }

  if (byteLength(content) > config.maxTextBytes) {
    out.push({ rule: 'file-too-large', file: path, line: null, reason: `text file over ${config.maxTextBytes} bytes` });
    return out;
  }
  const text = decodeText(content);
  if (text === null) {
    out.push({ rule: 'encoding-invalid', file: path, line: null, reason: 'not valid UTF-8 text (binary content in a text file)' });
    return out;
  }

  let oldText: string | null = null;
  if (file.oldContent !== null && file.oldContent !== undefined && file.status !== 'added' && kindOf(oldPath) === kindOf(path)) {
    oldText = byteLength(file.oldContent) <= config.maxTextBytes ? decodeText(file.oldContent) : null;
  }
  const next = analyzeText(path, kind, text, config);
  const prev = oldText === null ? [] : analyzeText(oldPath, kind, oldText, config);
  for (const f of newFindings(prev, next, addedLines(oldText, text))) {
    out.push({ rule: f.rule, file: path, line: f.line, reason: f.reason });
  }
  return out;
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const k = `${v.rule}|${v.file}|${v.line ?? ''}|${v.reason}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}

/**
 * Scans the agent's changes. Any violation means: no push, job failed
 * (`failed_stage = 'build'`) with the violation list.
 */
export function scanDiff(input: ScanInput | readonly ChangedFile[], options: ScanOptions = {}): ScanResult {
  const config = resolveConfig(options);
  const files = Array.isArray(input) ? (input as readonly ChangedFile[]) : (input as ScanInput)?.files;
  if (!Array.isArray(files)) {
    return { ok: false, violations: [{ rule: 'path-invalid', file: '<input>', line: null, reason: 'scan input must be a list of changed files' }] };
  }
  const violations: Violation[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    let result: Violation[];
    try {
      result = scanFile(file, config);
    } catch (e) {
      // Fail closed: an analyzer crash is a violation, never a pass.
      result = [{ rule: 'parse-error', file: String(file?.path ?? '<unknown>'), line: null, reason: `scanner error: ${(e as Error).message.slice(0, 80)}` }];
    }
    violations.push(...result);
    const key = String(file?.path ?? '').toLowerCase();
    if (seenPaths.has(key)) {
      violations.push({ rule: 'path-invalid', file: String(file.path), line: null, reason: 'path listed twice (or differs only by case)' });
    }
    seenPaths.add(key);
  }
  if (violations.length === 0) return { ok: true };
  return { ok: false, violations: dedupe(violations) };
}
