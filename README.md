# FORGE

Un agent IA qui construit un launchpad Meteora complet à partir d'une conversation.

Le client (exemple : Hugo) décrit son launchpad, paie ~33 $ en SOL, l'agent code son site, FORGE crée sa config Meteora et lance le coin de son launchpad. Ensuite, une part des frais de trading revient à FORGE et sert à racheter $FORGE.

## Par où commencer

1. **[KICKOFF.md](./KICKOFF.md)** : l'ordre exact pour lancer le dev et les prompts à coller dans chaque agent Claude Code.
2. **[PLANEXECUTE.md](./PLANEXECUTE.md)** : les règles que tous les agents doivent suivre. À lire en premier par chaque agent.
3. **[tasks/00-SETUP.md](./tasks/00-SETUP.md)** : ce qu'Ali fait à la main avant de lancer les agents (comptes, clés, wallets).

## Documentation

| Fichier | Contenu |
|---|---|
| [docs/PRODUCT.md](./docs/PRODUCT.md) | Le produit, le flow complet (exemple Hugo / MoonPad), les prix, qui touche quoi |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Les composants, l'infra, le flux des données |
| [docs/INTERFACES.md](./docs/INTERFACES.md) | Les contrats partagés entre agents : schémas, API, base de données, jobs, variables d'env |
| [docs/METEORA.md](./docs/METEORA.md) | Tout ce qui est vérifié sur le SDK Meteora et sur Jupiter, avec les limites |
| [docs/SECURITY.md](./docs/SECURITY.md) | Les failles connues et leurs protections |
| [docs/DEVNET_TESTS.md](./docs/DEVNET_TESTS.md) | Les 4 tests on-chain à faire en premier, avec plan B |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Alertes, coupe-circuits, mise en veille, support |
| [docs/DECISIONS.md](./docs/DECISIONS.md) | Toutes les décisions prises et les questions encore ouvertes |

## Tâches par agent

| Fichier | Agent | Dossier possédé |
|---|---|---|
| [tasks/00-SETUP.md](./tasks/00-SETUP.md) | Ali (manuel) | — |
| [tasks/01-ONCHAIN.md](./tasks/01-ONCHAIN.md) | Agent 1 | `packages/core`, `scripts/devnet-tests` |
| [tasks/02-TEMPLATE.md](./tasks/02-TEMPLATE.md) | Agent 2 | `apps/launchpad-template` |
| [tasks/03-WEB.md](./tasks/03-WEB.md) | Agent 3 | `apps/web`, `supabase` |
| [tasks/04-BUILDER.md](./tasks/04-BUILDER.md) | Agent 4 | `apps/builder` |
| [tasks/05-SIGNER.md](./tasks/05-SIGNER.md) | Agent 5 | `apps/signer` |
| [tasks/06-INTEGRATION.md](./tasks/06-INTEGRATION.md) | Session lead | tout, en lecture ; corrections ciblées |
| [tasks/07-MAINNET.md](./tasks/07-MAINNET.md) | Ali + session lead | — |

## Structure du repo

```
forge/
├── PLANEXECUTE.md  KICKOFF.md  README.md
├── docs/                      # spécifications (lecture seule pour les agents)
├── tasks/                     # une fiche par agent
├── packages/
│   ├── shared/                # @forge/shared : types et schémas partagés (session lead)
│   └── core/                  # @forge/core : noyau de transactions VERROUILLÉ (agent 1)
├── apps/
│   ├── web/                   # site FORGE : chat, dashboard, API (agent 3)
│   ├── launchpad-template/    # template des sites clients, fork de fun-launch (agent 2)
│   ├── builder/               # worker VPS : agent IA, sandbox, GitHub, Vercel, scan (agent 4)
│   └── signer/                # VPS séparé : signer, claims, buyback, alertes (agent 5)
├── scripts/devnet-tests/      # tests on-chain du jour 1 (agent 1)
└── supabase/migrations/       # schéma de la base (agent 3)
```

## Stack

TypeScript partout, monorepo pnpm + Turborepo, Node 20+. Solana + Meteora Dynamic Bonding Curve (`@meteora-ag/dynamic-bonding-curve-sdk`). Next.js sur Vercel. Supabase (Postgres + Realtime). 2 VPS Hetzner. Helius (RPC). Squads (multisig). Claude API pour l'agent.
