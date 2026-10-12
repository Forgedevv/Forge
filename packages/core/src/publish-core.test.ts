/**
 * Tests of scripts/publish-core.mjs (publication of @forge/core and @forge/shared on npm as
 * @forgedevv/core and @forgedevv/shared, decision D26). Unit tests build tarballs in memory; the
 * last suite builds and packs the real packages (no network: npm is never called).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISH_NAMES,
  PublishError,
  REGISTRY,
  buildPublishManifest,
  checkManifest,
  checkTarball,
  childEnv,
  npmConfigContent,
  npmPublishArgs,
  packPackages,
  parseArgs,
  readTarGz,
  selectedPackages,
  workspaceVersions,
  // @ts-expect-error plain ES module without type declarations
} from '../../../scripts/publish-core.mjs';

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  publishConfig?: Record<string, string>;
  license?: string;
  repository?: { url: string };
  type?: string;
  [key: string]: unknown;
}

const ROOT = new URL('../../../', import.meta.url);
const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(new URL(`${dir}/package.json`, ROOT), 'utf8')) as Manifest;

/** Minimal ustar writer (enough for readTarGz): `[path, content, type?]`. */
function tarGz(entries: Array<[string, string | Buffer, string?]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content, type = '0'] of entries) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(path.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    header.fill(' ', 148, 156);
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const GOOD_MANIFEST: Manifest = {
  name: '@forgedevv/core',
  version: '1.2.3',
  license: 'MIT',
  repository: { url: 'git+https://github.com/Forgedevv/Forge.git' },
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    './launch-check': { types: './dist/launch-check.d.ts', default: './dist/launch-check.js' },
  },
  publishConfig: { access: 'public', registry: REGISTRY },
  dependencies: {
    '@forge/shared': 'npm:@forgedevv/shared@1.2.4',
    '@solana/web3.js': '1.99.0',
  },
};
const EXPECTED = {
  name: '@forgedevv/core',
  version: '1.2.3',
  versions: { '@forge/shared': '1.2.4', '@forge/core': '1.2.3' },
  exports: ['.', './launch-check'],
};

function goodEntries(manifest: Manifest = GOOD_MANIFEST): Array<[string, string, string?]> {
  return [
    ['package/package.json', JSON.stringify(manifest)],
    ['package/README.md', '# core\n'],
    ['package/dist/index.js', "export * from './launch-check.js';\n"],
    ['package/dist/index.d.ts', "export * from './launch-check.js';\n"],
    ['package/dist/launch-check.js', 'export const x = 1;\n'],
    ['package/dist/launch-check.d.ts', 'export declare const x = 1;\n'],
  ];
}

const problemsOf = (entries: Array<[string, string | Buffer, string?]>): string[] =>
  (checkTarball(tarGz(entries), EXPECTED) as { problems: string[] }).problems;

