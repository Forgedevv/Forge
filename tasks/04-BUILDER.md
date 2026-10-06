# 04 — BUILDER (agent 4)

**Tu possèdes** : `apps/builder`.
**Tu lis** : `PLANEXECUTE.md`, `docs/ARCHITECTURE.md`, `docs/INTERFACES.md` (§4, §5, §7, §8), `docs/SECURITY.md` (sections 1 à 4), `docs/OPERATIONS.md`.

Tu construis le worker qui tourne sur le VPS 1 : il prend les jobs, fait travailler l'agent IA dans une sandbox, scanne, pousse sur le repo du client, déploie sur Vercel et demande au signer de brancher Meteora. C'est la brique la plus complexe : avance par petites étapes testables.

## Composants

```
apps/builder/src/
├── worker.ts          # boucle : prend un job (requête "for update skip locked"), le traite, met à jour le statut
├── pipeline/
│   ├── create.ts      # create_launchpad : repo + agent + scan + aperçu, puis (après approved) signer + prod
│   └── modify.ts      # modify_launchpad : agent + scan + aperçu, puis prod
├── github.ts          # GitHub App : repo depuis le template, jeton limité au repo, branches, push
├── sandbox/
│   ├── run.ts         # lance un conteneur Docker par job, monte uniquement le dossier du job
│   ├── Dockerfile     # Node 20 + Claude Code, utilisateur non root
│   └── network.ts     # réseau Docker avec liste blanche de sortie
├── gateway/           # passerelle IA (proxy compatible API Anthropic) sur l'hôte
│   └── server.ts      # vraie clé ici ; jetons temporaires par job ; budget OPS.agentBudgetUsdPerJob ; journal des coûts
├── prompts/
│   └── builder.md     # prompt système de l'agent (règles : ne toucher que src/theme, src/content, pages ; jamais src/forge)
├── scan/
│   └── scan.ts        # règles de SECURITY.md §1, sortie : ok | liste des violations
├── vercel.ts          # projet par client, variables d'env, déploiement d'aperçu, promotion en prod, sous-domaine
├── signer-client.ts   # appels HMAC vers apps/signer (/v1/configs, /v1/launch-coin/prepare)
├── sleep.ts           # mise en veille des launchpads inactifs (30 jours)
└── alerts.ts          # Telegram
```

## À faire

- [ ] Worker et transitions de statut exactement comme `INTERFACES.md` §4, avec `job_events` lisibles par le client ("Je crée ton repo", "Je code le design", "Aperçu prêt").
- [ ] GitHub : créer le repo client depuis `launchpad-template`, écrire `forge.config.json` (sans `onchain` au départ), branche `forge/<jobId>`.
- [ ] Sandbox : conteneur par job, Claude Code en mode headless (`claude -p`, sortie JSON, outils limités à lecture/écriture de fichiers et commandes npm de build), `ANTHROPIC_BASE_URL` = passerelle, `ANTHROPIC_AUTH_TOKEN` = jeton du job. Timeout `OPS.agentTimeoutMinutes`. Le prompt contient la `LaunchpadSpec` (theme, designNotes) ou la demande de modif.
- [ ] Passerelle IA : proxy vers l'API Anthropic, refuse les jetons expirés ou au-delà du budget, enregistre le coût par job dans `jobs.api_cost_usd`.
- [ ] Scan bloquant avant tout push (SECURITY.md §1). En cas de violation : pas de push, job `failed` avec la liste des violations, alerte Telegram.
- [ ] Build local du site dans la sandbox avant push (évite les déploiements cassés).
- [ ] Vercel : projet par client, variables d'env (adresses FORGE, clé Jupiter, R2, URL du relais RPC), déploiement d'aperçu sur la branche → `preview_ready` avec l'URL.
- [ ] Après `approved` : appel signer `/v1/configs` → écrire les adresses dans `forge.config.json#onchain` (commit par le builder, pas par l'agent) → appel `/v1/launch-coin/prepare` → `jobs.owner_tx` → `awaiting_owner_signature`.
- [ ] Quand la transaction du client est confirmée (le web met à jour), merge de la branche sur `main`, promotion en production, sous-domaine `<slug>.<domaine-clients>` → `live`.
- [ ] Échec : `failed`, relance automatique si `attempts < 2`.
- [ ] Flag `deploys_paused` respecté ; mise en veille quotidienne (`sleep.ts`).

## Tests

- [ ] Tests unitaires du scan avec des diffs piégés (adresse ajoutée, script externe, modification de `src/forge`, changement de version de `@forge/core`) : tous doivent être bloqués.
- [ ] Test de la passerelle : jeton expiré refusé, budget dépassé refusé.
- [ ] Test de bout en bout sur un repo de test et un projet Vercel de test, avec un signer mocké.

## Dépendances

Template publié (agent 2), signer (agent 5) : utiliser des mocks qui respectent `INTERFACES.md` §7 tant qu'ils ne sont pas prêts.

## Rapport

_À remplir en fin de tâche._
