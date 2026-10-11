# src/theme - FREE ZONE

Colours, fonts and radius of the site. `forge.config.json#theme` drives the primary/accent colours and
the default light/dark mode; everything else is plain CSS in `theme.css`.

## CSS variables

| Variable | Source |
|---|---|
| `--color-primary` | `theme.primaryColor` |
| `--color-accent` | `theme.accentColor` |
| `--color-bg` | base token, follows light/dark |
| `--color-surface` | base token, follows light/dark |
| `--color-surface-raised` | raised neutral surface token |
| `--color-text` | base token, follows light/dark |
| `--color-text-muted` | base token, follows light/dark |
| `--color-border` | base token, follows light/dark |
| `--color-success` | base token |
| `--color-danger` | base token |
| `--radius` | `theme.css` |
| `--radius-card` | derived from `--radius` |
| `--content-width` | `theme.css` |
| `--page-gutter` | responsive `theme.css` value |
| `--section-space` | responsive `theme.css` value |
| `--font-heading` | `theme.css` |
| `--font-body` | `theme.css` |
| `--mint-metal` | primary mixed into the muted neutral, for the medallion illustration |
| `--mint-highlight` | accent mixed into the foreground, for engraved edges |
| `--mint-shadow` | primary mixed into the background, for the medallion depth |
| `--mint-width` | responsive illustration width |
| `--market-height` | desktop market column height; mobile uses document flow |
| `--token-row-height` | minimum height of a token row |
| `--header-height` | shared header height and anchor/mobile-tab offset |
| `--token-rail-width` | desktop trade/details column width |
| `--token-chart-height` | responsive chart panel height |
| `--token-table-height` | transaction/holder table height |

The Tailwind `primary` scale (`--primary`, `--primary-300`, ...) is also derived from
`theme.primaryColor`, so existing classes such as `bg-primary` follow the theme.

The shared shell uses the theme variables for page background, text, borders, brand mark, focus
indicators, and navigation states. Reduced-motion preferences disable smooth scrolling and minimize
transitions.

Dark/light: `theme.darkMode` sets the default; visitors can still toggle it.

The homepage is an editorial identity banner above three market columns. `MintSculpture` is local
SVG artwork with two engraved medallions; its finish follows the variables above, and it holds a
static pose when reduced motion is requested. It uses no remote asset or animation service.
The token page keeps the existing chart and trading components intact; the theme controls its
chart/table frames and the trade rail. On mobile the trading panel comes between the chart and
the tables instead of being hidden below a full-screen transaction list.

Rules: no `fetch`, no dynamic URL, no external script or font URL assigned at runtime. Fonts must be
self-hosted (`@font-face` in `theme.css` with a local file).
