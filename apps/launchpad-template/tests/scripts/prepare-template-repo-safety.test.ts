import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PrepareError,
  SECRET_PATTERNS,
  findSecrets,
  isDenied,
  isIncluded,
  listTrackedFiles,
  prepareTemplateRepo,
  // @ts-expect-error plain ES module without type declarations
} from '../../scripts/prepare-template-repo.mjs';

const PINS = { '@forge/core': '1.2.3' };
const TYPESCRIPT = '5.9.3';

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

const PACKAGE_JSON = JSON.stringify({
  name: 'fixture-template',
  scripts: { build: 'next build' },
  dependencies: { '@forge/core': 'workspace:*' },
});

/** Files a careless commit could carry: all of them must stay out of the output. */
const DENIED_FIXTURES: Record<string, string> = {
  '.npmrc': '@forgedevv:registry=https://npm.pkg.github.com\n',
  'src/nested/.npmrc': 'registry=https://registry.npmjs.org\n',
  'CLAUDE.md': 'notes\n',
  'CLAUDE.local.md': 'notes\n',
  'src/CLAUDE.md': 'notes\n',
  'AGENTS.md': 'notes\n',
  '.claude/settings.json': '{}\n',
  'src/.claude/notes.txt': 'notes\n',
  '.env': 'X=1\n',
  '.env.local': 'X=1\n',
  '.env.production': 'X=1\n',
  'src/.env.development': 'X=1\n',
  'server.pem': 'certificate\n',
  'certs/signer.key': 'key\n',
  'id_ed25519': 'key\n',
  'id_rsa.pub': 'key\n',
  'wallet-keypair.json': '[]\n',
  'keys/keypair.json': '[]\n',
  'devKeypairs.json': '[]\n',
  '.state/wallets/funder.json': '[]\n',
  'scripts/.state/x.json': '{}\n',
};

const KEPT_FIXTURES: Record<string, string> = {
  'package.json': PACKAGE_JSON,
  '.env.example': 'NEXT_PUBLIC_SOLANA_CLUSTER=devnet\n',
  'src/index.ts': "export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';\n",
  'README.md': '# Fixture\n',
};

function fixture(extra: Record<string, string> = {}) {
  const sourceDir = tempDir('forge-template-src-');
  const all = { ...KEPT_FIXTURES, ...DENIED_FIXTURES, ...extra };
  writeFiles(sourceDir, all);
  // An untracked file: present on disk, never listed by git.
  writeFiles(sourceDir, { 'src/untracked.ts': 'export {};\n', 'notes.txt': 'local\n' });
  const tracked = Object.keys(all);
  const out = join(tempDir('forge-template-out-'), 'out');
  return { sourceDir, tracked, out };
}

function run(f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) {
  return prepareTemplateRepo({
    out: f.out,
    pins: PINS,
    typescriptVersion: TYPESCRIPT,
    sourceDir: f.sourceDir,
    listFiles: () => f.tracked,
    ...options,
  });
}

describe('prepare-template-repo: tracked files only, denylist always applies', () => {
  it('copies only tracked files and leaves out every denied file, even when tracked', () => {
    const f = fixture();
    const result = run(f);
    expect(result.files).toEqual(
      ['.env.example', 'README.md', 'package.json', 'src/index.ts', 'vercel.json'].sort(),
    );
    for (const rel of Object.keys(DENIED_FIXTURES)) {
      expect(existsSync(join(f.out, ...rel.split('/'))), rel).toBe(false);
    }
    expect(existsSync(join(f.out, 'src', 'untracked.ts'))).toBe(false);
    expect(existsSync(join(f.out, 'notes.txt'))).toBe(false);
    expect(readFileSync(join(f.out, 'src', 'index.ts'), 'utf8')).toContain('SYSTEM_PROGRAM_ID');
  });

  it('writes the generated .npmrc only, never a tracked one', () => {
    const f = fixture();
    run(f, { registry: 'https://npm.pkg.github.com', scope: '@forgedevv' });
    expect(readFileSync(join(f.out, '.npmrc'), 'utf8')).toBe(
      '@forgedevv:registry=https://npm.pkg.github.com\n',
    );
    expect(existsSync(join(f.out, 'src', 'nested', '.npmrc'))).toBe(false);
  });

  it('skips tracked files missing on disk and paths escaping the folder', () => {
    const f = fixture();
    f.tracked.push('src/deleted.ts', '../outside.ts', 'src/../../outside.ts');
    const result = run(f, { dryRun: true });
    expect(result.files).not.toContain('src/deleted.ts');
    expect(result.files.some((file: string) => file.includes('..'))).toBe(false);
  });

  it('denies each listed shape', () => {
    for (const rel of Object.keys(DENIED_FIXTURES)) expect(isDenied(rel), rel).toBe(true);
    for (const rel of Object.keys(DENIED_FIXTURES)) expect(isIncluded(rel), rel).toBe(false);
    expect(isDenied('.env.example')).toBe(false);
    expect(isDenied('src/forge/config.ts')).toBe(false);
    expect(isDenied('src/forge/claims/core-adapter.ts')).toBe(false);
  });
});

