import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const importsOf = (source: string) =>
  [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
/** Source without comments, for a strict look at the code of a file. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();

describe('the /creator-fees route of every live site', () => {
  it('is a minimal locked route: one re-export of the locked page', () => {
    expect(code(read('src/pages/creator-fees.tsx'))).toBe(
      "export { default } from '@/forge/pages/CreatorFeesPage';",
    );
  });

  it('has no other route file competing for the path', () => {
    const pages = readdirSync(join(root, 'src/pages'));
    expect(pages.filter((name) => name.toLowerCase().startsWith('creator-fees'))).toEqual([
      'creator-fees.tsx',
    ]);
  });

  it('the page imports nothing from the free zones and mounts the locked claim widget', () => {
    const file = 'src/forge/pages/CreatorFeesPage.tsx';
    const source = read(file);
    for (const spec of importsOf(source)) {
      const relative = spec.startsWith('./') || spec.startsWith('../');
      const allowed = relative
        ? resolve(root, dirname(file), spec).startsWith(join(root, 'src', 'forge'))
        : spec.startsWith('@/forge/') || !spec.startsWith('@/');
      expect(allowed, `${file} imports ${spec}`).toBe(true);
    }
    expect(importsOf(source)).toContain('../ClaimCreatorFees');
    expect(source).toContain('<ClaimCreatorFees />');
  });
});
