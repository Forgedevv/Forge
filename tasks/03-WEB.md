# 03 — WEB (agent 3)

**You own**: `apps/web` (`app/api/**`, `src/server/**`, `src/client/**`, `middleware.ts`, `next.config.*`, `package.json`), `supabase`. **The interface (pages, components, styles) belongs to agent 6** (frontend, see `docs/frontend/`): you build no screens.

Your deliverable on the interface side is **`src/client/`**: exactly the types, functions and hooks of `docs/frontend/CONTRACT.md` (wallet connection, streamed chat, quote and payment, real-time tracking, launch signing, dashboard, fee claiming). You also configure the wallet provider (`@solana/wallet-adapter-react`) and Supabase on the browser side. Start with this client, with its tests: agent 6 works on mocks that have the same signatures.
**You read**: `PLANEXECUTE.md`, `docs/INTERFACES.md` (all), `docs/PRODUCT.md`, `docs/SECURITY.md` (sections 9, 10, 11), `docs/OPERATIONS.md` (flags).

You build the FORGE site: where the client talks to the agent, pays, follows the build, approves the preview, signs their coin's launch and claims their fees. You hold **no** FORGE wallet **key**.

## Database

- [ ] `supabase/migrations/`: schema from `INTERFACES.md` §5, with Row Level Security (a client only reads their own rows), index on `jobs(status, created_at)`, `flags` table initialized.
- [ ] Realtime enabled on `jobs` and `job_events`.

## Site (Next.js App Router, Vercel)

- [ ] Wallet login (Solana adapter) + nonce signature → session (`/api/auth/*`).
- [ ] **Design chat** (`/api/chat`): Claude API (Sonnet model), system prompt that asks the necessary questions and produces a valid `LaunchpadSpec` (zod); stays within the `CLIENT_BOUNDS`; shows a clear summary before confirmation. Rate limit per wallet. Messages stored per conversation (`conversations`, `chat_messages`), the launchpad only existing at confirmation (`/api/spec/confirm`, which refuses if `spec.ownerWallet` ≠ the session's wallet).
- [ ] Token-gating (`/api/gating`) before opening the chat and before each change, via `getForgeBalance` from core. Disabled until `FORGE_MINT` is defined.
- [ ] Payment: `/api/payments/quote` (price in dollars → lamports at the current rate, via Jupiter's price API, 120 s quote) and `/api/payments/confirm` (full on-chain verification, see SECURITY.md §10). Moves the job to `paid`.
- [ ] Real-time tracking: job page subscribed to `jobs` and `job_events` (Supabase Realtime), showing the steps and the preview URL.
- [ ] Preview approval (`/api/jobs/:id/approve`).
- [ ] Coin launch signing: fetch the partially signed transaction (`owner-transaction`), have it signed by the client's wallet, send it, follow the confirmation, then move the job to `owner_signed`.
- [ ] Client dashboard: their launchpads, status, versions, remaining modifications, "claim my fees" button (`buildPartnerClaimTx` from core), "request a modification" button.
- [ ] Quotas: `included_modifications_left` decremented; beyond that, a $5.50 quote.
- [ ] RPC relay `/api/rpc`: method allowlist, rate limit per IP, max size.
- [ ] `signups_paused` flag respected.
- [ ] The pages (home, chat, payment, tracking, dashboard, FAQ, terms) are built by agent 6: only check that each screen of `docs/frontend/SCREENS.md` part A has its data in `src/client/`.

## Tests

- [ ] Unit tests: spec validation, quote calculation, payment verification (with real devnet transactions as fixtures).
- [ ] RLS test: a wallet does not see another wallet's launchpads.
- [ ] Full local flow against devnet with the fake $FORGE and simulated jobs (the builder can be mocked).

## Dependencies

`@forge/core` (agent 1) for gating, payments, claims. `packages/shared` for the types. The builder and the signer communicate with you only through Supabase.

## Report

_To be filled in at the end of the task._