describe('publish-core: workspace manifests', () => {
  it('maps the workspace names to the @forgedevv scope, shared first', () => {
    expect(PUBLISH_NAMES).toEqual({
      '@forge/shared': '@forgedevv/shared',
      '@forge/core': '@forgedevv/core',
    });
    expect(selectedPackages('all')).toEqual(['shared', 'core']);
    expect(selectedPackages('core')).toEqual(['core']);
  });

  it('core and shared stay private in the monorepo but are ready for a public npm release', () => {
    for (const dir of ['packages/core', 'packages/shared']) {
      const pkg = readManifest(dir);
      expect(pkg.private, dir).toBe(true);
      expect(pkg.publishConfig, dir).toEqual({ access: 'public', registry: REGISTRY });
      expect(pkg.license, dir).toBe('MIT');
      expect(pkg.repository?.url, dir).toBe('git+https://github.com/Forgedevv/Forge.git');
      expect(pkg.type, dir).toBe('module');
      expect(pkg.version, dir).toMatch(/^\d+\.\d+\.\d+$/);
      // Only compiled files are packed: never source maps, tests or sources.
      expect(pkg.files, dir).toEqual(
        expect.arrayContaining(['dist/**/*.js', 'dist/**/*.d.ts', '!dist/**/*.test.*']),
      );
      expect(pkg.files?.some((f) => f === 'dist' || f.includes('src') || f.endsWith('.map'))).toBe(
        false,
      );
      expect(JSON.stringify(pkg)).not.toMatch(/npm\.pkg\.github\.com|GITHUB_PACKAGES/);
    }
    expect(readManifest('packages/core').exports?.['./launch-check']).toEqual({
      types: './dist/launch-check.d.ts',
      default: './dist/launch-check.js',
    });
  });

  it('the core publish manifest depends on shared through an exact npm alias', () => {
    const versions = workspaceVersions() as Record<string, string>;
    const core = readManifest('packages/core');
    const published = buildPublishManifest(core, versions) as Manifest;
    expect(published.name).toBe('@forgedevv/core');
    expect(published.version).toBe(core.version);
    expect(published.private).toBeUndefined();
    expect(published.scripts).toBeUndefined();
    expect(published.devDependencies).toBeUndefined();
    expect(published.dependencies?.['@forge/shared']).toBe(
      `npm:@forgedevv/shared@${versions['@forge/shared']}`,
    );
    expect(JSON.stringify(published)).not.toContain('workspace:');
    expect(published.exports).toEqual(core.exports);
    expect(published.publishConfig).toEqual({ access: 'public', registry: REGISTRY });
    const shared = buildPublishManifest(readManifest('packages/shared'), versions) as Manifest;
    expect(shared.name).toBe('@forgedevv/shared');
    expect(shared.dependencies).toEqual({ zod: '4.6.5' });
  });

  it('refuses unknown packages, unpublished workspace dependencies and inexact versions', () => {
    const base = { name: '@forge/core', version: '1.0.0', dependencies: {} };
    expect(() => buildPublishManifest({ ...base, name: '@forge/web' }, {})).toThrow(PublishError);
    expect(() => buildPublishManifest({ ...base, version: '^1.0.0' }, {})).toThrow(/exact/);
    expect(() =>
      buildPublishManifest({ ...base, dependencies: { '@forge/signer': 'workspace:*' } }, {}),
    ).toThrow(/not published/);
    expect(() =>
      buildPublishManifest({ ...base, dependencies: { '@forge/shared': 'workspace:*' } }, {}),
    ).toThrow(/no exact version/);
    expect(
      buildPublishManifest(
        { ...base, private: true, publishConfig: { access: 'restricted', registry: 'https://x' } },
        {},
      ),
    ).toMatchObject({ publishConfig: { access: 'public', registry: REGISTRY } });
  });
});

