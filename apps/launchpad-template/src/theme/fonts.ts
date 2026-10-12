/**
 * Web fonts of the site (FREE ZONE). Imported once by `src/components/AppShell.tsx`.
 *
 * The font files ship with the site (self-hosted from the packages below, no font CDN), so the
 * build stays offline and the CSP stays `font-src 'self'`. Import at most two families: one
 * line per family, then name it in `--font-heading` / `--font-body` (`src/theme/theme.css`)
 * with a system fallback, for example `'Syne Variable', 'Avenir Next', system-ui, sans-serif`.
 *
 * Installed families (import path -> CSS family name):
 * - `@fontsource-variable/inter` -> 'Inter Variable' (neutral grotesk)
 * - `@fontsource-variable/manrope` -> 'Manrope Variable' (soft geometric)
 * - `@fontsource-variable/space-grotesk` -> 'Space Grotesk Variable' (techy grotesk)
 * - `@fontsource-variable/sora` -> 'Sora Variable' (wide geometric)
 * - `@fontsource-variable/outfit` -> 'Outfit Variable' (round geometric)
 * - `@fontsource-variable/syne` -> 'Syne Variable' (expressive display)
 * - `@fontsource-variable/unbounded` -> 'Unbounded Variable' (wide, bold display)
 * - `@fontsource-variable/bricolage-grotesque` -> 'Bricolage Grotesque Variable' (quirky grotesk)
 * - `@fontsource-variable/fraunces` -> 'Fraunces Variable' (soft serif; italic: `/wght-italic.css`)
 * - `@fontsource-variable/playfair-display` -> 'Playfair Display Variable' (high-contrast serif;
 *   italic: `/wght-italic.css`)
 * - `@fontsource-variable/jetbrains-mono` -> 'JetBrains Mono Variable' (monospace)
 * - `@fontsource/press-start-2p` -> 'Press Start 2P' (pixel, display only)
 * - `@fontsource/bebas-neue` -> 'Bebas Neue' (condensed capitals, display only)
 * - `@fontsource/instrument-serif` -> 'Instrument Serif' (editorial serif; italic:
 *   `/400-italic.css`)
 *
 * Example:
 *   import '@fontsource-variable/syne/index.css';
 *   import '@fontsource-variable/inter/index.css';
 *
 * The default template uses system font stacks only, so nothing is imported here.
 */
export {};
