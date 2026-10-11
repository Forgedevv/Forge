#!/usr/bin/env node
/**
 * Prepares the content of the standalone template repository from `apps/launchpad-template`.
 *
 * It only reads this folder and writes into an output folder. It never runs git, never pushes,
 * never tags and never publishes: pushing the output to the template repository is a separate,
 * manual step.
 *
 * What it copies: only the files tracked by git in this folder (`git ls-files`), never untracked or
 * ignored files, minus a denylist that always applies (even to a file tracked by mistake): local
 * `.npmrc`, assistant notes, `.env*` other than `.env.example`, keys, keypairs and `.state/`. The
 * whole output is then scanned for secret shapes (registry tokens, private keys, keypair arrays,
 * GitHub and API tokens, storage keys); one match and nothing is written.
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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Files tracked by git in `sourceDir`, relative to it and `/` separated. Runs `git ls-files` only
 * (read-only, no shell). Fails when the folder is not inside a git work tree.
 */
export function listTrackedFiles(sourceDir) {
  let output;
  try {
    output = execFileSync('git', ['-C', sourceDir, 'ls-files', '-z', '--cached', '--', '.'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PrepareError(`Could not list the tracked files (git ls-files): ${reason}`);
  }
  return output.split('\0').filter((rel) => rel.length > 0);
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

/** Tracked files that exist on disk as regular files and pass the filters, sorted. */
function selectFiles(sourceDir, tracked) {
  const files = new Set();
  for (const raw of tracked) {
    const rel = raw.split(sep).join('/').replace(/^\.\//, '');
    if (rel.split('/').some((part) => part === '..' || part === '' || part === '.')) continue;
    if (!isIncluded(rel)) continue;
    const full = join(sourceDir, ...rel.split('/'));
    // Symlinks are never followed: a tracked link could point at a secret outside the folder.
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
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
  } = options;
  if (!out) throw new PrepareError('--out <dir> is required.');
  const outDir = resolve(out);
  if (isInside(sourceDir, outDir) || isInside(outDir, sourceDir)) {
    throw new PrepareError('The output folder must be outside the template folder.');
  }
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new PrepareError('The output folder exists and is not empty: nothing was written.');
  }

  const sourcePackage = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
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
  const tsconfigPath = join(sourceDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const tsconfig = inlineTsconfig(JSON.parse(readFileSync(tsconfigPath, 'utf8')), (base) =>
      JSON.parse(readFileSync(resolve(sourceDir, base), 'utf8')),
    );
    generated.set('tsconfig.json', stringify(tsconfig));
  }

  const copied = selectFiles(sourceDir, listFiles(sourceDir)).filter((rel) => !generated.has(rel));
  const files = [...new Set([...copied, ...generated.keys()])].sort();

  // Every output file is checked before anything is written.
  const contents = new Map(
    copied.map((rel) => [rel, readFileSync(join(sourceDir, ...rel.split('/')))]),
  );
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