describe('prepare-template-repo: git ls-files', () => {
  function hasGit(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it.skipIf(!hasGit())('lists the tracked files of a real repository, not the untracked ones', () => {
    const repo = tempDir('forge-template-git-');
    execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
    writeFiles(repo, {
      'app/package.json': PACKAGE_JSON,
      'app/src/index.ts': 'export {};\n',
      'app/src/untracked.ts': 'export {};\n',
      'other/file.ts': 'export {};\n',
    });
    execFileSync('git', ['-C', repo, 'add', 'app/package.json', 'app/src/index.ts', 'other/file.ts'], {
      stdio: 'ignore',
    });
    const sourceDir = join(repo, 'app');
    expect(listTrackedFiles(sourceDir).sort()).toEqual(['package.json', 'src/index.ts']);

    const out = join(tempDir('forge-template-out-'), 'out');
    const result = prepareTemplateRepo({
      out,
      pins: PINS,
      typescriptVersion: TYPESCRIPT,
      sourceDir,
    });
    expect(result.files).toEqual(['package.json', 'src/index.ts', 'vercel.json']);
    expect(existsSync(join(out, 'src', 'untracked.ts'))).toBe(false);
  });

  it('fails outside a git work tree', () => {
    const dir = tempDir('forge-template-nogit-');
    // A temp folder may sit inside a repository on some machines; only assert when it does not.
    let insideRepo = true;
    try {
      execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    } catch {
      insideRepo = false;
    }
    if (!insideRepo) expect(() => listTrackedFiles(dir)).toThrow(PrepareError);
  });

  it('lists the real template from git', () => {
    const files: string[] = listTrackedFiles(fileURLToPath(new URL('../../', import.meta.url)));
    expect(files).toContain('package.json');
    expect(files).toContain('src/forge/config.ts');
  });
});

/** One sample per secret shape, built at runtime so this file never holds a literal secret. */
const r = (chars: string, length: number) => chars.repeat(Math.ceil(length / chars.length)).slice(0, length);
const SECRET_SAMPLES: Record<string, string> = {
  'npm auth token': `//npm.pkg.github.com/:_${'authToken'}=abc\n`,
  'npm token': `const t = 'npm_${r('aB3', 36)}';\n`,
  'PEM block': `${'-----'}BEGIN PRIVATE KEY-----\nabc\n`,
  'secret key byte array': `${JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256))}\n`,
  'GitHub classic token': `token = 'gh${'p'}_${r('aB3d', 36)}'\n`,
  'GitHub app token': `token = 'gh${'s'}_${r('aB3d', 36)}'\n`,
  'GitHub fine-grained token': `token = 'github_${'pat'}_${r('aB3d_', 60)}'\n`,
  'Anthropic API key': `key = 'sk-${'ant'}-api03-${r('aB3-', 40)}'\n`,
  'AWS access key id': `id = 'AK${'IA'}${r('ABC234', 16)}'\n`,
  'R2 access key id': `id = '${r('a1b2c3', 32)}'\n`,
  'R2 secret': `secret = '${r('9f8e', 64)}'\n`,
  'storage secret assignment': `R2_SECRET_ACCESS_KEY=${r('Ab/9+', 40)}\n`,
};

describe('prepare-template-repo: secret scan', () => {
  it.each(Object.entries(SECRET_SAMPLES))('fails on a %s and writes nothing', (_name, sample) => {
    expect(findSecrets(sample).length).toBeGreaterThan(0);
    const f = fixture({ 'src/leak.ts': sample });
    let error: unknown;
    try {
      run(f);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PrepareError);
    expect((error as Error).message).toMatch(/src\/leak\.ts/);
    expect((error as Error).message).not.toContain(sample.trim());
    expect(existsSync(f.out)).toBe(false);
  });

  it('also fails in a dry run', () => {
    const f = fixture({ 'src/leak.ts': SECRET_SAMPLES['PEM block'] as string });
    expect(() => run(f, { dryRun: true })).toThrow(/Possible secrets/);
  });

  it('does not flag the system program id, base58 addresses or short arrays', () => {
    expect(findSecrets("const ID = '11111111111111111111111111111111';")).toEqual([]);
    expect(findSecrets("const P = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';")).toEqual([]);
    expect(findSecrets('const DISC = [1, 2, 3, 4, 5, 6, 7, 8];')).toEqual([]);
    expect(findSecrets('R2_PUBLIC_URL=https://your-public-bucket-url.example')).toEqual([]);
  });

  it('keeps the real template clean', () => {
    const out = join(tempDir('forge-template-out-'), 'out');
    expect(() =>
      prepareTemplateRepo({ out, pins: { '@forge/core': '1.0.0', '@forge/shared': '1.0.0' }, dryRun: true }),
    ).not.toThrow();
  });

  it('names every pattern', () => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      expect(typeof name).toBe('string');
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
