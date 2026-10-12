#!/usr/bin/env node
/**
 * Prepares the content of the standalone template repository from `apps/launchpad-template`.
 *
 * It only reads this folder and writes into an output folder. It runs read-only git commands only
 * (`ls-files`, `cat-file`), never pushes, never tags and never publishes: pushing the output to the
 * template repository is a separate, manual step.
 *
 * What it copies: only the files tracked by git in this folder (`git ls-files`), never untracked or
 * ignored files, minus a denylist that always applies (even to a file tracked by mistake): local
 * `.npmrc`, assistant notes, `.env*` other than `.env.example`, keys, keypairs and `.state/`. File
 * contents are read from the git index (`git cat-file`), never from the working tree, so the bytes
 * that are scanned are the bytes that are written, and an unstaged local edit never leaks. The
 * whole output is then scanned for secret shapes (registry tokens, private keys, keypair arrays,
 * base58 secret keys, JWTs, provider URLs carrying a key, GitHub and API tokens, storage keys);
 * one match and nothing is written.
 *
 * What the output differs in:
 * - every `workspace:*` dependency is replaced by the exact version given with `--pin name=x.y.z`;
 * - `tsconfig.json` no longer extends the monorepo base (its options are inlined);
 * - tests, test tooling, the monorepo lint config, mocks, caches and this `scripts/` folder are left out;
 * - `typescript` is added (the monorepo root provides it, a standalone repository does not);
 * - `vercel.json` disables Git deployments, so a push to the template repository never deploys it;
 * - `.npmrc` is written only when a private registry is chosen (`--registry` and `--scope`), with the
 *   scope line only: never a token.
 *
 * Usage:
 *   node scripts/prepare-template-repo.mjs --out <dir> --pin @forge/core=0.1.0 --pin @forge/shared=0.1.0
 *     [--registry https://npm.pkg.github.com --scope @forgedevv] [--typescript 6.0.3] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Content of `vercel.json`: no deployment is triggered by Git pushes to the template repository. */
export const VERCEL_JSON = { git: { deploymentEnabled: false } };

/** Folder and file names that never reach the template repository, at any depth. */
const EXCLUDED_NAMES = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '.vercel',
  '.state',
  '.DS_Store',
]);
/** Paths (relative to the app, `/` separated) that never reach the template repository. */
const EXCLUDED_PATHS = new Set([
  'tests',
  'scripts',
  'vitest.config.mjs',
  'eslint.config.mjs',
  '.prettierignore',
  // Mocks and fixtures used by the tests only (nothing in the site imports them).
  'src/forge/trade/core-adapter.mock.ts',
  'src/forge/claims/mock-core.ts',
  'src/forge/create/test-fixtures.ts',
]);
const EXCLUDED_PATTERNS = [/\.tsbuildinfo$/, /\.(test|spec)\.[cm]?[jt]sx?$/];
const KEPT_ENV_FILE = '.env.example';

/**
 * Denylist that always applies, at any depth, even to a file tracked by git by mistake. The only
 * `.npmrc` the output may hold is the generated one.
 */
const DENIED_DIRECTORIES = new Set(['.claude', '.state']);
const DENIED_FILE_PATTERNS = [
  /^\.npmrc$/i,
  /^CLAUDE.*\.md$/i,
  /^AGENTS\.md$/i,
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_/i,
  /keypair.*\.json$/i,
];

/**
 * Secret shapes searched in every output file. A match fails the run; the message names the file
 * and the kind of secret, never the value.
 */
export const SECRET_PATTERNS = [
  { name: 'npm auth token', pattern: /_auth(Token)?\s*=|\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'PEM block', pattern: /-----BEGIN/ },
  { name: 'secret key byte array', pattern: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*,?\s*\]/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    // R2 access key ids are 32 lowercase hex characters and secrets 64: both mix letters and digits.
    name: 'R2 key',
    pattern:
      /(?<![A-Za-z0-9])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])(?:[0-9a-f]{64}|[0-9a-f]{32})(?![A-Za-z0-9])/,
  },
  {
    // A 64-byte ed25519 secret key in base58 is 87 or 88 characters (addresses are 32 to 44).
    name: 'base58 secret key',
    pattern: /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{87,88}(?![1-9A-HJ-NP-Za-km-z])/,
  },
  {
    name: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    name: 'provider URL with a key',
    pattern:
      /[?&](?:api[-_]?key|access[-_]?token|token|key)=[A-Za-z0-9_-]{8,}|[?&][\w-]+=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
  {
    name: 'storage secret assignment',
    pattern:
      /(?:aws|r2|s3)[\w-]*(?:secret|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}/i,
  },
];

