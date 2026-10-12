import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const importsOf = (source: string) =>
  [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string);

describe('ModeGate: locked files only', () => {
  it('_app reads no mode and imports no free-zone module but the app shell and global CSS', () => {
    const source = read('src/pages/_app.tsx');
    expect(source).not.toMatch(/siteConfig|\.mode\b/);
    expect(importsOf(source).sort()).toEqual(
      [
        '@/components/AppShell',
        '@/forge/AppProviders',
        '@/forge/ModeGate',
        '@/styles/globals.css',
        '@/theme/theme.css',
        'next/app',
      ].sort(),
    );
  });

  it('the mode pages moved to src/forge/modes', () => {
    const old = join(root, 'src/components/modes');
    expect(existsSync(old) ? readdirSync(old) : []).toEqual([]);
    expect(existsSync(join(root, 'src/forge/modes/DisabledPage.tsx'))).toBe(true);
    expect(existsSync(join(root, 'src/forge/modes/SleepingPage.tsx'))).toBe(true);
  });

  it('the gate, the mode pages and the providers import nothing from the free zones', () => {
    const files = [
      'src/forge/ModeGate.tsx',
      'src/forge/AppProviders.tsx',
      ...readdirSync(join(root, 'src/forge/modes')).map((name) => `src/forge/modes/${name}`),
    ];
    for (const file of files) {
      for (const spec of importsOf(read(file))) {
        const relative = spec.startsWith('./') || spec.startsWith('../');
        const allowed = relative
          ? resolve(root, dirname(file), spec).startsWith(join(root, 'src', 'forge'))
          : spec.startsWith('@/forge/') || !spec.startsWith('@/');
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});

describe('wallet provider config', () => {
  it('has no hardcoded network or jup.ag metadata', () => {
    const source = read('src/forge/AppProviders.tsx');
    expect(source).not.toMatch(/env:\s*'/);
    expect(source).not.toContain('jup.ag');
  });
});
