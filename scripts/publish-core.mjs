#!/usr/bin/env node
/**
 * Builds, packs, checks and publishes `@forge/shared` and `@forge/core` to the public npm registry
 * under the `@forgedevv` scope (`@forgedevv/shared`, `@forgedevv/core`, decision D26).
 *
 * Inside the monorepo the packages keep their names (`@forge/core`, `@forge/shared`) and stay
 * `private` (a stray `pnpm publish` from their folder is refused). This script stages a copy of each
 * package in a temporary folder (outside the repo) with a publish manifest:
 * - the npm name (`@forgedevv/...`), no `private`, no scripts, no dev dependencies;
 * - every `workspace:` dependency rewritten to an exact npm alias, so `@forgedevv/core` depends on
 *   `"@forge/shared": "npm:@forgedevv/shared@<exact version>"` and its compiled `import
 *   '@forge/shared'` keeps resolving;
 * - a clean `tsc` build without source maps (`dist`: ESM `.js` + `.d.ts` only).
 *
 * Each staged package is packed with `pnpm pack`, then the tarball is checked: only `package.json`,
 * README, CHANGELOG, LICENSE and `dist/**.{js,d.ts}`; no tests, fixtures, sources, source maps,
 * `.env`, `.npmrc` or keys; no secret shape in any file; name, version, exports, license,
 * repository, `publishConfig.access: public` and exact dependencies.
 *
 * Publishing: `npm publish --dry-run` by default (nothing is uploaded). A real publish needs
 * `--publish` AND an `NPM_TOKEN` provided by the operator through the environment. The token is
 * never written to disk, logged or put on a command line: the temporary npm config only holds the
 * `${NPM_TOKEN}` placeholder, which npm expands itself. Every npm/pnpm child runs outside the repo
 * with an isolated config (no user or global `.npmrc`, no inherited `npm_config_*` variables).
 *
 * Usage:
 *   node scripts/publish-core.mjs                       dry run of shared then core
 *   node scripts/publish-core.mjs --only core           dry run of core only
 *   NPM_TOKEN=... node scripts/publish-core.mjs --publish [--only core] [--otp 123456]
 *   Options: --keep (keep the temporary folder and print its path), --skip-registry-check.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { findSecrets } from '../apps/launchpad-template/scripts/prepare-template-repo.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The only registry this script talks to. */
export const REGISTRY = 'https://registry.npmjs.org/';

/** Workspace name -> npm name. Order matters: a package is published after its dependencies. */
export const PUBLISH_NAMES = Object.freeze({
  '@forge/shared': '@forgedevv/shared',
  '@forge/core': '@forgedevv/core',
});

/** Publishable packages: folder and the `exports` subpaths the tarball must serve. */
export const PACKAGES = Object.freeze({
  shared: { workspaceName: '@forge/shared', dir: 'packages/shared', exports: ['.'] },
  core: { workspaceName: '@forge/core', dir: 'packages/core', exports: ['.', './launch-check'] },
});

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Manifest fields copied to the published manifest (everything else is dropped). */
const KEPT_FIELDS = [
  'version',
  'description',
  'license',
  'repository',
  'homepage',
  'bugs',
  'keywords',
  'engines',
  'type',
  'sideEffects',
  'main',
  'types',
  'exports',
  'files',
  'publishConfig',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
];
const DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
/** Extra files copied next to `dist` when present in the package folder. */
const DOC_FILES = ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md'];

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Publish manifest of a workspace package. `versions` maps every workspace package name to its
 * (exact) version; `workspace:` dependencies become `npm:<published name>@<exact version>`.
 */