/** Dev dependencies that only the monorepo tests use. */
const TEST_DEV_DEPENDENCIES = [
  '@testing-library/dom',
  '@testing-library/jest-dom',
  '@testing-library/react',
  'jsdom',
];
/** Scripts that need the monorepo tooling (vitest, root lint config). */
const REMOVED_SCRIPTS = ['test', 'lint'];

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export class PrepareError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrepareError';
  }
}

/** True when a path (relative to the app, `/` separated) is part of the template repository. */
export function isIncluded(relPath) {
  const parts = relPath.split('/');
  for (let i = 1; i <= parts.length; i += 1) {
    if (EXCLUDED_PATHS.has(parts.slice(0, i).join('/'))) return false;
  }
  if (parts.some((part) => EXCLUDED_NAMES.has(part))) return false;
  if (isDenied(relPath)) return false;
  const name = parts[parts.length - 1];
  return !EXCLUDED_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when a path hits the denylist (secrets, local config, assistant notes, state). */
export function isDenied(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => DENIED_DIRECTORIES.has(part))) return true;
  const name = parts[parts.length - 1];
  if (name === KEPT_ENV_FILE) return false;
  return DENIED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** Names of the secret shapes found in a file content (empty when clean). */
export function findSecrets(content) {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(({ name }) => name);
}

/** The only git commands this script runs: read-only ones. */
export const GIT_READ_COMMANDS = ['ls-files', 'cat-file'];

/** Runs one read-only git command in `sourceDir` (no shell) and returns its stdout as a Buffer. */
function git(sourceDir, args, input) {
  if (!GIT_READ_COMMANDS.includes(args[0])) {
    throw new PrepareError(`Refusing to run git ${args[0]}: only read-only commands are allowed.`);
  }
  try {
    return execFileSync('git', ['-C', sourceDir, ...args], {
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PrepareError(`Could not read the git index (git ${args[0]}): ${reason}`);
  }
}

/**
 * Files tracked by git in `sourceDir`, relative to it and `/` separated. Runs `git ls-files` only
 * (read-only, no shell). Fails when the folder is not inside a git work tree.
 */
export function listTrackedFiles(sourceDir) {
  return git(sourceDir, ['ls-files', '-z', '--cached', '--', '.'])
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel.length > 0);
}

/** Regular-file modes of the git index (symlinks 120000 and submodules 160000 are never read). */
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/**
 * Contents of `rels` as staged in the git index of `sourceDir` (never the working tree). Paths that
 * are not in the index, or are not regular files, are left out. Fails on unmerged entries.
 */
export function readIndexFiles(sourceDir, rels) {
  const wanted = new Set(rels);
  const entries = new Map();
  const records = git(sourceDir, ['ls-files', '-z', '--stage', '--', '.'])
    .toString('utf8')
    .split('\0');
  for (const record of records) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    const rel = record.slice(tab + 1);
    if (!wanted.has(rel)) continue;
    if (stage !== '0') throw new PrepareError(`Unmerged file in the git index: ${rel}.`);
    if (REGULAR_FILE_MODES.has(mode) && /^[0-9a-f]{40,64}$/.test(oid)) entries.set(rel, oid);
  }
  const contents = new Map();
  if (entries.size === 0) return contents;
  const oids = [...new Set(entries.values())];
  const output = git(sourceDir, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  const blobs = new Map();
  let pos = 0;
  while (pos < output.length) {
    const eol = output.indexOf(0x0a, pos);
    if (eol < 0) throw new PrepareError('Unexpected git cat-file output.');
    const [oid, type, size] = output.subarray(pos, eol).toString('utf8').split(' ');
    if (type !== 'blob' || !/^\d+$/.test(size ?? '')) {
      throw new PrepareError(`Could not read ${oid} from the git index.`);
    }
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(oid, Buffer.from(output.subarray(start, end)));
    pos = end + 1;
  }
  for (const [rel, oid] of entries) {
    const blob = blobs.get(oid);
    if (!blob) throw new PrepareError(`Could not read ${rel} from the git index.`);
    contents.set(rel, blob);
  }
  return contents;
}

/** Parses repeated `--pin name=version` values. Versions must be exact. */
export function parsePins(values) {
  const pins = {};
  for (const value of values) {
    const at = value.lastIndexOf('=');
    const name = at > 0 ? value.slice(0, at) : '';
    const version = at > 0 ? value.slice(at + 1) : '';
    if (!name || !EXACT_VERSION.test(version)) {
      throw new PrepareError(`Invalid --pin "${value}": expected name=x.y.z (an exact version).`);
    }
    pins[name] = version;
  }
  return pins;
}

/** Replaces `workspace:*` dependencies by the exact pinned versions. */
export function pinWorkspaceDependencies(pkg, pins) {
  const next = structuredClone(pkg);
  const used = new Set();
  const missing = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = next[section];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
      const version = pins[name];
      if (!version) {
        missing.push(name);
      } else {
        deps[name] = version;
        used.add(name);
      }
    }
  }
  if (missing.length > 0) {
    throw new PrepareError(
      `Missing --pin for workspace dependencies: ${[...new Set(missing)].join(', ')}.`,
    );
  }
  const unused = Object.keys(pins).filter((name) => !used.has(name));
  return { pkg: next, unused };
}