describe('publish-core: tarball checks', () => {
  it('accepts a clean tarball', () => {
    const result = checkTarball(tarGz(goodEntries()), EXPECTED) as {
      problems: string[];
      files: Set<string>;
    };
    expect(result.problems).toEqual([]);
    expect([...result.files].sort()).toContain('dist/launch-check.js');
  });

  it('reads pax long names', () => {
    const long = `package/dist/${'a'.repeat(120)}.js`;
    const entries = readTarGz(
      tarGz([
        ['PaxHeader', `${long.length + 7 + String(long.length + 7).length} path=${long}\n`, 'x'],
        ['ignored-short-name', 'x'],
      ]),
    ) as Array<{ path: string }>;
    expect(entries.map((e) => e.path)).toEqual([long]);
  });

  it.each([
    ['package/dist/swap.test.js', 'export {};', 'test file'],
    ['package/dist/index.js.map', '{"sources":["../src/index.ts"]}', 'source map'],
    ['package/src/index.ts', 'export {};', 'not an expected file'],
    ['package/.env', 'X=1', 'environment file'],
    ['package/.npmrc', 'registry=x', 'npm config'],
    ['package/dist/__fixtures__/a.js', 'export {};', 'test fixture'],
    ['package/dist/swap.fixtures.js', 'export {};', 'test fixture'],
    ['package/dist/core-adapter.mock.js', 'export {};', 'mock'],
    ['package/keypair.json', '[]', 'key file'],
    ['package/CLAUDE.md', '#', 'assistant notes'],
    ['package/dist/x.tsbuildinfo', '{}', 'not an expected file'],
  ])('refuses %s', (path, content, reason) => {
    expect(problemsOf([...goodEntries(), [path, content]]).join('\n')).toContain(reason);
  });

  it('refuses secrets, source map references, unsafe paths and links', () => {
    expect(
      problemsOf([...goodEntries(), ['package/dist/a.js', '// -----BEGIN PRIVATE KEY-----']]),
    ).toContain('dist/a.js contains a PEM block');
    expect(
      problemsOf([...goodEntries(), ['package/dist/b.js', '//_authToken=abc\n']]).join('\n'),
    ).toContain('npm auth token');
    expect(
      problemsOf([...goodEntries(), ['package/dist/c.js', '//# sourceMappingURL=c.js.map']]),
    ).toContain('dist/c.js references a source map');
    for (const local of [
      'C:\\Users\\someone\\x',
      'c:/Users/someone/x',
      '/home/someone/forge/x',
      '/Users/me/x',
      'Temp/forge-publish-a1B2c3/stage',
    ]) {
      expect(
        problemsOf([...goodEntries(), ['package/dist/d.d.ts', `import('${local}')`]]),
        local,
      ).toContain('dist/d.d.ts contains a local absolute path');
    }
    expect(problemsOf([...goodEntries(), ['package/../evil.js', 'x']]).join('\n')).toContain(
      'unsafe path',
    );
    expect(problemsOf([...goodEntries(), ['other/a.js', 'x']]).join('\n')).toContain('unsafe path');
    expect(problemsOf([...goodEntries(), ['package/dist/l.js', '', '2']]).join('\n')).toContain(
      'not a regular file',
    );
  });

  it('refuses a manifest that is wrong for npm', () => {
    const cases: Array<[Partial<Manifest>, string]> = [
      [{ name: '@forge/core' }, 'name is @forge/core'],
      [{ version: '1.2.4' }, 'version is 1.2.4'],
      [{ private: true }, '"private"'],
      [{ scripts: { postinstall: 'node x' } }, 'install scripts'],
      [{ publishConfig: { access: 'restricted' } }, 'access is not public'],
      [{ publishConfig: { access: 'public', registry: 'https://npm.pkg.github.com' } }, 'registry'],
      [{ license: '' }, 'license'],
      [{ repository: undefined }, 'repository'],
      [{ type: 'commonjs' }, 'ESM'],
      [{ dependencies: { '@forge/shared': 'workspace:*' } }, 'not an exact version'],
      [{ dependencies: { '@solana/web3.js': '^1.99.0' } }, 'not an exact version'],
      [{ dependencies: { x: 'file:../x' } }, 'not an exact version'],
      [{ dependencies: { '@forge/shared': 'npm:@evil/shared@1.2.4' } }, 'unexpected package'],
      [{ dependencies: { '@forge/shared': 'npm:@forgedevv/shared@^1.2.4' } }, 'not exact'],
      [{ dependencies: { '@forge/shared': 'npm:@forgedevv/shared@1.2.5' } }, 'workspace has'],
      [{ exports: { '.': { default: './dist/index.js' } } }, 'does not serve "./launch-check"'],
      [
        {
          exports: {
            '.': './dist/index.js',
            './launch-check': './dist/missing.js',
          },
        },
        'not in the tarball',
      ],
    ];
    for (const [patch, reason] of cases) {
      const problems = problemsOf(goodEntries({ ...GOOD_MANIFEST, ...patch } as Manifest));
      expect(problems.join('\n'), reason).toContain(reason);
    }
    expect(problemsOf(goodEntries().slice(1)).join('\n')).toContain('package.json is missing');
    expect(checkManifest(GOOD_MANIFEST, EXPECTED)).toEqual([]);
  });
});