export function buildPublishManifest(pkg, versions) {
  const publishName = PUBLISH_NAMES[pkg.name];
  if (!publishName) throw new PublishError(`${pkg.name} is not a publishable package.`);
  if (typeof pkg.version !== 'string' || !EXACT_VERSION.test(pkg.version)) {
    throw new PublishError(`${pkg.name}: version must be exact (x.y.z), got ${pkg.version}.`);
  }
  const out = { name: publishName };
  for (const field of KEPT_FIELDS) {
    if (pkg[field] !== undefined) out[field] = structuredClone(pkg[field]);
  }
  out.publishConfig = { ...(isObject(pkg.publishConfig) ? pkg.publishConfig : {}) };
  out.publishConfig.access = 'public';
  out.publishConfig.registry = REGISTRY;
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = out[section];
    if (!isObject(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
      const target = PUBLISH_NAMES[name];
      const version = versions[name];
      if (!target) {
        throw new PublishError(`${pkg.name}: workspace dependency ${name} is not published.`);
      }
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        throw new PublishError(`${pkg.name}: no exact version known for ${name}.`);
      }
      deps[name] = `npm:${target}@${version}`;
    }
  }
  return out;
}

/** Problems of a published manifest (empty when it is fine). */
export function checkManifest(manifest, { name, version, versions = {}, files, exports = ['.'] }) {
  const problems = [];
  if (manifest.name !== name) problems.push(`name is ${manifest.name}, expected ${name}`);
  if (manifest.version !== version) {
    problems.push(`version is ${manifest.version}, expected ${version}`);
  }
  if (typeof manifest.version !== 'string' || !EXACT_VERSION.test(manifest.version)) {
    problems.push('version is not an exact x.y.z version');
  }
  if (manifest.private !== undefined) problems.push('manifest has "private"');
  if (manifest.scripts !== undefined) problems.push('manifest has scripts (install scripts)');
  if (manifest.bundleDependencies || manifest.bundledDependencies) {
    problems.push('manifest bundles dependencies');
  }
  if (manifest.publishConfig?.access !== 'public')
    problems.push('publishConfig.access is not public');
  if (
    manifest.publishConfig?.registry !== undefined &&
    manifest.publishConfig.registry !== REGISTRY
  ) {
    problems.push(`publishConfig.registry is not ${REGISTRY}`);
  }
  if (typeof manifest.license !== 'string' || manifest.license.length === 0) {
    problems.push('license is missing');
  }
  const repoUrl = isObject(manifest.repository) ? manifest.repository.url : manifest.repository;
  if (typeof repoUrl !== 'string' || repoUrl.length === 0) problems.push('repository is missing');
  if (manifest.type !== 'module') problems.push('type is not "module" (ESM)');

  const publishedNames = new Set(Object.values(PUBLISH_NAMES));
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section];
    if (deps === undefined) continue;
    if (!isObject(deps)) {
      problems.push(`${section} is not an object`);
      continue;
    }
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range !== 'string') {
        problems.push(`${section}.${dep} is not a string`);
        continue;
      }
      if (EXACT_VERSION.test(range)) continue;
      const alias = /^npm:(@[a-z0-9._-]+\/[a-z0-9._-]+)@(.+)$/.exec(range);
      if (!alias) {
        problems.push(`${section}.${dep} is not an exact version or npm alias: ${range}`);
        continue;
      }
      const [, target, aliasVersion] = alias;
      if (!publishedNames.has(target) || PUBLISH_NAMES[dep] !== target) {
        problems.push(`${section}.${dep} aliases an unexpected package: ${target}`);
      }
      if (!EXACT_VERSION.test(aliasVersion)) {
        problems.push(`${section}.${dep} alias version is not exact: ${aliasVersion}`);
      } else if (versions[dep] !== undefined && versions[dep] !== aliasVersion) {
        problems.push(`${section}.${dep} is ${aliasVersion}, the workspace has ${versions[dep]}`);
      }
    }
  }

  if (files) {
    const targets = [];
    const collect = (value) => {
      if (typeof value === 'string') targets.push(value);
      else if (isObject(value)) Object.values(value).forEach(collect);
      else if (value !== undefined && value !== null)
        problems.push('exports has a non-string target');
    };
    collect(manifest.exports);
    if (manifest.main) targets.push(manifest.main);
    if (manifest.types) targets.push(manifest.types);
    for (const target of targets) {
      const rel = target.replace(/^\.\//, '');
      if (!files.has(rel)) problems.push(`${target} is referenced but not in the tarball`);
    }
    for (const subpath of exports) {
      if (!isObject(manifest.exports) || manifest.exports[subpath] === undefined) {
        problems.push(`exports does not serve "${subpath}"`);
      }
    }
  }
  return problems;
}

