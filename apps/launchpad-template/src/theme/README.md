# src/theme - FREE ZONE

Colours, fonts and radius of the site. `forge.config.json#theme` drives the primary/accent colours and
the default light/dark mode; everything else is plain CSS in `theme.css`.

Web fonts: `fonts.ts` (imported by `src/components/AppShell.tsx`) lists the self-hosted font packages that
are installed; import at most two there and name them in `--font-heading` / `--font-body`. The
default template imports none and uses system font stacks.

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

The homepage is composed of optional sections (`src/components/home/`): the identity banner, a
value strip, the market, how it works, the launchpad coin, questions and a closing call to action.
While no coin exists, the market shows one compact panel (`Explore/MarketEmpty`) instead of three
empty columns. On mobile the market tabs stay in the card flow (not sticky). Shared buttons use
`launchpad-button`, `launchpad-button-primary` and `launchpad-button-ghost`. The header and footer
draw the mark of `src/components/Logo.tsx`; the app shell frames the locked creator fee page
(`[data-forge-page="creator-fees"]`) with the same header and footer. `MintSculpture` is local
SVG artwork with two engraved medallions; its finish follows the variables above, and it holds a
static pose when reduced motion is requested. It uses no remote asset or animation service.
The create page (`src/pages/create-pool.tsx`) uses the normal page frame (header and footer). Its
notes come first in the page: phones show them, compact, above the form; wide screens put them in a
side column. The form panel (`launchpad-create-panel`) is framed on wide screens and frameless on
phones, so the form keeps the full width. The FORGE form inside it takes its colours from the
Tailwind theme scales and its corners from `--radius` (controls) and `--radius-card` (framed
blocks); restyle it further from CSS through its `[data-forge="create-coin-form"]`,
`create-coin-preview`, `create-coin-review`, `create-coin-steps`, `create-coin-status` and
`create-coin-success` attributes. Its coin preview reuses the market row class
(`launchpad-token-row`), so restyling the market restyles the preview too.
The token page keeps the existing chart and trading components intact; the theme controls its
chart/table frames and the trade rail. On mobile the trading panel comes between the chart and
the tables instead of being hidden below a full-screen transaction list.

Rules: no `fetch`, no dynamic URL, no external script or font URL assigned at runtime. Fonts must be
self-hosted (`@font-face` in `theme.css` with a local file).
