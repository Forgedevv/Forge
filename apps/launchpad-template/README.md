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
| `src/pages/api/` | server | `upload` only (coin preparation). It answers 503 unless the site is `live`. |
| `scripts/` | monorepo only | `prepare-template-repo.mjs` (not part of the template repository). |

## Modes

`forge.config.json#mode`: `live`, `sleeping` or `disabled`. In the last two modes `_app.tsx` renders a
static page only (no wallet provider, no data provider, no RPC, no Jupiter script) and the API
route answers 503.

## Scripts

`pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## Money logic

Swaps, fee claims and pool reads come from `@forge/core` (`workspace:*` in the monorepo, an exact
version in the template repository):

- `src/forge/trade/core-adapter.ts`: wrappers over `quoteSwap` / `buildBuyTx` / `buildSellTx` and
  the graduation read. The Meteora referral and the 0.3% platform fee are added by the core.
- `src/forge/claims/core-adapter.ts`: wrappers over `listCoinsOfConfig` and `buildCreatorClaimTx`
  (the receiver is the connected wallet).
- `src/forge/create/launch-builder.ts`: coin launch on the launchpad config (creator = payer =
  buyer). It reuses the core constants and quote inputs but keeps its own SDK call, because the core
  has no builder for this case yet.

Every transaction is verified again in the browser (`src/forge/*/verify.ts`) before the wallet is
asked to sign. The browser has no `process.env`, so the FORGE fee accounts are handed to the core
explicitly, from the public `NEXT_PUBLIC_*` variables below.

## Environment

See `.env.example`. The site holds no secret: every variable is public and injected by FORGE.
`NEXT_PUBLIC_*` values are inlined in the browser bundle at build time.

| Variable | Use |
|---|---|
| `SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` or `mainnet-beta` |
| `NEXT_PUBLIC_FORGE_RPC_RELAY_URL` | FORGE RPC relay, the only RPC endpoint (browser and server) |
| `NEXT_PUBLIC_FORGE_API_URL` | FORGE API base URL for coin uploads (defaults to the relay origin) |
| `NEXT_PUBLIC_POOL_CONFIG_KEY` | launchpad pool config(s), filters the coin lists |
| `R2_PUBLIC_URL`, `NEXT_PUBLIC_R2_PUBLIC_URL` | public base URL of coin images and metadata (read only) |
| `NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT` | Jupiter integrator fee account (30 bps after graduation) |
| `NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET` | recipient of the 0.3% platform fee on curve swaps |
| `NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT` | Meteora referral token account used by curve swaps |

`FORGE_JUPITER_REFERRAL_ACCOUNT`, `FORGE_PLATFORM_FEE_WALLET` and `FORGE_METEORA_REFERRAL_ACCOUNT`
are the server-side names of the same addresses.

## API

A single server route, `POST /api/upload` (coin preparation). It holds no storage key and sends
nothing to the chain:

1. the browser sends the image, the metadata and a signed wallet proof;
2. the route validates them, uploads the files through the FORGE upload endpoint
   (`POST <FORGE API>/api/launchpads/<slug>/uploads`, presigned URLs), and builds the pool
   transaction, reading the chain through the FORGE RPC relay;
3. the browser verifies the transaction, the wallet signs it, and the browser sends it through the
   RPC relay and confirms it by polling `getSignatureStatuses`.

There is no send-transaction route.

## Publishing the template

The template is published as a standalone repository, built from this folder by
`scripts/prepare-template-repo.mjs`. The script only writes files into an output folder: it never
runs git, never pushes, never tags and never publishes. Pushing the output is a manual step.

```
node scripts/prepare-template-repo.mjs --out ../template-out \
  --pin @forge/core=0.1.0 --pin @forge/shared=0.1.0

# only if @forge/core is served by a private registry:
#   --registry https://npm.pkg.github.com --scope @forgedevv
# preview without writing anything:
#   --dry-run
```

The output differs from this folder as follows:

- every `workspace:*` dependency is replaced by the exact version given with `--pin` (the script
  fails if one is missing or not an exact `x.y.z`);
- `.npmrc` exists only when `--registry` and `--scope` are given, with the scope line alone (never
  a token);
- `vercel.json` contains `{ "git": { "deploymentEnabled": false } }`, so a push to the template
  repository never deploys it;
- `tsconfig.json` no longer extends the monorepo base, and `typescript` is added to the dev
  dependencies;
- tests, test tooling (`vitest`, Testing Library, `jsdom`), the monorepo lint config, test mocks and
  fixtures, caches and local env files are left out, together with the `test` and `lint` scripts.

## Changes from upstream

- Workspace package, exact-pinned dependencies, strict TypeScript (only `noUncheckedIndexedAccess` relaxed).
- `@solana/wallet-adapter-wallets` replaced by the Phantom and Solflare adapters (the bundle breaks
  server-side rendering because of a Ledger ESM import).
- The S3 client is removed: uploads go through the FORGE upload endpoint, the site holds no storage key.
- API routes read their environment lazily so `next build` works without secrets.
- Lint: root flat config with the upstream relaxed rules (`no-explicit-any`, `no-unused-vars`, ...).
