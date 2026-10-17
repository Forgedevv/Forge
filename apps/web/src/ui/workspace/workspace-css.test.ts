// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('./workspace.css', import.meta.url), 'utf8');

/** Every `selector { body }` rule (media queries unwrapped), comments removed. */
function rules(css: string): { selector: string; body: string }[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

describe('workspace styles on touch screens', () => {
  it('gives buttons, links and toggles a tap target of at least 40px', () => {
    const interactive = /(^|[\s,>])(a|button|summary)\b|fw-button|fw-icon-button/;
    const small = rules(CSS).filter(({ selector, body }) => {
      const height = /min-height:\s*(\d+)px/.exec(body);
      return height && Number(height[1]) < 40 && interactive.test(selector);
    });
    expect(small.map((rule) => rule.selector)).toEqual([]);
  });

  it('never lets a focused field zoom the page on iOS', () => {
    expect(CSS).toMatch(/\.fw textarea,\s*\.fw input[^{]*\{\s*font-size: 16px;/);
  });
});
