# src/forge - LOCKED ZONE

Everything in this folder is owned by FORGE. The site builder must never create, edit, rename or
delete anything here. A blocking scan rejects any change under `src/forge/` before a push.

This zone contains all the logic that touches money, the network or the chain:

- `config.ts`: reads and validates `forge.config.json`.
- `security-headers.ts`: Content-Security-Policy allowlist, used by `next.config.ts`.
- `JupiterTrade.tsx`: Jupiter Plugin (loads the external plugin script).
- `CreateCoin.tsx`: coin creation form (uses `/api/upload` and `/api/send-transaction`).
- `useSendTransaction.ts`: client-side transaction sending helper.
- `data/`: Jupiter data API client and websocket stream.
- `chart/`: TradingView chart (loads an external script and queries the data API).
- `token-icon/`: token images (dynamic image URLs).
- `CoinLink.tsx`: link to the launchpad coin on Jupiter (sleeping page).
- `mode-guard.ts`: API routes answer 503 when the site is sleeping or disabled.

Rules for the free zones (`src/theme`, `src/content`, `src/components`, `src/pages`): no `fetch`, no
dynamic URL, no dynamic `img src`, no external script. Import a component from here instead.