/** Reads a `.tgz` (gzip + ustar, pax and GNU long names). Returns `{ path, type, content }[]`. */
export function readTarGz(buffer) {
  const data = gunzipSync(buffer);
  const entries = [];
  const text = (buf, start, length) => {
    const raw = buf.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
  };
  let offset = 0;
  let nextPath = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const sizeText = text(header, 124, 12).trim();
    if (!/^[0-7]*$/.test(sizeText)) throw new PublishError('Malformed tar header.');
    const size = sizeText ? parseInt(sizeText, 8) : 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const magic = text(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? text(header, 345, 155) : '';
    const name = text(header, 0, 100);
    const start = offset + 512;
    if (start + size > data.length) throw new PublishError('Truncated tarball.');
    const content = Buffer.from(data.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const pax = content.toString('utf8');
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax);
      if (match) nextPath = match[1];
      continue;
    }
    if (type === 'L') {
      nextPath = content.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = null;
    entries.push({ path, type: type === '\0' ? '0' : type, content });
  }
  return entries;
}

/** Paths (relative to `package/`) a published tarball may contain. */
const ALLOWED_FILE =
  /^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE(?:\.md)?|dist\/.+\.(?:js|d\.ts))$/;
/** Absolute paths of the machine that built the package (user name, work folder). */
const LOCAL_PATH =
  /\b[A-Za-z]:[\x5c/](?:Users|Documents and Settings)[\x5c/]|\/(?:home|Users)\/[A-Za-z0-9._-]+\/|forge-publish-[A-Za-z0-9]{6}/;
