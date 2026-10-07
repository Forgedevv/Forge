# @forge/launchpad-template

The client launchpad site that FORGE generates for each customer. Next.js (Pages Router), wired to
Meteora's Dynamic Bonding Curve and Jupiter.

## Attribution

Forked from the `fun-launch` scaffold of [MeteoraAg/meteora-invent](https://github.com/MeteoraAg/meteora-invent)
(MIT License, Copyright (c) 2025 Meteora, see `LICENSE.md`).

- Upstream commit: `dd77ef3d5aede3f0ff21d566d052097200417f5e`
- Upstream path: `scaffolds/fun-launch`

## Structure

| Path | Zone | Content |
|---|---|---|
| `forge.config.json` | config | Site config (`docs/INTERFACES.md` section 3). The builder edits `theme` and `content` only. |
| `src/forge/` | LOCKED | Config loader, security headers, and everything that touches the network, the chain or money. See `src/forge/README.md`. |
| `src/theme/` | free | CSS variables driven by `forge.config.json#theme`. |
| `src/content/` | free | Texts driven by `forge.config.json#content`. |
| `src/components/`, `src/pages/` | free | UI. They import from `src/forge` for anything dynamic. |
| `src/pages/api/` | server | `upload` (R2 + pool transaction) and `send-transaction`, both answer 503 unless the site is `live`. |

## Modes

`forge.config.json#mode`: `live`, `sleeping` or `disabled`. In the last two modes `_app.tsx` renders a
static page only (no wallet provider, no data provider, no RPC, no Jupiter script) and the API
routes answer 503.

## Scripts

`pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## Environment

See `.env.example`. `R2_PUBLIC_URL` replaces the upstream hardcoded public bucket URL.

## Changes from upstream

- Workspace package, exact-pinned dependencies, strict TypeScript (only `noUncheckedIndexedAccess` relaxed).
- `@solana/wallet-adapter-wallets` replaced by the Phantom and Solflare adapters (the bundle breaks
  server-side rendering because of a Ledger ESM import).
- API routes read their environment lazily so `next build` works without secrets.
- Lint: root flat config with the upstream relaxed rules (`no-explicit-any`, `no-unused-vars`, ...).

## Wave status

Structure only. `TradePanel`, `BuyButton`, platform fee display, `ClaimCreatorFees` and the on-chain
data fallback come later.
