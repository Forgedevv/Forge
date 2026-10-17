// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../app', import.meta.url));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === 'page.tsx' || name === 'layout.tsx' ? [path] : [];
  });
}

/** The literal `title: '...'` values of a page or layout module. */
function titles(source: string): string[] {
  return [...source.matchAll(/title:\s*'([^']*)'/g)].map((match) => match[1]!);
}

describe('tab titles', () => {
  const files = pages(APP);

  it('finds the pages of the app', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((file) => [relative(APP, file), file]))(
    '%s has a readable title',
    (_name, file) => {
      for (const title of titles(readFileSync(file, 'utf8'))) {
        // A lost em dash shows up as `?` or as the replacement character.
        expect(title).not.toMatch(/[?�]/);
        expect(title.trim()).toBe(title);
        expect(title.length).toBeGreaterThan(0);
      }
    },
  );

  it('ends the information pages with the brand', () => {
    for (const page of ['faq/page.tsx', 'terms/page.tsx']) {
      const [title] = titles(readFileSync(join(APP, page), 'utf8'));
      expect(title).toMatch(/^\S.* — FORGE$/);
    }
  });
});
