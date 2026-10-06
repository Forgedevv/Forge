# FRONTEND — frontend agent brief (agent 6)

You are the FORGE frontend agent. You build **the entire interface**: the FORGE site (`apps/web`) and the base design of client sites (`apps/launchpad-template`). You do not touch money, APIs, or the database. This folder contains everything you need; you do not have to read the rest of the docs to get started.

## Reading order

1. This file (scope, rules, deliverables).
2. [`PROJECT.md`](./PROJECT.md): the project explained from the interface side, the user journeys, the numbers to display.
3. [`SCREENS.md`](./SCREENS.md): every screen, its states, its data, its actions.
4. [`CONTRACT.md`](./CONTRACT.md): the types and functions the backend provides to you, and how to mock them.
5. `PLANEXECUTE.md` at the root: the rules shared by all agents (they apply to you too).

## What you own

| Where | You own | You do not touch (other agent) |
|---|---|---|
| `apps/web` | `app/**` **except** `app/api/**`; `src/ui/**` (components, styles, mocks); `public/**`; Tailwind config and global styles | `app/api/**`, `src/server/**`, `src/client/**`, `middleware.ts`, `next.config.*`, `package.json` (agent 3) |
| `apps/launchpad-template` | `src/theme/**`, `src/content/**`, `src/components/**` (visual), the layout of `src/pages/**` | `src/forge/**` (locked zone, money), `src/pages/api/**`, `next.config.*`, `forge.config.json`, `package.json` (agent 2) |

If you need a new dependency (`package.json`), a new piece of data, or a new backend function: write it in `docs/CHANGE_REQUESTS.md` ("Agent 6 — Frontend") and keep going with a mock.

## Rules that apply to you directly

1. **No money logic in your code.** You never build, sign, or send a transaction yourself: you call the functions in `src/client/` (web) or place the components from `src/forge/` (template). No `@solana/web3.js` import to build a transaction, no `Keypair`.
2. **No hardcoded Solana address**, no external script (`<script src=…>`), no `fetch` to an unexpected domain, no `eval` / `dangerouslySetInnerHTML` with dynamic content. The client site is scanned before every deployment: these patterns block the deployment.
3. **Every amount comes from the backend.** You display, you do not compute (except formatting: SOL ↔ lamports, rounding, dollars).
4. **Template: the look goes through the theme's CSS variables.** The builder agent will then change the design for each client by touching only `src/theme`, `src/content` and the pages. Your base design must therefore be fully driven by `forge.config.json#theme` (colors, dark mode) and by CSS variables, with no hardcoded value in the components.
5. Devnet by default, no secrets in the code, nothing in the logs.

## Stack

- `apps/web`: Next.js **App Router**, strict TypeScript, Tailwind CSS. Components: shadcn/ui (Radix) recommended; any other heavy library must be requested.
- `apps/launchpad-template`: Next.js **Pages Router** (fork of the Meteora fun-launch scaffold), keep its existing styling stack and drive it with CSS variables.
- Wallet connection: Solana adapter (`@solana/wallet-adapter-react`), provided and configured by agent 3; you build the button and the modal.
- Realtime: Supabase Realtime, wrapped by agent 3 in hooks (`CONTRACT.md`).

## How to work

- Branch: `agent/frontend`. You commit on your branch; the lead session merges into `main`.
- Until agent 3's hooks exist: implement them as mocks in `apps/web/src/ui/mocks/` **with exactly the signatures from `CONTRACT.md`**, behind a `NEXT_PUBLIC_USE_MOCKS=1` variable. The day the real client exists, we change the import, not the screens.
- The mocks must let you go through **all** states of each screen (a job that advances on its own, expired payment, failure, refund, insufficient $FORGE balance…). Provide a `/dev/states` page (non-production only) that lists the screens in each state.
- Mobile first: everything must work at 375 px wide.
- Accessibility: AA contrast, visible focus, keyboard navigation, `aria-live` on the job progress feed.

## Deliverables

**`apps/web`**
- All the pages and states of `SCREENS.md`, part A.
- Component library in `src/ui/` (buttons, cards, status badges, countdown, step tracker, SOL/USD amount, shortened address with copy, toasts, empty states, errors, loading).
- Dark mode by default, light mode available.

**`apps/launchpad-template`**
- Base design of all the pages of `SCREENS.md`, part B, driven by the theme.
- The set of CSS variables documented in `src/theme/README.md` (list of variables, what they change): this is what the builder agent will read.

## Definition of done

- `pnpm typecheck`, `pnpm lint` and `pnpm build` pass for `apps/web` and `apps/launchpad-template`.
- Every screen of `SCREENS.md` exists in all its states, visible on `/dev/states` with the mocks.
- Component tests (vitest + Testing Library) for: the job step tracker, the quote countdown, the spec summary card, the fee claim button.
- No forbidden pattern (rule 2): run `grep` on your diff before committing.
- A short report at the end of `tasks/08-FRONTEND.md`: done / not done / uncertain / dependencies requested.

## Open questions (do not wait, make a cautious assumption)

- Final name and visual identity of FORGE (DECISIONS Q3): use "FORGE", a text logo and a provisional palette that is easy to change (variables).
- Client site domain: use `<slug>.forgepads.xyz` as an example.
