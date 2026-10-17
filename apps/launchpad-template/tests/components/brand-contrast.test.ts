import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildThemeCss, contrastRgb } from '../../src/theme';

/**
 * Buttons and chips filled with the client's brand colour must take their text colour from the
 * contrast token (`primary-950`, set by `buildThemeCss` from the brand colour's luminance), never a
 * fixed white or black: a yellow or lime brand would make white text unreadable.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** String literals (quotes or backticks) that hold Tailwind classes. */
function classStrings(source: string): string[] {
  return [...source.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2] as string);
}

/** Primary fills that carry no text (progress bars). */
const NO_TEXT = new Set(['src/components/TokenHeader/BondingCurve.tsx']);

describe('text on the brand colour', () => {
  const files = sourceFiles(join(root, 'src')).map((f) => relative(root, f).replace(/\\/g, '/'));

  it('never hard-codes white text or a fallback brand colour on a primary fill', () => {
    const offending: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      if (/#7c3aed/i.test(source)) offending.push(`${file}: hard-coded fallback brand colour`);
      for (const value of classStrings(source)) {
        const filled = /(?:^|\s)(?:[a-z-]+:)*bg-primary(?=\s|$)|bg-\[var\(--color-primary/.test(
          value,
        );
        if (!filled) continue;
        if (/(?:^|\s)text-(?:white|black|neutral-\d+)(?=\s|$)/.test(value)) {
          offending.push(`${file}: "${value}"`);
        } else if (!NO_TEXT.has(file) && !/(?:^|\s)text-primary-950(?=\s|$)/.test(value)) {
          offending.push(`${file}: no contrast token in "${value}"`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('picks dark text on light brands and white text on dark ones', () => {
    expect(contrastRgb([250, 204, 21])).toEqual([15, 23, 42]); // yellow
    expect(contrastRgb([163, 230, 53])).toEqual([15, 23, 42]); // lime
    expect(contrastRgb([124, 58, 237])).toEqual([255, 255, 255]); // violet
    expect(buildThemeCss({ primaryColor: '#FACC15', accentColor: '#000000' })).toContain(
      '--primary-950: 15 23 42;',
    );
  });
});
