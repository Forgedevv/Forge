import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_READ_COMMANDS,
  PrepareError,
  NPM_PACKAGES,
  VERCEL_JSON,
  assertPublicDependencies,
  inlineTsconfig,
  isIncluded,
  npmAlias,
  parseArgs,
  parsePins,
  pinWorkspaceDependencies,
  prepareTemplateRepo,
  // @ts-expect-error plain ES module without type declarations
} from '../../scripts/prepare-template-repo.mjs';

const appDir = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = join(appDir, 'scripts', 'prepare-template-repo.mjs');
const PINS = { '@forge/core': '1.2.3', '@forge/shared': '1.2.4' };

const tmpDirs: string[] = [];
function freshOut(): string {
  const base = mkdtempSync(join(tmpdir(), 'forge-template-'));
  tmpDirs.push(base);
  return join(base, 'out');
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('prepare-template-repo: dry run', () => {
  it('lists the files and writes nothing', () => {
    const out = freshOut();
    const result = prepareTemplateRepo({ out, pins: PINS, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect(result.files).toEqual(expect.arrayContaining(['package.json', 'vercel.json']));
    expect(result.files).toContain('src/forge/trade/core-adapter.ts');
    expect(result.files).toContain('.env.example');
    expect(result.files).toContain('LICENSE.md');
  });

  it('leaves out tests, dev tooling, mocks, caches and local env files', () => {
    const { files } = prepareTemplateRepo({ out: freshOut(), pins: PINS, dryRun: true });
    const forbidden = files.filter(
      (file: string) =>
        file.startsWith('tests/') ||
        file.startsWith('scripts/') ||
        file.startsWith('node_modules/') ||
        file.startsWith('.next/') ||
        /\.(test|spec)\./.test(file) ||
        (/(^|\/)\.env(\.|$)/.test(file) && file !== '.env.example') ||
        file === 'vitest.config.mjs' ||
        file === 'eslint.config.mjs' ||
        file.endsWith('core-adapter.mock.ts') ||
        file.endsWith('mock-core.ts') ||
        file.endsWith('test-fixtures.ts'),
    );
    expect(forbidden).toEqual([]);
  });

  it('refuses an output folder inside the template folder', () => {
    expect(() =>
      prepareTemplateRepo({ out: join(appDir, 'out'), pins: PINS, dryRun: true }),
    ).toThrow(PrepareError);
  });
});

describe('prepare-template-repo: written output', () => {
  it('writes a standalone package.json with exact npm aliases of the public packages', () => {
    const out = freshOut();
    prepareTemplateRepo({ out, pins: PINS });
    const pkg = readJson(join(out, 'package.json'));
    // The site keeps importing @forge/core and @forge/shared; npm installs @forgedevv/*.
    expect(pkg.dependencies['@forge/core']).toBe('npm:@forgedevv/core@1.2.3');
    expect(pkg.dependencies['@forge/shared']).toBe('npm:@forgedevv/shared@1.2.4');
    expect(pkg.dependencies['@forgedevv/core']).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeUndefined();
    expect(pkg.devDependencies.typescript).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.devDependencies.jsdom).toBeUndefined();
    expect(pkg.scripts.build).toBe('next build');
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.scripts.lint).toBeUndefined();
  });

  it('writes vercel.json with Git deployments disabled', () => {
    const out = freshOut();
    prepareTemplateRepo({ out, pins: PINS });
    expect(readJson(join(out, 'vercel.json'))).toEqual({ git: { deploymentEnabled: false } });
    expect(VERCEL_JSON).toEqual({ git: { deploymentEnabled: false } });
  });

  it('inlines the tsconfig base so that the repository stands alone', () => {
    const out = freshOut();
    prepareTemplateRepo({ out, pins: PINS });
    const tsconfig = readJson(join(out, 'tsconfig.json'));
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.moduleResolution).toBe('Bundler');
  });

  it('writes no .npmrc: no registry, scope or token reaches the template repository', () => {
    const out = freshOut();
    const result = prepareTemplateRepo({ out, pins: PINS });
    expect(existsSync(join(out, '.npmrc'))).toBe(false);
    expect(result.files.some((f: string) => f.endsWith('.npmrc'))).toBe(false);
    for (const content of Object.values(result.generated) as string[]) {
      expect(content).not.toMatch(/npm\.pkg\.github\.com|_authToken|registry=/);
    }
  });

  it('refuses the removed private registry options', () => {
    const out = freshOut();
    expect(() =>
      prepareTemplateRepo({ out, pins: PINS, registry: 'https://npm.pkg.github.com' }),
    ).toThrow(/no longer supported/);
    expect(() => prepareTemplateRepo({ out, pins: PINS, scope: '@forgedevv' })).toThrow(
      /no longer supported/,
    );
    expect(() => parseArgs(['--out', out, '--registry', 'https://npm.pkg.github.com'])).toThrow(
      /no longer supported/,
    );
    expect(() => parseArgs(['--out', out, '--scope', '@forgedevv'])).toThrow(/no longer supported/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a non-empty output folder', () => {
    const out = freshOut();
    prepareTemplateRepo({ out, pins: PINS });
    expect(() => prepareTemplateRepo({ out, pins: PINS })).toThrow(/not empty/);
  });
});

describe('prepare-template-repo: helpers', () => {
  it('fails when a workspace dependency has no pin', () => {
    const pkg = { dependencies: { '@forge/core': 'workspace:*', '@forge/shared': 'workspace:*' } };
    expect(() => pinWorkspaceDependencies(pkg, { '@forge/core': '1.0.0' })).toThrow(
      /@forge\/shared/,
    );
    expect(() => prepareTemplateRepo({ out: freshOut(), pins: {}, dryRun: true })).toThrow(
      /Missing --pin/,
    );
  });

  it('only accepts exact versions', () => {
    expect(parsePins(['@forge/core=1.2.3'])).toEqual({ '@forge/core': '1.2.3' });
    for (const bad of ['@forge/core=^1.2.3', '@forge/core=1.2', '@forge/core=latest', '=1.0.0']) {
      expect(() => parsePins([bad])).toThrow(PrepareError);
    }
  });

  it('maps the FORGE packages to their public npm names (D26)', async () => {
    expect(NPM_PACKAGES).toEqual({
      '@forge/core': '@forgedevv/core',
      '@forge/shared': '@forgedevv/shared',
    });
    // The names the release script publishes under are the names the template installs.
    // @ts-expect-error plain ES module without type declarations
    const { PUBLISH_NAMES } = await import('../../../../scripts/publish-core.mjs');
    expect(PUBLISH_NAMES).toEqual(NPM_PACKAGES);
    expect(npmAlias('@forge/core', '0.1.0')).toBe('npm:@forgedevv/core@0.1.0');
    expect(() => npmAlias('@forge/web', '0.1.0')).toThrow(/not published/);
    expect(() => npmAlias('@forge/core', '^0.1.0')).toThrow(/exact/);
    const pinned = pinWorkspaceDependencies(
      { dependencies: { '@forge/core': 'workspace:*' }, devDependencies: { x: '1.0.0' } },
      { '@forge/core': '2.0.0' },
    );
    expect(pinned.pkg.dependencies['@forge/core']).toBe('npm:@forgedevv/core@2.0.0');
    expect(() =>
      pinWorkspaceDependencies(
        { dependencies: { '@forge/web': 'workspace:*' } },
        { '@forge/web': '1.0.0' },
      ),
    ).toThrow(/not published/);
  });

  it('only lets public npm specs through', () => {
    const ok = { dependencies: { '@forge/core': 'npm:@forgedevv/core@1.0.0', next: '15.5.27' } };
    expect(assertPublicDependencies(ok)).toBe(ok);
    for (const dependencies of [
      { '@forge/core': '1.0.0' },
      { '@forge/core': 'npm:@forgedevv/core@^1.0.0' },
      { '@forge/core': 'npm:@evil/core@1.0.0' },
      { '@forge/shared': 'npm:@forgedevv/core@1.0.0' },
      { '@forge/core': 'workspace:*' },
      { other: 'file:../core' },
      { other: 'link:../core' },
    ]) {
      expect(
        () => assertPublicDependencies({ dependencies }),
        JSON.stringify(dependencies),
      ).toThrow(PrepareError);
    }
  });

  it('merges the tsconfig base under the app options', () => {
    const merged = inlineTsconfig(
      { extends: './base.json', compilerOptions: { module: 'ESNext' }, include: ['src'] },
      () => ({ compilerOptions: { module: 'NodeNext', strict: true } }),
    );
    expect(merged).toEqual({
      compilerOptions: { module: 'ESNext', strict: true },
      include: ['src'],
    });
  });

  it('keeps .env.example only', () => {
    expect(isIncluded('.env.example')).toBe(true);
    expect(isIncluded('.env')).toBe(false);
    expect(isIncluded('.env.local')).toBe(false);
    expect(isIncluded('src/forge/config.ts')).toBe(true);
    expect(isIncluded('src/forge/config.test.ts')).toBe(false);
  });
});

describe('prepare-template-repo: safety', () => {
  it('only runs read-only git commands, never touches the network', () => {
    const source = readFileSync(scriptPath, 'utf8');
    for (const forbidden of [
      'fetch(',
      'http.request',
      'https.request',
      'spawn',
      'execSync',
      'exec(',
      'shell: true',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/git (push|remote|tag)/);
    const calls = [...code.matchAll(/execFileSync\(([^)]*)/g)].map((match) => match[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^'git', \['-C', sourceDir, \.\.\.args\]/);
    expect(GIT_READ_COMMANDS).toEqual(['ls-files', 'cat-file']);
    const gitCalls = [...code.matchAll(/\bgit\(sourceDir, \['([a-z-]+)'/g)].map((m) => m[1]);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const command of gitCalls) expect(GIT_READ_COMMANDS).toContain(command);
  });
});
