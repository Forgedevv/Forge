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
| `--color-text` | base token, follows light/dark |
| `--color-text-muted` | base token, follows light/dark |
| `--color-border` | base token, follows light/dark |
| `--color-success` | base token |
| `--color-danger` | base token |
| `--radius` | `theme.css` |
| `--font-heading` | `theme.css` |
| `--font-body` | `theme.css` |

The Tailwind `primary` scale (`--primary`, `--primary-300`, ...) is also derived from
`theme.primaryColor`, so existing classes such as `bg-primary` follow the theme.

Dark/light: `theme.darkMode` sets the default; visitors can still toggle it.

Rules: no `fetch`, no dynamic URL, no external script or font URL assigned at runtime. Fonts must be
self-hosted (`@font-face` in `theme.css` with a local file).
