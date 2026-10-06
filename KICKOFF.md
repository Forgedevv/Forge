# KICKOFF — lancer le dev

## Étape 1 — Setup manuel (Ali)

Suis `tasks/00-SETUP.md`. Au minimum pour démarrer : organisation GitHub + monorepo, Supabase, Helius (devnet), multisig Squads devnet, 2 VPS (le builder et le signer peuvent démarrer en local et être déployés plus tard).

## Étape 2 — Session lead (environ 1 h)

Ouvre Claude Code à la racine du repo et colle :

```
Tu es la session lead de FORGE. Lis PLANEXECUTE.md, README.md, docs/INTERFACES.md et tasks/06-INTEGRATION.md.
Fais uniquement la "Phase 0" de tasks/06-INTEGRATION.md : squelette du monorepo et packages/shared traduit depuis docs/INTERFACES.md, avec tests.
Quand c'est fini et que pnpm typecheck et pnpm test passent, fais un commit sur main et arrête-toi.
```

## Étape 3 — Worktrees

Un dossier par agent, chacun sur sa branche, pour qu'ils ne se marchent pas dessus :

```bash
git worktree add ../forge-onchain  -b agent/onchain
git worktree add ../forge-template -b agent/template
git worktree add ../forge-web      -b agent/web
git worktree add ../forge-builder  -b agent/builder
git worktree add ../forge-signer   -b agent/signer
```

## Étape 4 — Lancer les agents

Ouvre un terminal par worktree, lance `claude`, colle le prompt correspondant.

**Avec un abonnement, 5 agents en parallèle peuvent toucher les limites d'usage.** Dans ce cas, lance par vagues :
- **Vague 1** : agent 1 (on-chain), agent 4 (builder), agent 3 (web).
- **Vague 2** : agent 2 (template), agent 5 (signer).

L'agent 1 commence par les tests devnet : ils conditionnent une partie du code des autres. Les autres avancent avec des mocks en attendant.

### Agent 1 — On-chain

```
Tu es l'agent 1 (on-chain) de FORGE. Lis PLANEXECUTE.md, puis tasks/01-ONCHAIN.md, puis les docs qu'elle cite.
Commence par l'étape A (tests devnet). Quand un script a besoin de SOL devnet, affiche l'adresse à alimenter et attends que je te dise que c'est fait.
Ne modifie que packages/core et scripts/devnet-tests. Remplis la section Rapport de ta fiche à la fin.
```

### Agent 2 — Template

```
Tu es l'agent 2 (template) de FORGE. Lis PLANEXECUTE.md, puis tasks/02-TEMPLATE.md, puis les docs qu'elle cite.
Ne modifie que apps/launchpad-template. Utilise @forge/core via le workspace et des mocks pour ce qui n'existe pas encore.
Remplis la section Rapport de ta fiche à la fin.
```

### Agent 3 — Web

```
Tu es l'agent 3 (web) de FORGE. Lis PLANEXECUTE.md, puis tasks/03-WEB.md, puis les docs qu'elle cite.
Ne modifie que apps/web et supabase. Mocke le builder et le signer : tu communiques avec eux uniquement via Supabase.
Remplis la section Rapport de ta fiche à la fin.
```

### Agent 4 — Builder

```
Tu es l'agent 4 (builder) de FORGE. Lis PLANEXECUTE.md, puis tasks/04-BUILDER.md, puis les docs qu'elle cite.
Ne modifie que apps/builder. Commence par le scan et la passerelle IA avec leurs tests, puis le worker, puis GitHub et Vercel. Mocke le signer.
Remplis la section Rapport de ta fiche à la fin.
```

### Agent 5 — Signer

```
Tu es l'agent 5 (signer) de FORGE. Lis PLANEXECUTE.md, puis tasks/05-SIGNER.md, puis les docs qu'elle cite.
Ne modifie que apps/signer. Commence par le keystore et l'API HMAC avec leurs tests. Tout se teste sur devnet.
Remplis la section Rapport de ta fiche à la fin.
```

## Étape 5 — Pendant le build

- Relance la session lead deux fois par jour avec : `Lis docs/CHANGE_REQUESTS.md et les rapports dans tasks/, tranche les demandes, mets à jour packages/shared et docs, puis fusionne dans main les branches dont les tests passent.`
- Après une fusion, dans chaque worktree : `git merge main`.

## Étape 6 — Intégration puis mainnet

- Session lead : phase d'intégration de `tasks/06-INTEGRATION.md`.
- Puis `tasks/07-MAINNET.md`.

## Calendrier réaliste

| Étape | Durée |
|---|---|
| Setup + phase 0 | une demi-journée |
| Tests devnet + build en parallèle | 1,5 à 2 jours |
| Intégration devnet | 0,5 à 1 jour |
| Tests mainnet | 2 à 4 jours (beaucoup d'attente) |
| Lancement de $FORGE | une demi-journée |