/** Paths that are always refused, even when they match ALLOWED_FILE. */
const DENIED_FILES = [
  { name: 'test file', pattern: /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]*$/ },
  { name: 'test fixture', pattern: /(?:^|\/)(?:__fixtures__|__mocks__|tests?|fixtures)\// },
  { name: 'test fixture', pattern: /\.fixtures?\.[^/]*$/ },
  { name: 'mock', pattern: /(?:^|\/)[^/]*mock[^/]*$/i },
  { name: 'source map', pattern: /\.map$/ },
  { name: 'environment file', pattern: /(?:^|\/)\.env/i },
  { name: 'npm config', pattern: /(?:^|\/)\.npmrc$/i },
  { name: 'key file', pattern: /\.(?:pem|key)$|(?:^|\/)id_|keypair/i },
  { name: 'state folder', pattern: /(?:^|\/)\.state\// },
  { name: 'assistant notes', pattern: /(?:^|\/)(?:CLAUDE[^/]*|AGENTS)\.md$|(?:^|\/)\.claude\//i },
];

/**
 * Checks a packed tarball. Returns `{ manifest, files, problems }`; `problems` is empty when the
 * tarball can be published.
 */
export function checkTarball(buffer, expected) {
  const problems = [];
  let entries;
  try {
    entries = readTarGz(buffer);
  } catch (error) {
    return { manifest: null, files: new Set(), problems: [`unreadable tarball: ${error.message}`] };
  }
  const files = new Map();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (
      parts[0] !== 'package' ||
      isAbsolute(entry.path) ||
      parts.some((p) => p === '..' || p === '.') ||
      entry.path.includes('\\')
    ) {
      problems.push(`unsafe path ${entry.path}`);
      continue;
    }
    if (entry.type === '5') continue;
    if (entry.type !== '0') {
      problems.push(`${entry.path} is not a regular file (type ${entry.type})`);
      continue;
    }
    const rel = parts.slice(1).join('/');
    for (const { name, pattern } of DENIED_FILES) {
      if (pattern.test(rel)) problems.push(`${rel} is a ${name}`);
    }
    if (!ALLOWED_FILE.test(rel)) problems.push(`${rel} is not an expected file`);
    const textContent = entry.content.toString('utf8');
    for (const secret of findSecrets(textContent)) problems.push(`${rel} contains a ${secret}`);
    if (/sourceMappingURL=/.test(textContent)) problems.push(`${rel} references a source map`);
    if (LOCAL_PATH.test(textContent)) problems.push(`${rel} contains a local absolute path`);
    files.set(rel, entry.content);
  }
  let manifest = null;
  const raw = files.get('package.json');
  if (!raw) {
    problems.push('package.json is missing');
  } else {
    try {
      manifest = JSON.parse(raw.toString('utf8'));
    } catch {
      problems.push('package.json is not valid JSON');
    }
  }
  if (manifest) {
    problems.push(...checkManifest(manifest, { ...expected, files: new Set(files.keys()) }));
  }
  if (!files.has('dist/index.js') || !files.has('dist/index.d.ts')) {
    problems.push('dist/index.js or dist/index.d.ts is missing');
  }
  return { manifest, files: new Set(files.keys()), problems };
}

/**
 * Content of the temporary npm config. The token, when needed, is the `${NPM_TOKEN}` placeholder:
 * npm expands it from the environment, the value is never written anywhere.
 */
export function npmConfigContent({ withToken }) {
  const host = new URL(REGISTRY).host;
  const lines = [`registry=${REGISTRY}`];
  if (withToken) lines.push(`//${host}/:_authToken=\${NPM_TOKEN}`);
  return `${lines.join('\n')}\n`;
}

/** Arguments of `npm publish` for one tarball. A dry run unless `dryRun` is explicitly false. */
export function npmPublishArgs({ tarball, userconfig, globalconfig, dryRun = true, otp }) {
  const args = [
    'publish',
    tarball,
    `--registry=${REGISTRY}`,
    '--access=public',
    '--tag=latest',
    '--ignore-scripts',
    `--userconfig=${userconfig}`,
    `--globalconfig=${globalconfig}`,
  ];
  if (dryRun !== false) args.push('--dry-run');
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

/**
 * Environment of the npm/pnpm children: no inherited npm config (it could carry another registry
 * or token) and no `NPM_TOKEN` unless `withToken`.
 */
export function childEnv(env, { withToken = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^npm_config_/i.test(key) || /^pnpm_config_/i.test(key)) continue;
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_PACKAGES_TOKEN)$/i.test(key)) continue;
    out[key] = value;
  }
  if (withToken) out.NPM_TOKEN = env.NPM_TOKEN;
  return out;
}

/** Parses the command line. `env` is only read to check that a token is present. */
export function parseArgs(argv, env = {}) {
  const options = { publish: false, only: 'all', keep: false, otp: undefined, registryCheck: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--publish') options.publish = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--skip-registry-check') options.registryCheck = false;
    else if (arg === '--only' || arg === '--otp') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new PublishError(`${arg} needs a value.`);
      if (arg === '--only') {
        if (value !== 'core' && value !== 'shared' && value !== 'all') {
          throw new PublishError('--only must be core, shared or all.');
        }
        options.only = value;
      } else {
        if (!/^\d{6,8}$/.test(value)) throw new PublishError('--otp must be a one-time code.');
        options.otp = value;
      }
      i += 1;
    } else {
      throw new PublishError(`Unknown argument: ${arg}`);
    }
  }
  if (options.publish && !env.NPM_TOKEN) {
    throw new PublishError(
      '--publish needs NPM_TOKEN in the environment (an npm token allowed to publish @forgedevv packages).',
    );
  }
  if (!options.publish && options.otp) throw new PublishError('--otp is only used with --publish.');
  return options;
}

/** Keys of PACKAGES to handle, in publish order. */
export function selectedPackages(only) {
  return only === 'all' ? ['shared', 'core'] : [only];
}

