import { siteConfig } from '@/forge/config';

/**
 * Theme layer (FREE ZONE). Turns `forge.config.json#theme` into CSS variables.
 * Pure functions only: no network, no dynamic URL.
 */

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

const triplet = ([r, g, b]: Rgb) => `${r} ${g} ${b}`;

function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! * (1 - weight) + b[i]! * weight)) as Rgb;
}

/** Readable text colour (dark or white) for a given background. */
export function contrastRgb(rgb: Rgb): Rgb {
  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? [15, 23, 42] : [255, 255, 255];
}

/**
 * CSS overriding the primary/accent colours. The selector is `:root:root` so it wins over both the
 * light (`:root`) and dark (`.dark`) defaults, whatever the load order.
 */
export function buildThemeCss(theme: { primaryColor: string; accentColor: string }): string {
  const primary = hexToRgb(theme.primaryColor);
  const accent = hexToRgb(theme.accentColor);
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const lines = [
    `--color-primary: ${theme.primaryColor};`,
    `--color-accent: ${theme.accentColor};`,
    // RGB triplets consumed by the Tailwind `primary` scale.
    `--primary: ${triplet(primary)};`,
    `--primary-200: ${triplet(primary)};`,
    `--primary-300: ${triplet(mix(primary, black, 0.15))};`,
    `--primary-400: ${triplet(mix(primary, white, 0.1))};`,
    `--primary-500: ${triplet(primary)};`,
    `--primary-600: ${triplet(mix(primary, white, 0.2))};`,
    `--primary-700: ${triplet(mix(primary, white, 0.4))};`,
    `--primary-800: ${triplet(mix(primary, white, 0.85))};`,
    `--primary-900: ${triplet(mix(primary, white, 0.9))};`,
    `--primary-950: ${triplet(contrastRgb(primary))};`,
    `--accent: ${triplet(accent)};`,
    `--jupiter-plugin-primary: ${triplet(primary).replace(/ /g, ', ')};`,
  ];
  return `:root:root { ${lines.join(' ')} }`;
}

export const themeCss = buildThemeCss(siteConfig.theme);

/** Default colour mode, from `theme.darkMode`. */
export const defaultColorMode: 'dark' | 'light' = siteConfig.theme.darkMode ? 'dark' : 'light';
