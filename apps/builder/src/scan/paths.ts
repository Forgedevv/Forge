/**
 * Path policy: which files the agent may add, modify or delete.
 * Default deny: anything not explicitly allowed is a violation.
 */

import type { RuleId } from './types.js';

export type FileKind = 'code' | 'style' | 'json' | 'markdown' | 'text' | 'svg' | 'binary';

export const FORGE_CONFIG_PATH = 'forge.config.json';
export const ROOT_PACKAGE_JSON = 'package.json';

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
]);

const KIND_BY_EXT: Record<string, FileKind> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  css: 'style',
  scss: 'style',
  json: 'json',
  md: 'markdown',
  txt: 'text',
  svg: 'svg',
  png: 'binary',
  jpg: 'binary',
  jpeg: 'binary',
  gif: 'binary',
  webp: 'binary',
  avif: 'binary',
  ico: 'binary',
  woff: 'binary',
  woff2: 'binary',
  ttf: 'binary',
  otf: 'binary',
};

/** Extensions accepted in public/ (served as-is): images and fonts only. */
const PUBLIC_EXTS = new Set([
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'otf',
]);

const SRC_ZONES = ['src/theme/', 'src/content/', 'src/components/', 'src/pages/'] as const;

/** Basenames (lowercase) that change build, resolution or runtime behavior. Never allowed, even in a free zone. */
const SPECIAL_BASENAME_RE =
  /^(?:package\.json|tsconfig(?:\..*)?\.json|jsconfig(?:\..*)?\.json|babel\.config\..*|(?:_)?middleware\..*|instrumentation(?:-client)?\..*|vercel\.json|postcss\.config\..*|tailwind\.config\..*|webpack\.config\..*|turbo\.json|\.npmrc|\.yarnrc.*|\.env.*|\.babelrc.*)$/;

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function kindOf(path: string): FileKind | null {
  return KIND_BY_EXT[extensionOf(path)] ?? null;
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Strict path syntax: relative POSIX path, ASCII-safe characters, no `.`/`..` segments. */
export function normalizePath(raw: string): PathCheck {
  if (raw.length === 0) return { ok: false, reason: 'empty path' };
  if (raw.length > 400) return { ok: false, reason: 'path too long' };
  const path = raw.startsWith('./') ? raw.slice(2) : raw;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path))
    return { ok: false, reason: 'absolute path' };
  if (path.includes('\\')) return { ok: false, reason: 'backslash in path' };
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..')
      return { ok: false, reason: `invalid path segment "${seg}"` };
    if (!/^[A-Za-z0-9._@()[\]+-]+$/.test(seg))
      return { ok: false, reason: 'unsupported characters in path' };
  }
  return { ok: true, path };
}

export type ZoneClass =
  | { zone: 'free'; kind: FileKind }
  | { zone: 'forge-config' }
  | { zone: 'package-json' }
  | { zone: 'lockfile' }
  | { zone: 'blocked'; rule: RuleId; reason: string };

/**
 * Files that decide what the whole site renders, whatever the pages are: the custom App (wallet
 * and data providers, and the gate that serves the static page of a sleeping or disabled site),
 * the custom Document (head and scripts of every page) and the static mode pages. A change there
 * could keep a site cut by FORGE fully working, so they are locked like src/forge/. The site mode
 * itself lives in forge.config.json (`mode`), a field only the builder writes (manifest.ts).
 */
function lockedShellReason(lower: string): string | null {
  const special = /^src\/pages\/(_app|_document)(?:\.|\/|$)/.exec(lower);
  if (special?.[1] === '_app') return 'src/pages/_app is locked (providers and the site mode gate)';
  if (special?.[1] === '_document') return 'src/pages/_document is locked (head and scripts)';
  if (lower === 'src/components/modes' || lower.startsWith('src/components/modes/')) {
    return 'src/components/modes/ is locked (sleeping and maintenance pages)';
  }
  return null;
}

/**
 * Routes FORGE serves on every live site, whose content lives in the locked zone: the route file is
 * a single re-export of a `src/forge/` page, so the agent cannot replace, wrap or delete it (free
 * zones may still link to it). Any file or folder that maps to the same route is locked too.
 * - `/creator-fees`: the creator fee claim page (`src/forge/pages/CreatorFeesPage.tsx`).
 */
const LOCKED_ROUTE_RE = /^src\/pages\/(creator-fees)(?:\.|\/|$)/;

function lockedPageReason(lower: string): string | null {
  const route = LOCKED_ROUTE_RE.exec(lower);
  return route ? `src/pages/${route[1]} is locked (FORGE page: creator fee claims)` : null;
}

/** Classifies a normalized path. */
export function classifyPath(path: string): ZoneClass {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? '';

  if (segments.includes('node_modules'))
    return { zone: 'blocked', rule: 'node-modules', reason: 'file under node_modules/' };
  if (
    segments.slice(0, -1).includes('patches') ||
    /\.(?:patch|diff)$/.test(base) ||
    base.startsWith('.patch-package')
  ) {
    return {
      zone: 'blocked',
      rule: 'patch-package',
      reason: 'patch file (patch-package / patches/)',
    };
  }
  if (lower === 'src/forge' || lower.startsWith('src/forge/')) {
    return { zone: 'blocked', rule: 'forge-locked-zone', reason: 'src/forge/ is locked' };
  }
  if (base.startsWith('next.config.'))
    return {
      zone: 'blocked',
      rule: 'next-config',
      reason: 'next.config is locked (security headers)',
    };
  if (path === FORGE_CONFIG_PATH) return { zone: 'forge-config' };
  if (LOCKFILES.has(base)) return { zone: 'lockfile' };
  if (path === ROOT_PACKAGE_JSON) return { zone: 'package-json' };
  if (lower.startsWith('src/pages/api/') || lower === 'src/pages/api') {
    return { zone: 'blocked', rule: 'api-route', reason: 'API routes (src/pages/api/) are locked' };
  }
  const shell = lockedShellReason(lower);
  if (shell !== null) return { zone: 'blocked', rule: 'app-shell-locked', reason: shell };
  const page = lockedPageReason(lower);
  if (page !== null) return { zone: 'blocked', rule: 'forge-page-locked', reason: page };

  const inSrcZone = SRC_ZONES.some((z) => path.startsWith(z));
  const inPublic = path.startsWith('public/');
  if (!inSrcZone && !inPublic) {
    return {
      zone: 'blocked',
      rule: 'zone-outside-allowed',
      reason: 'file outside the allowed zones',
    };
  }
  if (segments.some((s) => s.startsWith('.')) || SPECIAL_BASENAME_RE.test(base)) {
    return {
      zone: 'blocked',
      rule: 'special-file',
      reason: `configuration or hidden file "${base}" is not allowed`,
    };
  }
  const ext = extensionOf(path);
  const kind = KIND_BY_EXT[ext];
  if (kind === undefined || (inPublic && !PUBLIC_EXTS.has(ext))) {
    return {
      zone: 'blocked',
      rule: 'file-type-not-allowed',
      reason: `file type ".${ext}" is not allowed here`,
    };
  }
  return { zone: 'free', kind };
}
