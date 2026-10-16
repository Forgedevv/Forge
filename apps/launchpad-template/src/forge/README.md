# src/forge - LOCKED ZONE

Everything in this folder is owned by FORGE. The site builder must never create, edit, rename or
delete anything here. A blocking scan rejects any change under `src/forge/` before a push.

This zone contains all the logic that touches money, the network or the chain:

- `config.ts`: reads and validates `forge.config.json`.
- `security-headers.ts`: Content-Security-Policy allowlist, used by `next.config.ts`.
- `JupiterTrade.tsx`: Jupiter Plugin (loads the external plugin script). Only rendered by `TradePanel` once a coin graduated.
- `CoinTradePanel.tsx`: trade panel of a coin page; renders `TradePanel` for the mint (FORGE buy/sell with the 0.3% platform fee on the curve, Jupiter after graduation).
- `TradePanel.tsx` / `BuyButton.tsx`: take a mint, never a pool. The pool is derived from the mint and this launchpad's two configs (`trade/launchpad-pool.ts`: `launchpadConfig` for its users' coins, `launchpadCoinConfig` for its own coin), looked up on-chain, and handed to the form as a handle only `findLaunchpadPool` can issue. `trade/core-adapter.ts` checks the pool's config again on-chain (`allowedConfigs` of `@forge/core`) and is the only place reading the FORGE fee accounts (build-time `NEXT_PUBLIC_*`, no override; `setSwapCore` works under tests only).
- `CreateCoin.tsx`: coin creation: form, server preparation (`/api/upload`), full cost summary shown BEFORE signing, send through the RPC relay, confirmation by polling.
- `create/`: pure helpers of the creation flow (`validation`, `amounts`, `api`, `verify`, `chain`, `flow`).
- `create/` server side of `/api/upload` (server-only modules): `prepare-handler` (rate limit, wallet signature, single-use nonce, image checks, fail closed), `image` (PNG/JPEG/WebP/GIF by magic bytes, 2 MB), `upload-client` (FORGE presigned-upload endpoint, contract in the file header; no storage key in the site), `launch-builder` (pool transaction built by `@forge/core` `buildUserCoinLaunchTx` through the RPC relay; the first buy pays the 0.3% FORGE platform fee, `create/platform-fee.ts`), `server-guards`.
- `config.ts` freezes `forge.config.json`: nothing at runtime can change the configs the site trades or creates coins on.
- `ClaimCreatorFees.tsx` and `claims/`: creator fee claims for the connected wallet (adapter to `@forge/core` in `claims/core-adapter.ts`; the coins of a wallet come from `listCoinsOfCreator`, the one program scan the FORGE RPC relay accepts).
- `pages/CreatorFeesPage.tsx`: the creator fee claim page of every live site, served at `/creator-fees` by the locked route `src/pages/creator-fees.tsx` (a single re-export, refused by the builder scan like `_app`). Free-zone pages may link to `/creator-fees`; when the site is sleeping or disabled the mode gate renders the mode page instead.
- `ModeGate.tsx`: app-level mode gate rendered by `src/pages/_app.tsx`. Reads the mode from `config.ts` only; when the site is sleeping or disabled it renders a page from `modes/` and nothing else.
- `modes/`: sleeping and disabled pages (and their minimal theme style). They import nothing from the free zones. The sleeping page keeps only the creator fee claim (decision D29): `modes/SleepingClaim.tsx` (wallet provider + `ClaimCreatorFees`), loaded on demand when a creator opens it.
- `AppProviders.tsx`: providers of the live site (data, wallet, toasts), the wallet provider alone (`ForgeWalletProvider`, also used by the sleeping claim) and the colour mode provider.
- `ModeBanner.tsx`: banner shown instead of an action when the site is sleeping or disabled.
- `data/`: Jupiter data API client and websocket stream.
- `chart/`: TradingView chart (loads an external script and queries the data API).
- `token-icon/`: token images (dynamic image URLs).
- `CoinLink.tsx`: link to the launchpad coin on Jupiter (sleeping page).
- `mode-guard.ts`: what each mode allows (`capabilitiesFor`: a sleeping site allows the creator fee claim only); API routes answer 503 when the site is sleeping or disabled (the claim needs no API route: it goes from the browser to the FORGE RPC relay).

Rules for the free zones (`src/theme`, `src/content`, `src/components`, `src/pages`): no `fetch`, no
dynamic URL, no dynamic `img src`, no external script. Import a component from here instead.
