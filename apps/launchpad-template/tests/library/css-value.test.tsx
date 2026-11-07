import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConicGlow } from '@/components/library/backgrounds/ConicGlow';
import { cssFontFamily, cssLength } from '@/components/library/shared/cssValue';

/** String props written into CSS: React's server render would emit an injected declaration. */
describe('CSS values from props', () => {
  it('keeps lengths and length expressions, refuses anything that adds a declaration', () => {
    expect(cssLength('34rem', 'x')).toBe('34rem');
    expect(cssLength('min(80vmin, 34rem)', 'x')).toBe('min(80vmin, 34rem)');
    expect(cssLength('calc(100% - 2rem)', 'x')).toBe('calc(100% - 2rem)');
    expect(cssLength('1px;background-image:url(https://evil.example/p)', 'x')).toBe('x');
    expect(cssLength('1px}body{display:none', 'x')).toBe('x');
    expect(cssLength(undefined, 'x')).toBe('x');
  });

  it('keeps font-family lists, refuses declarations and urls', () => {
    expect(cssFontFamily("'Syne Variable', system-ui, sans-serif")).toBe(
      "'Syne Variable', system-ui, sans-serif",
    );
    expect(cssFontFamily('var(--font-heading)')).toBe('var(--font-heading)');
    expect(cssFontFamily('serif;background:url(https://evil.example/p)')).toBeUndefined();
    expect(cssFontFamily('url(x)')).toBeUndefined();
  });

  it('never renders an injected size in the server markup', () => {
    const html = renderToString(
      <ConicGlow size="1px;background-image:url(https://evil.example/p)" />,
    );
    expect(html).not.toContain('evil.example');
  });
});
