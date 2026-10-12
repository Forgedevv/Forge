import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_READ_COMMANDS,
  PrepareError,
  VERCEL_JSON,
  buildNpmrc,
  inlineTsconfig,
  isIncluded,
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
  it('writes a standalone package.json with exact versions', () => {
    const out = freshOut();
    prepareTemplateRepo({ out, pins: PINS });
    const pkg = readJson(join(out, 'package.json'));
    expect(pkg.dependencies['@forge/core']).toBe('1.2.3');
    expect(pkg.dependencies['@forge/shared']).toBe('1.2.4');
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

  it('writes no .npmrc without a private registry', () => {
    const out = freshOut();
    const result = prepareTemplateRepo({ out, pins: PINS });
    expect(existsSync(join(out, '.npmrc'))).toBe(false);
    expect(result.files).not.toContain('.npmrc');
  });

  it('writes only the scope line for a private registry', () => {
    const out = freshOut();
    prepareTemplateRepo({
      out,
      pins: PINS,
      registry: 'https://npm.pkg.github.com',
      scope: '@forgedevv',
    });
    expect(readFileSync(join(out, '.npmrc'), 'utf8')).toBe(
      '@forgedevv:registry=https://npm.pkg.github.com\n',
    );
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

  it('rejects a registry without a scope, with credentials or over http', () => {
    expect(buildNpmrc({})).toBeNull();
    expect(() => buildNpmrc({ registry: 'https://npm.pkg.github.com' })).toThrow(PrepareError);
    expect(() => buildNpmrc({ registry: 'http://npm.example', scope: '@a' })).toThrow(PrepareError);
    expect(() => buildNpmrc({ registry: 'https://user:pw@npm.example', scope: '@a' })).toThrow(
      PrepareError,
    );
    expect(() => buildNpmrc({ registry: 'https://npm.example', scope: 'a' })).toThrow(PrepareError);
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
