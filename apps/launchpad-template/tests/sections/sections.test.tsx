// @vitest-environment jsdom
import '../helpers/dom-setup';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: true }));

// Every effect reads the preference through the shared hook: still frames keep the tests quiet.
vi.mock('@/components/library/shared/useReducedMotion', () => ({
  useReducedMotion: () => h.reduced,
}));

import { content } from '@/content';
import { LIBRARY } from '@/components/library/registry';
import type { LibraryMood } from '@/components/library/types';
import { SECTIONS, SECTION_SLOTS, SLOT_DEFAULTS } from '@/components/sections/registry';
import { HeroPosterType } from '@/components/sections/hero/HeroPosterType';
import { HeroSplitCoin } from '@/components/sections/hero/HeroSplitCoin';
import { CoinSpotlight } from '@/components/sections/coin/CoinSpotlight';
import { FaqAccordion } from '@/components/sections/faq/FaqAccordion';
import { FooterWordmark } from '@/components/sections/footer/FooterWordmark';
import { renderCatalogueJson, renderCatalogueMarkdown } from './catalogue';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

afterEach(() => {
  h.reduced = true;
});

describe('section catalogue', () => {
  it('has unique kebab-case ids and complete entries', () => {
    const ids = SECTIONS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const effectIds = new Set(LIBRARY.map((e) => e.id));
    for (const entry of SECTIONS) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.id.startsWith(`${entry.slot}-`), entry.id).toBe(true);
      expect(entry.description.length).toBeGreaterThan(30);
      expect(entry.moods.length).toBeGreaterThan(0);
      for (const effect of entry.effects) expect(effectIds.has(effect), effect).toBe(true);
    }
  });

  it('offers at least three variants for every slot', () => {
    for (const slot of SECTION_SLOTS) {
      expect(SECTIONS.filter((e) => e.slot === slot).length, slot).toBeGreaterThanOrEqual(3);
      expect(existsSync(join(ROOT, SLOT_DEFAULTS[slot])), SLOT_DEFAULTS[slot]).toBe(true);
    }
  });

  it('points every importPath at a file that exports the named component', async () => {
    for (const entry of SECTIONS) {
      expect(entry.importPath).toBe(`@/components/sections/${entry.slot}/${entry.exportName}`);
      const file = join(SRC, `${entry.importPath.replace('@/', '')}.tsx`);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(/* @vite-ignore */ entry.importPath)) as Record<string, unknown>;
      expect(mod[entry.exportName], entry.exportName).toBe(entry.Component);
    }
  });

  it('keeps the agent catalogue in sync with the registries', () => {
    const files = [
      [join(SRC, 'components/sections/CATALOGUE.md'), renderCatalogueMarkdown()],
      [join(SRC, 'components/sections/catalogue.json'), renderCatalogueJson()],
    ] as const;
    for (const [file, expected] of files) {
      if (process.env.UPDATE_CATALOGUE === '1') writeFileSync(file, expected);
      expect(existsSync(file), `${file}: run the test with UPDATE_CATALOGUE=1`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${file}: run the test with UPDATE_CATALOGUE=1`).toBe(
        expected,
      );
    }
    const markdown = renderCatalogueMarkdown();
    for (const entry of [...SECTIONS, ...LIBRARY]) expect(markdown).toContain(`\`${entry.id}\``);
  });
});

describe('section rendering', () => {
  it('renders every variant on the server with the site copy and one heading', () => {
    for (const entry of SECTIONS) {
      const html = renderToString(<entry.Component />);
      expect(html.length, entry.id).toBeGreaterThan(100);
      if (entry.slot === 'hero') {
        expect(html, entry.id).toContain('<h1');
        expect(html, entry.id).toContain(content.tagline);
      } else if (entry.slot === 'values') {
        // Selling points have no heading by default: the section is named by `valuesLabel`.
        expect(html, entry.id).toContain(content.strings.valuesLabel);
      } else if (entry.slot !== 'footer') {
        expect(html, entry.id).toContain('<h2');
      }
    }
  });

  it('mounts every variant in the browser without throwing, with motion reduced or not', () => {
    for (const reduced of [true, false]) {
      h.reduced = reduced;
      for (const entry of SECTIONS) {
        const { unmount, container } = render(<entry.Component />);
        expect(container.textContent?.length, entry.id).toBeGreaterThan(0);
        unmount();
      }
    }
  });

  it('gives every hero one h1 that names it, or a section label, and the tagline', () => {
    for (const reduced of [true, false]) {
      h.reduced = reduced;
      for (const entry of SECTIONS.filter((e) => e.slot === 'hero')) {
        const { container, unmount } = render(<entry.Component />);
        const headings = container.querySelectorAll('h1');
        expect(headings.length, entry.id).toBe(1);
        expect(headings[0]?.textContent, entry.id).toContain(content.name);
        const section = container.querySelector('section');
        const labelledBy = section?.getAttribute('aria-labelledby');
        if (labelledBy) {
          expect(container.querySelector(`[id="${labelledBy}"]`)?.tagName, entry.id).toBe('H1');
        } else {
          expect(section?.getAttribute('aria-label'), entry.id).toBe(content.name);
        }
        expect(container.textContent, entry.id).toContain(content.tagline);
        unmount();
      }
    }
  });

  it('offers heroes in every mood, so the mood rotation always has a choice', () => {
    const heroes = SECTIONS.filter((e) => e.slot === 'hero');
    expect(heroes.length).toBeGreaterThanOrEqual(16);
    const moods: LibraryMood[] = [
      'playful',
      'premium',
      'tech',
      'calm',
      'bold',
      'retro',
      'organic',
      'dark',
    ];
    for (const mood of moods) {
      expect(heroes.filter((e) => e.moods.includes(mood)).length, mood).toBeGreaterThanOrEqual(3);
    }
  });

  it('names each section by its heading', () => {
    const { container } = render(<FaqAccordion title="Asked often" />);
    const section = container.querySelector('section');
    const labelledBy = section?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`[id="${labelledBy}"]`)?.textContent).toBe('Asked often');
  });

  it('keeps two copies of a section on one page with distinct heading ids', () => {
    const { container } = render(
      <>
        <FaqAccordion />
        <FaqAccordion />
      </>,
    );
    const ids = [...container.querySelectorAll('section')].map((s) =>
      s.getAttribute('aria-labelledby'),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('takes copy props over the site content', () => {
    const html = renderToString(
      <HeroSplitCoin name="Moon Paw" tagline="Cats on the moon." primaryAction="Launch a paw" />,
    );
    expect(html).toContain('Cats on the moon.');
    expect(html).toContain('Launch a paw');
    expect(html).toContain('href="/create-pool"');
  });

  it('puts the last word of a poster name in the brand colour', () => {
    const html = renderToString(<HeroPosterType name="Moon Paw Club" />);
    expect(html).toMatch(/<em[^>]*>Club<\/em>/);
  });

  it('shows the pending note until the launchpad coin exists', () => {
    const html = renderToString(<CoinSpotlight symbol="PAW" />);
    expect(html).toContain(content.launchpadCoin.pendingNote);
    expect(html).toContain('$PAW');
  });

  it('links the footer to every page of the site', () => {
    const html = renderToString(<FooterWordmark />);
    for (const href of ['/#markets', '/create-pool', '/about', '/creator-fees']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
