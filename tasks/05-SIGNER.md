# 05 — SIGNER (agent 5)

**Tu possèdes** : `apps/signer`.
**Tu lis** : `PLANEXECUTE.md`, `docs/INTERFACES.md` (§5, §7, §8), `docs/METEORA.md`, `docs/SECURITY.md` (sections 5 à 8), `docs/OPERATIONS.md`.

Tu construis le seul service qui détient des clés de FORGE. Il tourne seul sur le VPS 2. Chaque ligne de code ici peut faire perdre de l'argent : préfère toujours le refus à l'approximation.

## Composants

```
apps/signer/src/
├── server.ts          # API privée : HMAC + horodatage, IP du builder uniquement
├── keystore.ts        # wallets chiffrés au repos (créateurs, payeur, caisse, bot buyback)
├── routes/
│   ├── configs.ts     # POST /v1/configs
│   └── launch.ts      # POST /v1/launch-coin/prepare (nonce durable)
├── jobs/
│   ├── claims.ts      # toutes les 24 h : part créateur de chaque pool → multisig
│   ├── cashbox.ts     # toutes les 24 h : excédent de la caisse → multisig ; garde un tampon
│   ├── refunds.ts     # jobs failed avec attempts = 2 → remboursement → refunded
│   ├── buyback.ts     # petits achats aléatoires de $FORGE, slippage max 1 %, tokens → multisig
│   ├── convert.ts     # frais Jupiter reçus en autres monnaies → SOL
│   └── watch.ts       # surveillance : transfert de créateur, sorties inattendues, soldes bas
└── alerts.ts          # Telegram
```

## À faire

- [ ] `keystore.ts` : génération d'un wallet créateur par launchpad, stockage chiffré (`SIGNER_KEYSTORE_PASSPHRASE`), seul l'identifiant (`creator_wallet_ref`) va dans Supabase. Jamais de clé dans les logs.
- [ ] `server.ts` : vérification HMAC + horodatage ≤ 60 s, rejet de tout le reste. Le signer **relit** job, spec et paiement dans Supabase ; il ignore toute adresse ou montant du corps de la requête.
- [ ] `/v1/configs` : refuse si paiement non `confirmed` ou spec hors bornes (`validate` de core) ; crée les 2 configs (`config.ts` de core) avec le wallet payeur ; idempotent (si déjà créées pour ce job, renvoie les adresses existantes).
- [ ] `/v1/launch-coin/prepare` : crée le wallet créateur dédié, un compte de nonce durable, construit `buildLaunchCoinTx` de core, signe en tant que créateur + mint, renvoie la transaction partiellement signée.
- [ ] `claims.ts` : `buildCreatorClaimTx` vers `FORGE_MULTISIG_VAULT` pour chaque pool dont FORGE est créateur, y compris les frais de liquidité après graduation (selon le résultat du test 2).
- [ ] `refunds.ts` : rembourse depuis la caisse le montant exact payé, au wallet payeur, une seule fois (idempotent via `payments.refund_signature`).
- [ ] `buyback.ts` : retire le montant du jour depuis le multisig via la limite de dépense Squads vers le wallet du bot, achète $FORGE en plusieurs petits montants à des moments aléatoires, renvoie les tokens au vault. Respecte `buyback_paused`. Avant le lancement de $FORGE : mode simulation qui logue sans acheter.
- [ ] `convert.ts` : conversion en SOL des frais Jupiter reçus dans d'autres monnaies.
- [ ] `watch.ts` : alerte immédiate sur tout `transferPoolCreator` touchant un de nos pools, toute sortie inattendue du vault ou de la caisse, solde bas du payeur.
- [ ] Le signer n'appelle **jamais** `transferPoolCreator`.

## Tests

- [ ] Tests HMAC : signature invalide, horodatage trop vieux, rejeu → refusés.
- [ ] Tests devnet : configs, préparation du lancement avec nonce durable, signature par un wallet client simulé, claims vers un vault de test, remboursement.
- [ ] Test d'idempotence : appeler deux fois chaque route ne crée rien en double.
- [ ] Buyback en mode simulation sur devnet avec le faux $FORGE.

## Dépendances

`@forge/core` (agent 1). Supabase (agent 3) : en attendant, schéma local depuis `INTERFACES.md` §5.

## Rapport

_À remplir en fin de tâche._
