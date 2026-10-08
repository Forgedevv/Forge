# FORGE brand guide

Source of truth: the Figma file https://www.figma.com/design/6pJEbkDSI3PrurY4ReyxXG.
Production files live in `apps/web/public/brand`.

Tagline: **Ideas in. Worlds out.**

## Logo

The logo is the F-Spark symbol (a violet bar, a magenta F arm and a white spark) next to the outlined FORGE wordmark. The wordmark is drawn as paths: never retype it.

| File (`apps/web/public/brand`) | Use it for |
| --- | --- |
| `forge-logo-wordmark-light-text.svg` | Transparent lockup with a light wordmark. Default on dark backgrounds (app header, footer, home). |
| `forge-logo-wordmark-dark-text.svg` | Transparent lockup with a dark wordmark. Use on light backgrounds (light workspace theme, documents). |
| `forge-logo-dark.svg` | Lockup on its own dark card. Presentations, press kits, places with no controlled background. |
| `forge-logo-light.svg` | Lockup on its own light card. Same, for light contexts. |
| `forge-logo-on-violet.svg` | Lockup on a violet card. Banners and covers that are violet. |
| `forge-logo-mono-white.svg` | Single-color white lockup. Violet, photographic or busy backgrounds, and one-color print. |
| `forge-mascot.svg` | The pilot helmet mascot (see below). |
| `app/icon.svg` | The F-Spark symbol alone: favicon and small spaces. |
| `app/apple-icon.png` | 512 px app icon. |
| `app/opengraph-image.png`, `app/twitter-image.png` | 1200x630 social share image. |

Use the symbol alone only when the brand name is already visible nearby or the space is too small for the lockup (avatars, favicons, app icons).

### Clear space

Keep an empty margin around the logo equal to the height of the F's top bar on every side. Nothing (text, edges, other logos) enters that zone.

### Minimum sizes

- Symbol alone: 16 px high.
- Lockup: 96 px wide.

Below these sizes, switch to the symbol or enlarge the logo.

## Colors

| Name | Hex | Role |
| --- | --- | --- |
| Background | `#0B0A12` | Page background, logo card (dark) |
| Surface | `#161426` | Cards, panels |
| Raised | `#201C36` | Raised elements, inputs, hovered surfaces |
| Border | `#3A3360` | Lines and outlines on dark |
| Electric violet | `#9B5CFF` | Primary accent, buttons, focus ring |
| Magenta | `#FF4FD8` | Secondary accent, highlights, hovers. Use sparingly. |
| Violet text | `#B794FF` | Accent-colored text on dark (readable contrast) |
| Cool white | `#F2F0FF` | Main text and wordmark on dark |
| Pilot shell | `#E6E3F2` | Mascot helmet shell |

Light theme counterparts: background `#F4F2FB`, text `#1A1530`, accent text `#6A2FD6`.

## Typography

- **Unbounded Bold**: display type and the wordmark. Headings and big statements only.
- **Space Grotesk**: interface and body text (Regular, Medium, Bold).

Both are loaded with `next/font/google` in `apps/web/app/layout.tsx` and exposed as `--font-unbounded` and `--font-space-grotesk`. Do not use Unbounded for paragraphs or small labels.

## Mascot

The pilot helmet (`forge-mascot.svg`) is the friendly face of FORGE.

- Use it for empty states, onboarding, error pages, stickers and social content.
- Keep it clear of the logo: do not place it inside the lockup or replace the symbol with it.
- Keep its colors (shell `#E6E3F2`, violet and magenta details). Show it on dark or light surfaces with enough contrast against the shell.
- Give it the same clear space as the logo.

## Don't

- Don't stretch, squash or skew the logo. Scale it proportionally.
- Don't recolor it. Use only the supplied versions; for any other color, use the mono version.
- Don't rotate it.
- Don't add effects: no shadows, glows, outlines, gradients or blurs.
- Don't place the color logo on busy images, patterns or violet backgrounds. Use `forge-logo-mono-white.svg` there.
- Don't recreate the wordmark with another font, or retype it with Unbounded. Use the supplied paths.
- Don't crop the logo, or crowd it inside the clear space.
- Don't use a light wordmark on a light background or a dark wordmark on a dark one.
