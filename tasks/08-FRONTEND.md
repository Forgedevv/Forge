# 08 — FRONTEND (agent 6)

**You own**: in `apps/web`: `app/**` except `app/api/**`, `src/ui/**`, `public/**`, global styles and Tailwind config. In `apps/launchpad-template`: `src/theme/**`, `src/content/**`, `src/components/**`, layout of `src/pages/**`.
**You read**: the whole `docs/frontend/` folder (it is self-sufficient), then `PLANEXECUTE.md`.

You build the entire FORGE site interface and the base design of the client sites, with no money logic whatsoever. The details (scope, screens, contract with the backend, mocks, definition of done) are in `docs/frontend/README.md`.

## Steps

- [ ] Design system `apps/web/src/ui/` (tokens as CSS variables, base components, dark/light mode).
- [ ] Mocks of `docs/frontend/CONTRACT.md` in `src/ui/mocks/` + `/dev/states` page.
- [ ] Screens A1 to A11 of `docs/frontend/SCREENS.md`, in all their states.
- [ ] Base template design (B1 to B7), entirely driven by the theme variables; `src/theme/README.md`.
- [ ] Switch from the mocks to the real `src/client/` once agent 3 has delivered it (import change only).
- [ ] Component tests listed in `docs/frontend/README.md`.

## Dependencies

Agent 3 (`src/client/`), agent 2 (`src/forge/` components and `SiteConfig`). Meanwhile: mocks with the same signatures.

## Report

_To be filled in at the end of the task._
