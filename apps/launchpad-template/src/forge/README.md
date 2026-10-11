# src/forge - LOCKED ZONE

Everything in this folder is owned by FORGE. The site builder must never create, edit, rename or
delete anything here. A blocking scan rejects any change under `src/forge/` before a push.

This zone contains all the logic that touches money, the network or the chain:

- `config.ts`: reads and validates `forge.config.json`.
- `security-headers.ts`: Content-Security-Policy allowlist, used by `next.config.ts`.
- `JupiterTrade.tsx`: Jupiter Plugin (loads the external plugin script). Only rendered by `TradePanel` once a coin graduated.
- `CoinTradePanel.tsx`: trade panel of a coin page. Derives the pool from this launchpad's config and the mint, then renders `TradePanel` (FORGE buy/sell with the 0.3% platform fee on the curve, Jupiter after graduation).
- `CreateCoin.tsx`: coin creation: form, server preparation (`/api/upload`), full cost summary shown BEFORE signing, send through the RPC relay, confirmation by polling.
- `create/`: pure helpers of the creation flow (`validation`, `amounts`, `api`, `verify`, `chain`, `flow`).
- `ClaimCreatorFees.tsx` and `claims/`: creator fee claims for the connected wallet (adapter to `@forge/core` in `claims/core-adapter.ts`).
- `ModeBanner.tsx`: banner shown instead of an action when the site is sleeping or disabled.
- `useSendTransaction.ts`: client-side transaction sending helper. Sends only through the FORGE RPC relay (there is no server-side send route and no RPC provider key in the site).
- `data/`: Jupiter data API client and websocket stream.
- `chart/`: TradingView chart (loads an external script and queries the data API).
- `token-icon/`: token images (dynamic image URLs).
- `CoinLink.tsx`: link to the launchpad coin on Jupiter (sleeping page).
- `mode-guard.ts`: what each mode allows (`capabilitiesFor`); API routes answer 503 when the site is sleeping or disabled.

Rules for the free zones (`src/theme`, `src/content`, `src/components`, `src/pages`): no `fetch`, no
dynamic URL, no dynamic `img src`, no external script. Import a component from here instead.
