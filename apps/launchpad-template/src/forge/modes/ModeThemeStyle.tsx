import Head from 'next/head';
import { siteConfig } from '../config';

/**
 * LOCKED ZONE. Minimal theme variables for the sleeping and disabled pages: the primary colour and
 * its readable text colour. It replaces the free-zone `ThemeStyle`, which the mode pages never
 * render. Colours come from forge.config.json (validated hex strings) and are checked again here.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function readable([r, g, b]: Rgb): Rgb {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? [15, 23, 42] : [255, 255, 255];
}

const triplet = (value: Rgb) => value.join(' ');

/** CSS of the mode pages; empty when a colour is not a 6-digit hex string. */
export function modeThemeCss(theme: { primaryColor: string; accentColor: string }): string {
  if (!HEX.test(theme.primaryColor) || !HEX.test(theme.accentColor)) return '';
  const primary = rgb(theme.primaryColor);
  return `:root:root { --color-primary: ${theme.primaryColor}; --primary: ${triplet(primary)}; --primary-950: ${triplet(readable(primary))}; --accent: ${triplet(rgb(theme.accentColor))}; }`;
}

export function ModeThemeStyle() {
  const css = modeThemeCss(siteConfig.theme);
  if (!css) return null;
  return (
    <Head>
      <style id="forge-mode-theme">{css}</style>
    </Head>
  );
}
