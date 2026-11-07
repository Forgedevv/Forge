import Head from 'next/head';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { LIBRARY } from '@/components/library/registry';
import {
  FAMILY_LABELS,
  LIBRARY_FAMILIES,
  type LibraryFamily,
  type LibraryMood,
} from '@/components/library/types';

/**
 * Showcase of the visual library, for FORGE only: it never reaches the template repository
 * (excluded by scripts/prepare-template-repo.mjs), so client sites have no /library page.
 * The palette buttons override the theme variables the effects read, to check each effect with
 * several client colour schemes.
 */

const PALETTES = [
  { name: 'Violet / amber', primary: '124 92 250', accent: '251 191 92' },
  { name: 'Lime / sky', primary: '163 230 53', accent: '56 189 248' },
  { name: 'Rose / gold', primary: '244 63 94', accent: '250 204 21' },
  { name: 'Cyan / magenta', primary: '34 211 238', accent: '232 121 249' },
  { name: 'Orange / teal', primary: '249 115 22', accent: '45 212 191' },
] as const;

const WEIGHT_LABELS = { light: 'CSS / SVG', medium: 'JS', heavy: 'WebGL' } as const;

export default function LibraryShowcase() {
  const [family, setFamily] = useState<LibraryFamily | 'all'>('all');
  const [mood, setMood] = useState<LibraryMood | 'all'>('all');
  const [palette, setPalette] = useState(0);

  const moods = useMemo(
    () => [...new Set(LIBRARY.flatMap((entry) => entry.moods))].sort() as LibraryMood[],
    [],
  );
  const shown = LIBRARY.filter(
    (entry) =>
      (family === 'all' || entry.family === family) &&
      (mood === 'all' || entry.moods.includes(mood)),
  );
  const colors = PALETTES[palette] ?? PALETTES[0];
  // `--color-*` are resolved where they are declared (:root), so they are overridden here too.
  const themeStyle = {
    '--primary': colors.primary,
    '--accent': colors.accent,
    '--color-primary': `rgb(${colors.primary})`,
    '--color-accent': `rgb(${colors.accent})`,
  } as CSSProperties;

  // Canvas and WebGL effects read the colours on the document root (useThemeColors), not on this
  // wrapper: the palette is mirrored there too, and removed when the showcase unmounts.
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
        <title>FORGE visual library</title>
        <meta name="robots" content="noindex" />
      </Head>
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-3 px-6 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-2xl font-semibold">FORGE visual library</h1>
            <p className="text-sm text-[var(--color-text-muted)]">
              {shown.length} / {LIBRARY.length} effects
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {(['all', ...LIBRARY_FAMILIES] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={family === f}
                onClick={() => setFamily(f)}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 aria-pressed:border-[var(--color-primary)] aria-pressed:text-[var(--color-primary)]"
              >
                {f === 'all' ? 'All' : FAMILY_LABELS[f]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--color-text-muted)]">Mood</span>
            {(['all', ...moods] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mood === m}
                onClick={() => setMood(m)}
                className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 aria-pressed:bg-[var(--color-accent)] aria-pressed:text-black"
              >
                {m}
              </button>
            ))}
            <span className="ml-4 text-[var(--color-text-muted)]">Client colours</span>
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

      <main className="mx-auto grid max-w-[90rem] gap-6 px-6 py-8 md:grid-cols-2">
        {shown.map((entry) => (
          <section
            key={entry.id}
            className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <div className="relative" style={{ height: entry.demoHeight ?? 320 }}>
              <entry.Demo />
            </div>
            <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{entry.name}</h2>
                <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-xs">
                  {FAMILY_LABELS[entry.family]} · {WEIGHT_LABELS[entry.weight]}
                </span>
              </div>
              <p className="text-sm text-[var(--color-text-muted)]">{entry.description}</p>
              <p className="flex flex-wrap gap-1 text-xs">
                {entry.moods.map((m) => (
                  <span key={m} className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5">
                    {m}
                  </span>
                ))}
              </p>
              <code className="text-xs text-[var(--color-text-muted)]">
                {`import { ${entry.exportName} } from '${entry.importPath}';`}
              </code>
            </div>
          </section>
        ))}
        {shown.length === 0 && (
          <p className="text-[var(--color-text-muted)]">No effect matches these filters yet.</p>
        )}
      </main>
    </div>
  );
}