const quoteForCmd = (arg) => {
  if (/["%^&|<>!\r\n]/.test(arg))
    throw new PublishError(`Refusing a shell-unsafe argument: ${arg}`);
  return /[\s()]/.test(arg) ? `"${arg}"` : arg;
};

/** Runs a package-manager CLI without a shell (a `.cmd` shim on Windows needs one: args are quoted). */
function runTool(tool, args, { cwd, env, capture = false }) {
  const windows = process.platform === 'win32';
  const command = windows ? `${tool}.cmd` : tool;
  const finalArgs = windows ? args.map(quoteForCmd) : args;
  return execFileSync(windows ? quoteForCmd(command) : command, finalArgs, {
    cwd,
    env,
    shell: windows,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Versions of every publishable workspace package, read from the monorepo. */
export function workspaceVersions(root = REPO_ROOT) {
  const versions = {};
  for (const info of Object.values(PACKAGES)) {
    const pkg = readJson(join(root, info.dir, 'package.json'));
    if (pkg.name !== info.workspaceName) {
      throw new PublishError(`${info.dir}/package.json is named ${pkg.name}.`);
    }
    versions[pkg.name] = pkg.version;
  }
  return versions;
}

function tsc(root, tsconfig, extraArgs) {
  const require = createRequire(join(root, 'package.json'));
  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscBin, '-p', tsconfig, ...extraArgs], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * Builds, stages and packs the selected packages into `workDir` (outside the repo). Nothing touches
 * the network. Returns one entry per package with the tarball path and its check result.
 */
export function packPackages({ only = 'all', workDir, root = REPO_ROOT, env = process.env }) {
  if (!workDir) throw new PublishError('workDir is required.');
  const rel = relative(root, resolve(workDir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new PublishError('The work folder must be outside the repository.');
  }
  const versions = workspaceVersions(root);
  // Every package is compiled into the work folder (the repo's dist folders are never touched).
  // Shared is always compiled first: core compiles against those declarations.
  const stages = {};
  for (const key of ['shared', 'core']) {
    if (key === 'core' && !selectedPackages(only).includes('core')) continue;
    const info = PACKAGES[key];
    const stage = join(workDir, 'stage', key);
    mkdirSync(stage, { recursive: true });
    const tsconfig = join(workDir, `tsconfig.${key}.json`);
    const compilerOptions = {
      outDir: join(stage, 'dist'),
      sourceMap: false,
      declarationMap: false,
      incremental: false,
    };
    if (key === 'core') {
      compilerOptions.paths = {
        [PACKAGES.shared.workspaceName]: [join(stages.shared, 'dist', 'index.d.ts')],
      };
    }
    writeFileSync(
      tsconfig,
      JSON.stringify({ extends: join(root, info.dir, 'tsconfig.build.json'), compilerOptions }),
    );
    tsc(root, tsconfig, []);
    stages[key] = stage;
  }

  const results = [];
  for (const key of selectedPackages(only)) {
    const info = PACKAGES[key];
    const pkgDir = join(root, info.dir);
    const source = readJson(join(pkgDir, 'package.json'));
    const manifest = buildPublishManifest(source, versions);
    const stage = stages[key];
    for (const file of DOC_FILES) {
      if (existsSync(join(pkgDir, file))) copyFileSync(join(pkgDir, file), join(stage, file));
    }
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const outDir = join(workDir, 'tarballs', key);
    mkdirSync(outDir, { recursive: true });
    runTool('pnpm', ['pack', '--pack-destination', outDir], { cwd: stage, env: childEnv(env) });
    const tarballs = readdirSync(outDir).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length !== 1)
      throw new PublishError(`pnpm pack produced ${tarballs.length} tarballs.`);
    const tarball = join(outDir, tarballs[0]);
    const buffer = readFileSync(tarball);
    const check = checkTarball(buffer, {
      name: manifest.name,
      version: manifest.version,
      versions,
      exports: info.exports,
    });
    results.push({
      key,
      name: manifest.name,
      version: manifest.version,
      tarball,
      bytes: buffer.length,
      integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
      files: check.files,
      manifest: check.manifest,
      problems: check.problems,
    });
  }
  return results;
}

/** `npm view <name>@<version> version`: true when that exact version is on the registry. */
function isPublished(name, version, { cwd, env, userconfig, globalconfig }) {
  try {
    const out = runTool(
      'npm',
      [
        'view',
        `${name}@${version}`,
        'version',
        '--json',
        `--registry=${REGISTRY}`,
        `--userconfig=${userconfig}`,
        `--globalconfig=${globalconfig}`,
      ],
      { cwd, env, capture: true },
    );
    return out.trim().length > 0;
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (/E404|404 Not Found|is not in this registry/i.test(stderr)) return false;
    throw new PublishError(`npm view ${name}@${version} failed: ${stderr.trim().slice(0, 300)}`);
  }
}

function gitClean(root, dirs) {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...dirs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

/** Full run: pack and check, then `npm publish` (dry run unless `--publish`). */
export function run(options, { root = REPO_ROOT, env = process.env, log = console.log } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'forge-publish-'));
  const dryRun = !options.publish;
  try {
    if (
      !dryRun &&
      !gitClean(
        root,
        Object.values(PACKAGES).map((p) => p.dir),
      )
    ) {
      throw new PublishError(
        'packages/core or packages/shared has uncommitted changes: commit first.',
      );
    }
    const results = packPackages({ only: options.only, workDir, root, env });
    const failed = results.filter((r) => r.problems.length > 0);
    for (const r of results) {
      log(`${r.name}@${r.version}: ${r.files.size} files, ${r.bytes} bytes, ${r.integrity}`);
      for (const problem of r.problems) log(`  problem: ${problem}`);
    }
    if (failed.length > 0) {
      throw new PublishError(`Tarball check failed for ${failed.map((r) => r.name).join(', ')}.`);
    }

    const userconfig = join(workDir, 'npmrc');
    const globalconfig = join(workDir, 'npmrc-global');
    writeFileSync(userconfig, npmConfigContent({ withToken: !dryRun }));
    writeFileSync(globalconfig, '');
    // Reads never carry the token: their user config only names the registry.
    const readConfig = join(workDir, 'npmrc-read');
    writeFileSync(readConfig, npmConfigContent({ withToken: false }));
    const npmCwd = join(workDir, 'npm');
    mkdirSync(npmCwd, { recursive: true });
    const readEnv = childEnv(env);
    const publishedNow = new Set();
    for (const r of results) {
      if (options.registryCheck) {
        // Read-only registry checks: the version must be new, its aliased dependencies must exist.
        const view = { cwd: npmCwd, env: readEnv, userconfig: readConfig, globalconfig };
        const warnOrFail = (message) => {
          if (dryRun) log(`  warning: ${message}`);
          else throw new PublishError(message);
        };
        try {
          if (isPublished(r.name, r.version, view)) {
            warnOrFail(`${r.name}@${r.version} is already on npm: bump the version.`);
          }
          for (const range of Object.values(r.manifest.dependencies ?? {})) {
            const alias = /^npm:(@[^@]+)@(.+)$/.exec(range);
            if (!alias || publishedNow.has(`${alias[1]}@${alias[2]}`)) continue;
            if (!isPublished(alias[1], alias[2], view)) {
              warnOrFail(`${alias[1]}@${alias[2]} is not on npm yet: publish it first.`);
            }
          }
        } catch (error) {
          if (!dryRun || !(error instanceof PublishError)) throw error;
          log(`  warning: registry check skipped (${error.message})`);
        }
      }
      log(`${dryRun ? 'Dry run: npm publish' : 'Publishing'} ${r.name}@${r.version}`);
      runTool(
        'npm',
        npmPublishArgs({ tarball: r.tarball, userconfig, globalconfig, dryRun, otp: options.otp }),
        { cwd: npmCwd, env: childEnv(env, { withToken: !dryRun }) },
      );
      publishedNow.add(`${r.name}@${r.version}`);
    }
    log('');
    log(dryRun ? 'Dry run only: nothing was uploaded.' : 'Published.');
    log('Client repositories depend on (exact versions, no .npmrc, no token):');
    for (const r of results) {
      const workspaceName = PACKAGES[r.key].workspaceName;
      log(`  "${workspaceName}": "npm:${r.name}@${r.version}"`);
    }
    return results;
  } finally {
    if (options.keep) log(`Work folder kept: ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
}

function main() {
  try {
    run(parseArgs(process.argv.slice(2), process.env));
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
