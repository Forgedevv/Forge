# PLANEXECUTE.md — règles pour tous les agents

Tu travailles sur **FORGE**, un service où un agent IA construit des launchpads Meteora pour des clients. Plusieurs agents Claude Code travaillent en parallèle sur ce repo, chacun dans son dossier. Lis ce fichier en entier, puis ta fiche dans `tasks/`, puis les docs qu'elle cite.

Si une instruction ici contredit un autre document, ce fichier gagne.

## Règles absolues

Ces règles ne se négocient pas. Si une tâche semble exiger d'en violer une, arrête-toi et signale-le.

1. **Ne modifie que ton dossier.** Chaque agent possède un dossier (voir le tableau plus bas). Tu peux lire tout le repo, mais tu n'écris que dans le tien. Si tu as besoin d'un changement ailleurs, écris-le dans `docs/CHANGE_REQUESTS.md` avec ton nom d'agent, et continue avec un mock.
2. **Ne modifie jamais `packages/shared`** sauf si tu es la session lead. C'est le contrat entre tous les agents. Un changement de contrat passe par `docs/CHANGE_REQUESTS.md`.
3. **Aucune clé privée dans le code, les logs, les tests ou git.** Les secrets viennent uniquement des variables d'environnement. `.env*` est dans `.gitignore`. Ne logue jamais une variable dont le nom contient `KEY`, `SECRET`, `TOKEN` ou `PRIVATE`.
4. **Devnet par défaut.** Toute config pointe sur devnet sauf si `SOLANA_CLUSTER=mainnet-beta` est défini explicitement. Les scripts de test refusent de tourner si l'URL RPC ne contient pas `devnet`.
5. **Un seul endroit signe des transactions avec les clés de FORGE : `apps/signer`** (wallets créateurs, claims, buyback). Seule exception : `scripts/devnet-tests`, avec des wallets jetables générés sur devnet. Aucun autre dossier n'importe de `Keypair` venant d'une clé privée. Les autres construisent des transactions que l'utilisateur signe dans son wallet.
6. **Le noyau de transactions (`packages/core`) est la seule source de vérité** pour construire un swap, une config ou un pool. Personne ne réimplémente ces transactions ailleurs.
7. **Les adresses de FORGE (multisig, comptes de référence Meteora et Jupiter, wallet des frais plateforme, caisse, mint $FORGE) ne sont jamais écrites en dur hors de `packages/core/src/addresses.ts`**, et ce fichier les lit depuis l'environnement.
8. **Toute valeur on-chain passe par la validation de `packages/core`** avant d'être envoyée : bornes des frais, seuil de migration, liquidité bloquée (voir `docs/METEORA.md`).
9. **Tu ne marques jamais une tâche terminée sans test.** Voir "Définition de terminé".

## Qui possède quoi

| Agent | Dossier possédé | Fiche |
|---|---|---|
| Session lead | `packages/shared`, fichiers racine, `docs/` | `tasks/06-INTEGRATION.md` |
| Agent 1 — On-chain | `packages/core`, `scripts/devnet-tests` | `tasks/01-ONCHAIN.md` |
| Agent 2 — Template | `apps/launchpad-template` | `tasks/02-TEMPLATE.md` |
| Agent 3 — Web | `apps/web`, `supabase` | `tasks/03-WEB.md` |
| Agent 4 — Builder | `apps/builder` | `tasks/04-BUILDER.md` |
| Agent 5 — Signer | `apps/signer` | `tasks/05-SIGNER.md` |

## Stack

- TypeScript strict, ESM, Node 20+.
- Monorepo pnpm workspaces + Turborepo.
- Solana : `@solana/web3.js` v1, `@solana/spl-token`, `@meteora-ag/dynamic-bonding-curve-sdk` (version épinglée, voir `docs/METEORA.md`).
- Validation : `zod`. Logs : `pino`. Tests : `vitest`.
- Web : Next.js (App Router pour `apps/web` ; le template garde le Pages Router de fun-launch).
- Base : Supabase (Postgres + Realtime), client `@supabase/supabase-js`.

N'ajoute pas de dépendance lourde sans le noter dans ton rapport de fin de tâche.

## Conventions

- Montants on-chain en `bigint` ou `BN` (lamports, unités brutes). Conversion en SOL ou en dollars uniquement à l'affichage.
- Pourcentages en **basis points** (`bps`) dans le code : 0,3 % = 30 bps.
- Fonctions pures dès que possible, testables sans réseau.
- Chaque fonction qui construit une transaction retourne la transaction **non signée** (ou partiellement signée côté signer), jamais envoyée directement, sauf dans `apps/signer`.
- Erreurs réseau : retry avec backoff, puis erreur claire. Ne jamais avaler une erreur on-chain silencieusement.
- Idempotence : un job, un paiement ou une signature déjà traités ne sont jamais retraités.

## Environnements

| Variable | Valeurs |
|---|---|
| `SOLANA_CLUSTER` | `devnet` (défaut) ou `mainnet-beta` |
| `RPC_URL` | Helius, devnet ou mainnet selon le cluster |

Le trading et les listes de coins du template passent par Jupiter, qui **n'indexe pas devnet**. L'interface du template se teste donc sur mainnet avec de très petits montants ; la logique on-chain se teste sur devnet par scripts. Voir `docs/METEORA.md`.

## Définition de terminé

Une tâche est terminée quand :
- `pnpm typecheck` et `pnpm test` passent pour ton dossier ;
- la logique on-chain est testée sur devnet (script ou test d'intégration) quand c'est applicable ;
- aucune règle absolue n'est enfreinte ;
- tu as écrit un court rapport en bas de ta fiche `tasks/0X-*.md`, section "Rapport" : ce qui est fait, ce qui ne l'est pas, ce qui reste incertain, les dépendances ajoutées.

## Quand tu bloques

- Une info manque dans les docs : fais l'hypothèse la plus prudente, note-la dans ton rapport, continue.
- Tu as besoin d'une brique d'un autre agent qui n'existe pas encore : utilise un mock qui respecte `packages/shared`, note-le.
- Un test devnet échoue de façon inexpliquée : note la signature de transaction et l'erreur exacte dans ton rapport, ne contourne pas en changeant les règles de sécurité.
