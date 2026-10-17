// @vitest-environment jsdom
import '../helpers/dom-setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildThemeCss } from '@/theme';

const theme = vi.hoisted(() => ({ resolvedTheme: 'dark' as string | undefined, setTheme: vi.fn() }));

vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Moon Pad',
    slug: 'moon-pad',
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'About the moon.' },
    mode: 'live',
  },
  onchainConfig: undefined,
  cluster: 'devnet',
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: theme.resolvedTheme, setTheme: theme.setTheme }),
}));

import { ThemeToggle } from '@/components/ThemeToggle';

afterEach(() => {
  theme.setTheme.mockReset();
  theme.resolvedTheme = 'dark';
});

describe('ThemeToggle', () => {
  it('renders the same neutral label on the server and before mount, whatever the theme', () => {
    for (const resolved of ['dark', 'light', undefined]) {
      theme.resolvedTheme = resolved;
      const html = renderToString(<ThemeToggle />);
      expect(html).toContain('aria-label="Switch colour mode"');
    }
  });

  it('hydrates without a mismatch, then names the mode it switches to', async () => {
    // The server does not know the visitor's mode; the browser does.
    theme.resolvedTheme = undefined;
    const container = document.createElement('div');
    container.innerHTML = renderToString(<ThemeToggle />);
    theme.resolvedTheme = 'dark';
    document.body.appendChild(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <ThemeToggle />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to light mode');
    errors.mockRestore();
    act(() => root?.unmount());
    container.remove();
  });

  it('switches the mode on click', () => {
    theme.resolvedTheme = 'light';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
  });
});

describe('primary tints in dark mode', () => {
  const triplet = (css: string, block: string, name: string) => {
    const scope = block === 'dark' ? css.slice(css.indexOf(':root:root.dark')) : css;
    const match = new RegExp(`--${name}: (\\d+) (\\d+) (\\d+);`).exec(scope);
    return match ? match.slice(1).map(Number) : null;
  };
  const luminance = ([r, g, b]: number[]) => (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;

  it('keeps primary-800 a soft tint in both modes: light in light mode, dark in dark mode', () => {
    for (const primaryColor of ['#7C3AED', '#FACC15', '#84CC16']) {
      const css = buildThemeCss({ primaryColor, accentColor: '#F59E0B' });
      expect(css).toContain(':root:root.dark {');
      expect(luminance(triplet(css, 'light', 'primary-800')!)).toBeGreaterThan(0.8);
      expect(luminance(triplet(css, 'dark', 'primary-800')!)).toBeLessThan(0.2);
      expect(luminance(triplet(css, 'dark', 'primary-900')!)).toBeLessThan(0.15);
    }
  });
});
