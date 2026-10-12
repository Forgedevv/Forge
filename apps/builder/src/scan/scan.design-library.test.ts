import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { builderSystemPrompt } from '../prompts/index.js';
import { added, modified, rulesOf, scan, scanComponent } from './test-helpers.js';

/**
 * The design library installed in the launchpad template (fonts, icon sets, motion, carousel,
 * animated numbers): code written the way the builder prompt describes must pass the scan.
 */

const FONTS_BASELINE = `/** Web fonts of the site. */\nexport {};\n`;

describe('design library', () => {
  it('allows web font imports in src/theme/fonts.ts', () => {
    const fonts = [
      `/** Web fonts: a display and a text family. */`,
      `import '@fontsource-variable/syne/index.css';`,
      `import '@fontsource-variable/inter/index.css';`,
      `import '@fontsource/instrument-serif/400-italic.css';`,
      ``,
    ].join('\n');
    const theme = `:root {\n  --font-heading: 'Syne Variable', 'Avenir Next', system-ui, sans-serif;\n  --font-body: 'Inter Variable', system-ui, sans-serif;\n}\n`;
    const result = scan([
      modified('src/theme/fonts.ts', FONTS_BASELINE, fonts),
      added('src/theme/fonts-extra.css', theme),
    ]);
    expect(rulesOf(result)).toEqual([]);
  });

  it('allows motion sections with reduced motion', () => {
    const source = `import Link from 'next/link';
import { MotionConfig, motion } from 'motion/react';

const STEPS = [
  { title: 'Create', body: 'Name, ticker, image.' },
  { title: 'Trade', body: 'Public bonding curve.' },
];

export function Steps() {
  return (
    <MotionConfig reducedMotion="user">
      <section className="launchpad-steps">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.title}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.4, delay: i * 0.08 }}
          >
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </motion.div>
        ))}
        <motion.div whileHover={{ scale: 1.03 }}>
          <Link href="/create-pool">Launch a coin</Link>
        </motion.div>
        <motion.svg viewBox="0 0 10 10" aria-hidden="true" animate={{ rotate: 360 }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}>
          <motion.circle cx="5" cy="5" r="4" fill="var(--color-primary)" />
        </motion.svg>
      </section>
    </MotionConfig>
  );
}
`;
    expect(scanComponent(source, undefined, 'src/components/home/Steps.tsx')).toEqual([]);
  });

  it('allows an embla carousel with buttons', () => {
    const source = `import { useCallback } from 'react';
import useEmblaCarousel from 'embla-carousel-react';

const CARDS = [{ title: 'Fair' }, { title: 'Fast' }, { title: 'Fun' }];

export function CardRow() {
  const [viewportRef, embla] = useEmblaCarousel({ loop: true, align: 'start' });
  const prev = useCallback(() => embla?.scrollPrev(), [embla]);
  const next = useCallback(() => embla?.scrollNext(), [embla]);
  return (
    <div className="launchpad-row">
      <div className="overflow-hidden" ref={viewportRef}>
        <ul className="flex">
          {CARDS.map((card) => (
            <li key={card.title} className="min-w-0 flex-[0_0_80%]">{card.title}</li>
          ))}
        </ul>
      </div>
      <button type="button" onClick={prev} aria-label="Previous">
        <span className="iconify lucide--chevron-left" aria-hidden="true" />
      </button>
      <button type="button" onClick={next} aria-label="Next">
        <span className="iconify tabler--chevron-right" aria-hidden="true" />
      </button>
    </div>
  );
}
`;
    expect(scanComponent(source, undefined, 'src/components/home/CardRow.tsx')).toEqual([]);
  });

  it('allows animated numbers and brand icons on social links', () => {
    const source = `import NumberFlow from '@number-flow/react';

export function Stats({ coins }: { coins: number }) {
  return (
    <div>
      <NumberFlow value={coins} />
      <a href="https://x.com/nekopad" aria-label="X" rel="noopener noreferrer" target="_blank">
        <span className="iconify simple-icons--x" aria-hidden="true" />
      </a>
      <a href="https://t.me/nekopad" aria-label="Telegram" rel="noopener noreferrer" target="_blank">
        <span className="iconify simple-icons--telegram" aria-hidden="true" />
      </a>
    </div>
  );
}
`;
    expect(scanComponent(source, undefined, 'src/components/home/Stats.tsx')).toEqual([]);
  });

  it('refuses a social link whose href comes from a mapped array (the prompt warns about it)', () => {
    const source = `const S = [{ label: 'X', href: 'https://x.com/nekopad' }];
export const C = () => <div>{S.map((s) => <a key={s.label} href={s.href}>{s.label}</a>)}</div>;
`;
    expect(scanComponent(source)).toContain('navigation-external');
    expect(builderSystemPrompt()).toContain('href={item.href}');
  });

  it('still blocks a CSS @import of a web font host', () => {
    const css = `@import url('https://fonts.googleapis.com/css2?family=Syne');\n`;
    expect(rulesOf(scan([added('src/theme/fonts.css', css)])).length).toBeGreaterThan(0);
  });

  it('lists in the builder prompt only packages the template installs', () => {
    const template = JSON.parse(
      readFileSync(new URL('../../../launchpad-template/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const fontsFile = readFileSync(
      new URL('../../../launchpad-template/src/theme/fonts.ts', import.meta.url),
      'utf8',
    );
    const prompt = builderSystemPrompt();
    const named = new Set<string>(['motion', 'embla-carousel-react', '@number-flow/react']);
    for (const pkg of named) expect(prompt, pkg).toContain(pkg);
    for (const text of [prompt, fontsFile]) {
      for (const m of text.matchAll(/@fontsource(?:-variable)?\/[a-z0-9-]+/g)) named.add(m[0]);
    }
    expect(named.size).toBe(17);
    for (const pkg of named) expect(template.dependencies[pkg], pkg).toMatch(/^\d+\.\d+\.\d+$/);
    for (const set of ['lucide', 'tabler', 'simple-icons'])
      expect(template.dependencies[`@iconify-json/${set}`], set).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