describe('publish-core: npm invocation', () => {
  it('is a dry run unless explicitly asked, and the token is only a placeholder', () => {
    const args = npmPublishArgs({ tarball: 't.tgz', userconfig: 'u', globalconfig: 'g' });
    expect(args).toContain('--dry-run');
    expect(args).toContain(`--registry=${REGISTRY}`);
    expect(args).toContain('--access=public');
    expect(args).toContain('--ignore-scripts');
    const real = npmPublishArgs({
      tarball: 't.tgz',
      userconfig: 'u',
      globalconfig: 'g',
      dryRun: false,
      otp: '123456',
    });
    expect(real).not.toContain('--dry-run');
    expect(real).toContain('--otp=123456');
    expect(npmConfigContent({ withToken: false })).toBe(`registry=${REGISTRY}\n`);
    expect(npmConfigContent({ withToken: true })).toBe(
      `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`,
    );
  });

  it('children get no inherited npm config and the token only when publishing', () => {
    const env = {
      PATH: '/bin',
      NPM_TOKEN: 'npm-token-value',
      NODE_AUTH_TOKEN: 'node-auth-value',
      GITHUB_PACKAGES_TOKEN: 'gh-value',
      npm_config_registry: 'https://npm.pkg.github.com',
      'NPM_CONFIG_//registry.npmjs.org/:_authToken': 'other',
    };
    expect(childEnv(env)).toEqual({ PATH: '/bin' });
    expect(childEnv(env, { withToken: true })).toEqual({
      PATH: '/bin',
      NPM_TOKEN: 'npm-token-value',
    });
  });

  it('parses the command line; --publish needs NPM_TOKEN', () => {
    expect(parseArgs([], {})).toMatchObject({ publish: false, only: 'all', registryCheck: true });
    expect(parseArgs(['--only', 'core', '--keep'], {})).toMatchObject({ only: 'core', keep: true });
    expect(() => parseArgs(['--publish'], {})).toThrow(/NPM_TOKEN/);
    expect(parseArgs(['--publish', '--otp', '123456'], { NPM_TOKEN: 'x' })).toMatchObject({
      publish: true,
      otp: '123456',
    });
    expect(() => parseArgs(['--otp', '123456'], {})).toThrow(/only used with --publish/);
    expect(() => parseArgs(['--only', 'web'], {})).toThrow(PublishError);
    expect(() => parseArgs(['--registry', 'https://x'], {})).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--otp', 'abc'], { NPM_TOKEN: 'x' })).toThrow(/one-time code/);
  });
});

describe('publish-core: real build and pack (no network)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('refuses a work folder inside the repository', () => {
    expect(() => packPackages({ workDir: fileURLToPath(new URL('./tmp-pack', ROOT)) })).toThrow(
      /outside the repository/,
    );
  });

  it('packs @forgedevv/shared and @forgedevv/core into clean, publishable tarballs', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'forge-publish-test-'));
    dirs.push(workDir);
    // Other suites import @forge/shared from its dist folder meanwhile: it must not be touched.
    const sharedDist = fileURLToPath(new URL('packages/shared/dist/index.js', ROOT));
    const before = statSync(sharedDist).mtimeMs;
    const results = packPackages({ only: 'all', workDir }) as Array<{
      name: string;
      problems: string[];
      files: Set<string>;
      manifest: Manifest;
    }>;
    expect(results.map((r) => r.name)).toEqual(['@forgedevv/shared', '@forgedevv/core']);
    expect(statSync(sharedDist).mtimeMs).toBe(before);
    for (const r of results) {
      expect(r.problems, r.name).toEqual([]);
      expect([...r.files].every((f) => !f.endsWith('.map') && !f.includes('.test.'))).toBe(true);
    }
    const core = results[1]!;
    expect(core.files).toContain('dist/launch-check.js');
    expect(core.files).toContain('dist/launch-check.d.ts');
    expect(core.files).toContain('CHANGELOG.md');
    expect(core.manifest.dependencies?.['@forge/shared']).toMatch(
      /^npm:@forgedevv\/shared@\d+\.\d+\.\d+$/,
    );
  }, 240_000);
});
