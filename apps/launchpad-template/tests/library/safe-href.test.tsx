// @vitest-environment jsdom
import '../helpers/dom-setup';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/library/shared/useReducedMotion', () => ({ useReducedMotion: () => true }));

import { HoverPreviewList } from '@/components/library/motion/HoverPreviewList';
import { MagneticButton } from '@/components/library/motion/MagneticButton';
import { PillNav } from '@/components/library/motion/PillNav';
import { isExternalHref, safeHref } from '@/components/library/shared/safeHref';
import { FooterColumns } from '@/components/sections/footer/FooterColumns';
import { PrimaryAction } from '@/components/sections/shared';

/**
 * Library and section components take link targets as props, which the builder's scan sees as
 * plain strings: they must refuse every target a site may not link to by themselves.
 */

describe('safeHref', () => {
  it('keeps paths and anchors of this site', () => {
    expect(safeHref('/create-pool')).toBe('/create-pool');
    expect(safeHref('/#markets')).toBe('/#markets');
    expect(safeHref('#faq')).toBe('#faq');
    expect(safeHref('/token/abc?tab=trades')).toBe('/token/abc?tab=trades');
    expect(safeHref('about')).toBe('/about');
    // A same-scheme URL without slashes is a path of this site, as in a browser: it never leaves.
    expect(safeHref('https:/evil.example')).toBe('/evil.example');
  });

  it('keeps https pages on the allowed social and explorer hosts', () => {
    expect(safeHref('https://x.com/forge')).toBe('https://x.com/forge');
    expect(safeHref('https://t.me/forge')).toBe('https://t.me/forge');
    expect(safeHref('https://solscan.io/token/abc')).toBe('https://solscan.io/token/abc');
  });

  it('refuses every other target', () => {
    for (const target of [
      'https://evil.example/claim',
      'http://x.com/forge',
      'https://x.com.evil.example/',
      'https://user:pass@x.com/',
      'https://x.com:8443/',
      '//evil.example/claim',
      '/\\evil.example/claim',
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,hi',
      'mailto:a@b.c',
      '',
      undefined,
      42,
    ]) {
      expect(safeHref(target), String(target)).toBeUndefined();
    }
  });

  it('tells external targets apart', () => {
    expect(isExternalHref('https://x.com/forge')).toBe(true);
    expect(isExternalHref('/about')).toBe(false);
  });
});

describe('components with links', () => {
  it('renders a magnetic button, not a link, for a forbidden target', () => {
    const html = renderToString(<MagneticButton href="https://evil.example">Claim</MagneticButton>);
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<button');
    const ok = renderToString(<MagneticButton href="https://x.com/forge">Follow</MagneticButton>);
    expect(ok).toContain('href="https://x.com/forge"');
    expect(ok).toContain('rel="noopener noreferrer"');
  });

  it('leaves forbidden items out of the pill navigation', () => {
    const { container } = render(
      <PillNav
        items={[
          { label: 'Home', href: '/' },
          { label: 'Claim', href: 'https://evil.example' },
        ]}
      />,
    );
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/']);
  });

  it('turns a forbidden preview row into a button', () => {
    const { container } = render(
      <HoverPreviewList items={[{ id: 'a', title: 'Claim', href: 'javascript:alert(1)' }]} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('renders forbidden section links as text', () => {
    const html = renderToString(
      <>
        <PrimaryAction href="https://evil.example/claim">Claim</PrimaryAction>
        <FooterColumns links={[{ href: '//evil.example', label: 'Airdrop' }]} />
      </>,
    );
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Claim');
    expect(html).toContain('Airdrop');
  });
});

describe('targets that turn into another site once normalised', () => {
  it('refuses paths whose dot segments leave a protocol-relative link', () => {
    for (const target of [
      '/.//evil.example/claim',
      '/a/..//evil.example',
      '/%2e//evil.example',
      './/evil.example',
      'https://site.invalid//evil.example',
    ]) {
      expect(safeHref(target), target).toBeUndefined();
    }
    const html = renderToString(
      <MagneticButton href="/.//evil.example/claim">Claim</MagneticButton>,
    );
    expect(html).not.toContain('evil.example');
  });
});