/** Standalone `package.json`: pinned deps, no test tooling, TypeScript added. */
export function buildPackageJson(pkg, { pins, typescriptVersion }) {
  if (!typescriptVersion || !EXACT_VERSION.test(typescriptVersion)) {
    throw new PrepareError('The TypeScript version must be exact (--typescript x.y.z).');
  }
  const { pkg: pinned, unused } = pinWorkspaceDependencies(pkg, pins);
  const devDependencies = { ...(pinned.devDependencies ?? {}) };
  for (const name of TEST_DEV_DEPENDENCIES) delete devDependencies[name];
  devDependencies.typescript = typescriptVersion;
  const scripts = { ...(pinned.scripts ?? {}) };
  for (const name of REMOVED_SCRIPTS) delete scripts[name];
  const sorted = Object.fromEntries(
    Object.entries(devDependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { pkg: { ...pinned, scripts, devDependencies: sorted }, unused };
}

/** `tsconfig.json` without `extends`: the base options are merged under the app options. */
export function inlineTsconfig(appTsconfig, readBase) {
  const { extends: base, ...rest } = appTsconfig;
  if (!base) return appTsconfig;
  const baseConfig = readBase(base);
  return {
    ...(baseConfig.$schema ? { $schema: baseConfig.$schema } : {}),
    ...rest,
    compilerOptions: { ...(baseConfig.compilerOptions ?? {}), ...(rest.compilerOptions ?? {}) },
  };
}

/** `.npmrc` content: the scope line only, and only for a private registry. */
export function buildNpmrc({ registry, scope }) {
  if (!registry && !scope) return null;
  if (!registry || !scope) {
    throw new PrepareError('--registry and --scope must be given together.');
  }
  let url;
  try {
    url = new URL(registry);
  } catch {
    throw new PrepareError('--registry must be a URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new PrepareError('--registry must be an https URL without credentials.');
  }
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new PrepareError('--scope must look like @owner.');
  }
  return `${scope}:registry=${url.toString().replace(/\/$/, '')}\n`;
}

/** Tracked paths that pass the filters, sorted. Contents are read separately (git index). */
function selectFiles(tracked) {
  const files = new Set();
  for (const raw of tracked) {
    const rel = raw.split(sep).join('/').replace(/^\.\//, '');
    if (rel.split('/').some((part) => part === '..' || part === '' || part === '.')) continue;
    if (!isIncluded(rel)) continue;
    files.add(rel);
  }
  return [...files].sort();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Builds the template repository content. With `dryRun` nothing is written. Returns the list of
 * output files (relative paths) and the generated files.
 */
export function prepareTemplateRepo(options) {
  const {
    out,
    pins = {},
    registry,
    scope,
    typescriptVersion,
    dryRun = false,
    sourceDir = SOURCE_DIR,
    listFiles = listTrackedFiles,
    // Returns a Map rel -> Buffer for the regular files among `rels`. Symlinks are never followed:
    // a tracked link could point at a secret outside the folder.
    readFiles = readIndexFiles,
  } = options;
  if (!out) throw new PrepareError('--out <dir> is required.');
  const outDir = resolve(out);
  if (isInside(sourceDir, outDir) || isInside(outDir, sourceDir)) {
    throw new PrepareError('The output folder must be outside the template folder.');
  }
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new PrepareError('The output folder exists and is not empty: nothing was written.');
  }

  const own = readFiles(sourceDir, ['package.json', 'tsconfig.json']);
  if (!own.has('package.json')) throw new PrepareError('package.json is not tracked by git.');
  const sourcePackage = JSON.parse(own.get('package.json').toString('utf8'));
  const rootPackagePath = resolve(sourceDir, '../../package.json');
  const version =
    typescriptVersion ??
    (existsSync(rootPackagePath)
      ? JSON.parse(readFileSync(rootPackagePath, 'utf8')).devDependencies?.typescript
      : undefined);
  const { pkg, unused } = buildPackageJson(sourcePackage, { pins, typescriptVersion: version });
  const npmrc = buildNpmrc({ registry, scope });

  const generated = new Map();
  generated.set('package.json', stringify(pkg));
  generated.set('vercel.json', stringify(VERCEL_JSON));
  if (npmrc) generated.set('.npmrc', npmrc);
  if (own.has('tsconfig.json')) {
    const tsconfig = inlineTsconfig(JSON.parse(own.get('tsconfig.json').toString('utf8')), (base) =>
      JSON.parse(readFileSync(resolve(sourceDir, base), 'utf8')),
    );
    generated.set('tsconfig.json', stringify(tsconfig));
  }

  const selected = selectFiles(listFiles(sourceDir)).filter((rel) => !generated.has(rel));
  const read = readFiles(sourceDir, selected);
  const contents = new Map(
    selected.filter((rel) => read.has(rel)).map((rel) => [rel, read.get(rel)]),
  );
  const files = [...new Set([...contents.keys(), ...generated.keys()])].sort();

  // Every output file is checked before anything is written.
  const findings = [];
  for (const [rel, content] of [...contents, ...generated]) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    for (const name of findSecrets(text)) findings.push(`${rel} (${name})`);
  }
  if (findings.length > 0) {
    throw new PrepareError(
      `Possible secrets found, nothing was written: ${findings.join(', ')}. Remove them first.`,
    );
  }

  if (!dryRun) {
    for (const [rel, content] of contents) {
      const target = join(outDir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    for (const [rel, content] of generated) {
      const target = join(outDir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  return { outDir, dryRun, files, generated: Object.fromEntries(generated), unusedPins: unused };
}

function parseArgs(argv) {
  const options = { pins: [], dryRun: false };
  const valueOf = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PrepareError(`${flag} needs a value.`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--out') {
      options.out = valueOf(i, arg);
      i += 1;
    } else if (arg === '--pin') {
      options.pins.push(valueOf(i, arg));
      i += 1;
    } else if (arg === '--registry') {
      options.registry = valueOf(i, arg);
      i += 1;
    } else if (arg === '--scope') {
      options.scope = valueOf(i, arg);
      i += 1;
    } else if (arg === '--typescript') {
      options.typescriptVersion = valueOf(i, arg);
      i += 1;
    } else {
      throw new PrepareError(`Unknown argument: ${arg}`);
    }
  }
  return { ...options, pins: parsePins(options.pins) };
}

function main() {
  try {
    const result = prepareTemplateRepo(parseArgs(process.argv.slice(2)));
    const verb = result.dryRun ? 'Dry run, nothing written. Would write' : 'Wrote';
    console.log(`${verb} ${result.files.length} files to ${result.outDir}`);
    if (result.dryRun) for (const file of result.files) console.log(`  ${file}`);
    for (const name of result.unusedPins) {
      console.warn(`Warning: --pin ${name} matches no dependency.`);
    }
    console.log('File contents were read from the git index (staged state), not the working tree.');
    console.log('Nothing was pushed or published. Review the folder, then push it by hand.');
  } catch (error) {
    if (error instanceof PrepareError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
