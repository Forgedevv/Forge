import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/theme/theme.css', import.meta.url)), 'utf8');

/** Every `font-size` and `font` shorthand size of the theme, in rem. */
function remSizes(source: string): Array<{ rule: string; rem: number }> {
  const out: Array<{ rule: string; rem: number }> = [];
  for (const match of source.matchAll(/font(?:-size)?:\s*([^;}]+)/g)) {
    const value = match[1] as string;
    // The size is the first length of the declaration (after an optional weight).
    const size = /(?:^|\s)(\d*\.?\d+)rem/.exec(value);
    if (size) out.push({ rule: match[0], rem: Number(size[1]) });
  }
  return out;
}

describe('theme type', () => {
  it('keeps every text at 12px (0.75rem) or more', () => {
    const sizes = remSizes(css);
    expect(sizes.length).toBeGreaterThan(20);
    expect(sizes.filter((s) => s.rem < 0.75).map((s) => s.rule)).toEqual([]);
  });

  it('wraps the hero title between words, with hyphenation, never mid-word anywhere', () => {
    const hero = css.match(/\.launchpad-hero h1 \{[^}]*\}/g) ?? [];
    expect(hero.length).toBeGreaterThan(1);
    for (const rule of hero) expect(rule).not.toContain('overflow-wrap: anywhere');
    expect(hero[0]).toContain('overflow-wrap: break-word');
    expect(hero[0]).toContain('hyphens: auto');
    // Phones: a fluid size instead of 16vw.
    expect(hero.some((rule) => /font-size: clamp\([^)]*12vw/.test(rule))).toBe(true);
  });
});
