import { useEffect, useState } from 'react';

/** An sRGB colour with channels between 0 and 1, the form WebGL shaders expect. */
export type Rgb = readonly [number, number, number];

export interface ThemeColors {
  primary: Rgb;
  accent: Rgb;
  background: Rgb;
  text: Rgb;
}

/** Used on the server and before the first read: a neutral dark palette. */
export const FALLBACK_THEME_COLORS: ThemeColors = {
  primary: [0.49, 0.36, 0.98],
  accent: [0.98, 0.75, 0.36],
  background: [0.05, 0.05, 0.08],
  text: [0.95, 0.95, 0.97],
};

const VARIABLES: Record<keyof ThemeColors, string> = {
  primary: '--color-primary',
  accent: '--color-accent',
  background: '--color-bg',
  text: '--color-text',
};

/** Parses the `rgb(...)` / `rgba(...)` string a browser returns for a computed colour. */
export function parseCssRgb(value: string): Rgb | null {
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (!match) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map((n) => Math.min(255, Number(n)) / 255);
  return [r ?? 0, g ?? 0, b ?? 0];
}

function readColors(): ThemeColors {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    const out = { ...FALLBACK_THEME_COLORS };
    for (const key of Object.keys(VARIABLES) as (keyof ThemeColors)[]) {
      probe.style.color = `var(${VARIABLES[key]})`;
      out[key] = parseCssRgb(getComputedStyle(probe).color) ?? FALLBACK_THEME_COLORS[key];
    }
    return out;
  } finally {
    probe.remove();
  }
}

/**
 * The site's theme colours (from `forge.config.json#theme` and the light/dark mode), for effects that
 * draw on a canvas and cannot use CSS variables directly. Re-read when the mode changes.
 */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(FALLBACK_THEME_COLORS);
  useEffect(() => {
    setColors(readColors());
    const observer = new MutationObserver(() => setColors(readColors()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}
