import { useMemo } from 'react';
import { parseCssRgb, useThemeColors, type Rgb, type ThemeColors } from '../../shared';

/**
 * Optional colour overrides accepted by every effect. Each value is a CSS colour in `#rgb`,
 * `#rrggbb` or `rgb(...)` form; anything left out follows the site theme.
 */
export interface EffectColors {
  primary?: string;
  accent?: string;
  background?: string;
  text?: string;
}

/** Parses `#rgb`, `#rrggbb` or `rgb(...)` / `rgba(...)` into channels between 0 and 1. */
export function parseColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const text = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(text);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
    return [channel(0), channel(2), channel(4)];
  }
  return parseCssRgb(text);
}

/** The theme colours with the given overrides applied (invalid overrides are ignored). */
export function resolveColors(theme: ThemeColors, overrides?: EffectColors): ThemeColors {
  return {
    primary: parseColor(overrides?.primary) ?? theme.primary,
    accent: parseColor(overrides?.accent) ?? theme.accent,
    background: parseColor(overrides?.background) ?? theme.background,
    text: parseColor(overrides?.text) ?? theme.text,
  };
}

/** Relative luminance (WCAG) of an sRGB colour. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** True when the colour is a dark background (light text on it reads better). */
export function isDarkColor(rgb: Rgb): boolean {
  return luminance(rgb) < 0.2;
}

/** Linear blend of two colours. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** CSS `rgb()` string for canvas 2D drawing. */
export function rgbCss([r, g, b]: Rgb, alpha = 1): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const a = Math.min(1, Math.max(0, alpha));
  return a >= 1 ? `rgb(${c(r)} ${c(g)} ${c(b)})` : `rgb(${c(r)} ${c(g)} ${c(b)} / ${a.toFixed(3)})`;
}

/** Theme colours for a canvas effect, with the effect's `colors` overrides applied. */
export function useEffectColors(overrides?: EffectColors): ThemeColors {
  const theme = useThemeColors();
  const { primary, accent, background, text } = overrides ?? {};
  return useMemo(
    () => resolveColors(theme, { primary, accent, background, text }),
    [theme, primary, accent, background, text],
  );
}
