import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { LIBRARY } from '@/components/library/registry';
import {
  SECTIONS,
  SECTION_SLOTS,
  SLOT_LABELS,
  type SectionSlot,
} from '@/components/sections/registry';

/**
 * Showcase of the section variants, for FORGE only: it never reaches the template repository
 * (excluded by scripts/prepare-template-repo.mjs). Each variant is rendered at full width with the
 * template's default copy; the palette buttons try it with several client colour schemes.
 */

const PALETTES = [
  { name: 'Violet / amber', primary: '124 92 250', accent: '251 191 92' },
  { name: 'Lime / sky', primary: '163 230 53', accent: '56 189 248' },
  { name: 'Rose / gold', primary: '244 63 94', accent: '250 204 21' },
  { name: 'Cyan / magenta', primary: '34 211 238', accent: '232 121 249' },
  { name: 'Orange / teal', primary: '249 115 22', accent: '45 212 191' },
] as const;

const EFFECT_NAMES = new Map(LIBRARY.map((entry) => [entry.id, entry.name]));

export default function SectionsShowcase() {
  const [slot, setSlot] = useState<SectionSlot>('hero');
  const [palette, setPalette] = useState(0);
  const shown = SECTIONS.filter((entry) => entry.slot === slot);
  const colors = PALETTES[palette] ?? PALETTES[0];
  const themeStyle = {
    '--primary': colors.primary,
    '--accent': colors.accent,
    '--color-primary': `rgb(${colors.primary})`,
    '--color-accent': `rgb(${colors.accent})`,
  } as CSSProperties;

  // Canvas and 3D effects read the colours on the document root: mirror the palette there.
  useEffect(() => {
    const root = document.documentElement.style;
    const chosen = PALETTES[palette] ?? PALETTES[0];
    const entries: [string, string][] = [
      ['--primary', chosen.primary],
      ['--accent', chosen.accent],
      ['--color-primary', `rgb(${chosen.primary})`],
      ['--color-accent', `rgb(${chosen.accent})`],
    ];
    for (const [name, value] of entries) root.setProperty(name, value);
    return () => {
      for (const [name] of entries) root.removeProperty(name);
    };
  }, [palette]);

  return (
    <div className="dark min-h-screen bg-background text-foreground" style={themeStyle}>
      <Head>
        <title>FORGE sections</title>
        <meta name="robots" content="noindex" />
      </Head>
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-3 px-6 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-2xl font-semibold">FORGE sections</h1>
            <p className="text-sm text-[var(--color-text-muted)]">
              {SECTIONS.length} variants · {SECTION_SLOTS.length} slots ·{' '}
              <Link href="/examples" className="underline underline-offset-4">
                example sites
              </Link>{' '}
              ·{' '}
              <Link href="/library" className="underline underline-offset-4">
                effects
              </Link>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {SECTION_SLOTS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={slot === s}
                onClick={() => setSlot(s)}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 aria-pressed:border-[var(--color-primary)] aria-pressed:text-[var(--color-primary)]"
              >
                {SLOT_LABELS[s]} ({SECTIONS.filter((entry) => entry.slot === s).length})
              </button>
            ))}
            <span className="ml-4 text-xs text-[var(--color-text-muted)]">Client colours</span>
            {PALETTES.map((p, i) => (
              <button
                key={p.name}
                type="button"
                aria-pressed={palette === i}
                aria-label={p.name}
                title={p.name}
                onClick={() => setPalette(i)}
                className="h-6 w-10 rounded-full border-2 border-transparent aria-pressed:border-[var(--color-text)]"
                style={{
                  background: `linear-gradient(90deg, rgb(${p.primary}) 50%, rgb(${p.accent}) 50%)`,
                }}
              />
            ))}
          </div>
        </div>
      </header>

      <main className="flex flex-col gap-10 py-8">
        {shown.map((entry) => (
          <article key={entry.id} className="border-y border-[var(--color-border)]">
            <div className="mx-auto flex max-w-[90rem] flex-wrap items-baseline justify-between gap-2 px-6 py-3 text-sm">
              <h2 className="font-semibold">
                {entry.name} <span className="font-mono text-xs opacity-60">{entry.id}</span>
              </h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {entry.moods.join(' · ')} · {entry.weight} ·{' '}
                {entry.effects.map((id) => EFFECT_NAMES.get(id) ?? id).join(', ') || 'no effect'}
              </p>
            </div>
            <div className="mx-auto max-w-[var(--content-width)]">
              <entry.Component />
            </div>
          </article>
        ))}
      </main>
    </div>
  );
}
