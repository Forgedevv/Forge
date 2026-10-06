# FORGE

An AI agent that builds a complete Meteora launchpad from a conversation.

The client (example: Hugo) describes their launchpad and pays ~$33 in SOL; the agent codes their site, FORGE creates their Meteora config and launches their launchpad's coin. After that, a share of the trading fees goes back to FORGE and is used to buy back $FORGE.

## Where to start

1. **[KICKOFF.md](./KICKOFF.md)**: the exact order to start development and the prompts to paste into each Claude Code agent.
2. **[PLANEXECUTE.md](./PLANEXECUTE.md)**: the rules every agent must follow. Each agent reads it first.
3. **[tasks/00-SETUP.md](./tasks/00-SETUP.md)**: what Ali does by hand before launching the agents (accounts, keys, wallets).

## Documentation

| File | Contents |
|---|---|
| [docs/PRODUCT.md](./docs/PRODUCT.md) | The product, the full flow (Hugo / MoonPad example), prices, who receives what |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Components, infrastructure, data flow |
| [docs/INTERFACES.md](./docs/INTERFACES.md) | The contracts shared between agents: schemas, API, database, jobs, env variables |
| [docs/METEORA.md](./docs/METEORA.md) | Everything verified about the Meteora SDK and Jupiter, with the limits |
| [docs/SECURITY.md](./docs/SECURITY.md) | Known vulnerabilities and their protections |
| [docs/DEVNET_TESTS.md](./docs/DEVNET_TESTS.md) | The 4 on-chain tests to run first, with plan B |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Alerts, kill switches, sleep mode, support |
| [docs/DECISIONS.md](./docs/DECISIONS.md) | All decisions made and the questions still open |

## Tasks by agent

| File | Agent | Owned folder |
|---|---|---|
| [tasks/00-SETUP.md](./tasks/00-SETUP.md) | Ali (manual) | — |
| [tasks/01-ONCHAIN.md](./tasks/01-ONCHAIN.md) | Agent 1 | `packages/core`, `scripts/devnet-tests` |
| [tasks/02-TEMPLATE.md](./tasks/02-TEMPLATE.md) | Agent 2 | `apps/launchpad-template` |
| [tasks/03-WEB.md](./tasks/03-WEB.md) | Agent 3 | `apps/web`, `supabase` |
| [tasks/04-BUILDER.md](./tasks/04-BUILDER.md) | Agent 4 | `apps/builder` |
| [tasks/05-SIGNER.md](./tasks/05-SIGNER.md) | Agent 5 | `apps/signer` |
| [tasks/08-FRONTEND.md](./tasks/08-FRONTEND.md) | Agent 6 (frontend) | visual zone of `apps/web` and of the template — full folder: [docs/frontend/](./docs/frontend/README.md) |
| [tasks/06-INTEGRATION.md](./tasks/06-INTEGRATION.md) | Lead session | everything, read-only; targeted fixes |
| [tasks/07-MAINNET.md](./tasks/07-MAINNET.md) | Ali + lead session | — |

## Repo structure

```
forge/
├── PLANEXECUTE.md  KICKOFF.md  README.md
├── docs/                      # specifications (read-only for agents)
├── tasks/                     # one task sheet per agent
├── packages/
│   ├── shared/                # @forge/shared: shared types and schemas (lead session)
│   └── core/                  # @forge/core: LOCKED transaction core (agent 1)
├── apps/
│   ├── web/                   # FORGE site: chat, dashboard, API (agent 3)
│   ├── launchpad-template/    # client site template, fork of fun-launch (agent 2)
│   ├── builder/               # VPS worker: AI agent, sandbox, GitHub, Vercel, scan (agent 4)
│   └── signer/                # separate VPS: signer, claims, buyback, alerts (agent 5)
├── scripts/devnet-tests/      # day-1 on-chain tests (agent 1)
└── supabase/migrations/       # database schema (agent 3)
```

## Stack

TypeScript everywhere, pnpm + Turborepo monorepo, Node 20+. Solana + Meteora Dynamic Bonding Curve (`@meteora-ag/dynamic-bonding-curve-sdk`). Next.js on Vercel. Supabase (Postgres + Realtime). 2 Hetzner VPS. Helius (RPC). Squads (multisig). Claude API for the agent.
