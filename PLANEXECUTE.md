# PLANEXECUTE.md — rules for all agents

You are working on **FORGE**, a service where an AI agent builds Meteora launchpads for clients. Several Claude Code agents work in parallel on this repo, each in its own folder. Read this file in full, then your task sheet in `tasks/`, then the docs it cites.

If an instruction here contradicts another document, this file wins.

## Absolute rules

These rules are non-negotiable. If a task seems to require breaking one, stop and flag it.

1. **Only modify your own folder.** Each agent owns a folder (see the table below). You can read the whole repo, but you only write in your own. If you need a change elsewhere, write it in `docs/CHANGE_REQUESTS.md` with your agent name, and continue with a mock.
2. **Never modify `packages/shared`** unless you are the lead session. It is the contract between all agents. A contract change goes through `docs/CHANGE_REQUESTS.md`.
3. **No private key in code, logs, tests or git.** Secrets come only from environment variables. `.env*` is in `.gitignore`. Never log a variable whose name contains `KEY`, `SECRET`, `TOKEN` or `PRIVATE`.
4. **Devnet by default.** Every config points to devnet unless `SOLANA_CLUSTER=mainnet-beta` is explicitly set. Test scripts refuse to run if the RPC URL does not contain `devnet`.
5. **Only one place signs transactions with FORGE's keys: `apps/signer`** (creator wallets, claims, buyback). The only exception: `scripts/devnet-tests`, with throwaway wallets generated on devnet. No other folder imports a `Keypair` derived from a private key. The others build transactions that the user signs in their wallet.
6. **The transaction core (`packages/core`) is the single source of truth** for building a swap, a config or a pool. Nobody reimplements these transactions elsewhere.
7. **FORGE's addresses (multisig, Meteora and Jupiter referral accounts, platform fee wallet, cashbox, $FORGE mint) are never hardcoded outside `packages/core/src/addresses.ts`**, and that file reads them from the environment.
8. **Every on-chain value goes through `packages/core` validation** before being sent: fee bounds, migration threshold, locked liquidity (see `docs/METEORA.md`).
9. **Never mark a task done without a test.** See "Definition of done".

## Who owns what

| Agent | Owned folder | Task sheet |
|---|---|---|
| Lead session | `packages/shared`, root files, `docs/` | `tasks/06-INTEGRATION.md` |
| Agent 1 — On-chain | `packages/core`, `scripts/devnet-tests` | `tasks/01-ONCHAIN.md` |
| Agent 2 — Template | `apps/launchpad-template` **except** agent 6's visual zone | `tasks/02-TEMPLATE.md` |
| Agent 3 — Web | `apps/web` (`app/api`, `src/server`, `src/client`, config) **except** agent 6's visual zone, `supabase` | `tasks/03-WEB.md` |
| Agent 4 — Builder | `apps/builder` | `tasks/04-BUILDER.md` |
| Agent 5 — Signer | `apps/signer` | `tasks/05-SIGNER.md` |
| Agent 6 — Frontend | `apps/web`: `app/**` except `app/api`, `src/ui`, `public`; template: `src/theme`, `src/content`, `src/components`, layout of `src/pages` | `tasks/08-FRONTEND.md` + `docs/frontend/` |

## Stack

- Strict TypeScript, ESM, Node 20+.
- pnpm workspaces + Turborepo monorepo.
- Solana: `@solana/web3.js` v1, `@solana/spl-token`, `@meteora-ag/dynamic-bonding-curve-sdk` (pinned version, see `docs/METEORA.md`).
- Validation: `zod`. Logs: `pino`. Tests: `vitest`.
- Web: Next.js (App Router for `apps/web`; the template keeps fun-launch's Pages Router).
- Database: Supabase (Postgres + Realtime), `@supabase/supabase-js` client.

Do not add a heavy dependency without noting it in your end-of-task report.

## Conventions

- Language: everything in the repo is in English — code, comments, docs, commit messages, branch names and UI copy (UI copy is centralized so other languages can be added later).
- On-chain amounts in `bigint` or `BN` (lamports, raw units). Conversion to SOL or dollars only at display time.
- Percentages in **basis points** (`bps`) in code: 0.3% = 30 bps.
- Pure functions whenever possible, testable without network.
- Every function that builds a transaction returns the **unsigned** transaction (or partially signed on the signer side), never sent directly, except in `apps/signer`.
- Network errors: retry with backoff, then a clear error. Never silently swallow an on-chain error.
- Idempotency: a job, payment or signature that has already been processed is never processed again.

## Environments

| Variable | Values |
|---|---|
| `SOLANA_CLUSTER` | `devnet` (default) or `mainnet-beta` |
| `RPC_URL` | Helius, devnet or mainnet depending on the cluster |

The template's trading and coin lists go through Jupiter, which **does not index devnet**. The template's interface is therefore tested on mainnet with very small amounts; the on-chain logic is tested on devnet through scripts. See `docs/METEORA.md`.

## Definition of done

A task is done when:
- `pnpm typecheck` and `pnpm test` pass for your folder;
- the on-chain logic is tested on devnet (script or integration test) where applicable;
- no absolute rule is broken;
- you have written a short report at the bottom of your `tasks/0X-*.md` sheet, "Report" section: what is done, what is not, what remains uncertain, the dependencies added.

## When you are blocked

- Information is missing from the docs: make the most cautious assumption, note it in your report, continue.
- You need a component from another agent that doesn't exist yet: use a mock that respects `packages/shared`, note it.
- A devnet test fails for an unexplained reason: note the transaction signature and the exact error in your report, and do not work around it by changing the security rules.
