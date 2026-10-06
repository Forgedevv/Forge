# DEVNET_TESTS — à faire avant tout le reste

Quatre tests on-chain sur devnet, écrits par l'agent 1 dans `scripts/devnet-tests/`. Ils valident les hypothèses du modèle de revenus. Chaque test a un plan B ; aucun échec ne bloque le projet, mais un échec change le code de `@forge/core`.

Un script existe déjà pour le test 1 (`dbc-referral-test/test.mjs`, écrit lors d'une session précédente) : le reprendre et l'adapter.

## Règles

- Le script refuse de tourner si `RPC_URL` ne contient pas `devnet`.
- Wallets jetables générés et sauvegardés dans `scripts/devnet-tests/.state/` (dans `.gitignore`).
- Le SOL devnet vient de https://faucet.solana.com (connexion GitHub) : Ali alimente le wallet `funder` affiché par le script, le script répartit ensuite.
- Chaque test écrit un rapport `scripts/devnet-tests/reports/<test>.md` avec les montants mesurés et les liens Solscan devnet.
- Reprise : relancer un script ne refait pas les étapes déjà faites.

## Test 1 — Référence Meteora

**Objectif** : confirmer qu'un swap avec `referralTokenAccount` donne 20 % de la part protocole au compte de référence, sans toucher à la part partenaire.

1. Config simple (quote SOL, 1 % de frais, `creatorTradingFeePercentage` = 0).
2. Pool.
3. Compte WSOL du wallet `referral`.
4. Achat de 0,1 SOL avec référence, puis le même sans référence.
5. Mesurer : solde du compte de référence, variation de `partnerQuoteFee`, `protocolQuoteFee`, `creatorQuoteFee` dans l'état du pool, événement de swap.

**Attendu** : frais ≈ 1 000 000 lamports ; avec référence : protocole 160 000, référence 40 000 ; partenaire 800 000 dans les deux cas.

**Plan B** : on garde uniquement le frais plateforme de 0,3 %. Perte ≈ 0,04 % du volume passant par notre bouton.

## Test 2 — Part créateur sur config dédiée

**Objectif** : confirmer que le wallet créateur touche `creatorTradingFeePercentage` et peut le réclamer vers une autre adresse ; mesurer ce qui se passe après migration.

1. Config avec `creatorTradingFeePercentage` = 25 et une part de liquidité créateur bloquée en permanence.
2. Pool créé avec `poolCreator` = wallet `forgeCreator`.
3. Plusieurs achats et ventes depuis `trader`.
4. `claimCreatorTradingFeeToReceiver` vers le wallet `multisigStandIn`.
5. Remplir la courbe jusqu'au seuil, migrer avec l'outil manuel, faire des swaps sur le pool migré, réclamer les frais de la liquidité créateur.

**Attendu** : créateur ≈ 25 % de la part hors protocole avant migration ; frais de liquidité créateur après migration.

**Plan B** : inverser les rôles sur la config du coin du launchpad : FORGE `feeClaimer` (partenaire), le client créateur. À valider avec l'équipe si ce cas arrive.

## Test 3 — Premier achat payé par le client

**Objectif** : confirmer qu'une seule transaction peut créer le pool (signée par `forgeCreator`) et faire le premier achat payé et signé par `client`, tokens reçus par `client`.

1. Le script construit `createPoolWithFirstBuy` avec `poolCreator` = `forgeCreator`, `buyer` = `receiver` = `client`.
2. Signature partielle par `forgeCreator` (et le keypair du mint), sérialisation, puis signature par `client`, envoi.
3. Vérifier : pool créé, créateur = `forgeCreator`, tokens chez `client`, SOL débité chez `client`.
4. Avec `enableFirstSwapWithMinFee` = true et anti-sniper actif : vérifier que le premier achat paie le frais minimum.

**Plan B** : FORGE crée le pool, le client achète dans une transaction séparée juste après, avec l'anti-sniper actif.

## Test 4 — Frais plateforme dans le swap

**Objectif** : confirmer qu'on peut ajouter un transfert de 0,3 % dans la même transaction que le swap, à l'achat et à la vente.

1. Transaction : transfert SOL de 30 bps vers `platformFee` + swap (avec référence).
2. Achat puis vente.
3. Vérifier les soldes et la taille de la transaction (limite de taille Solana).

**Plan B** : si la transaction dépasse la taille limite, utiliser une table d'adresses (lookup table) ; si un wallet affiche un avertissement bloquant (testé plus tard sur mainnet), afficher le frais avant signature ou baisser le taux.

## Après les tests

L'agent 1 écrit un résumé des 4 résultats dans `scripts/devnet-tests/reports/SUMMARY.md` (et le plan B proposé si un test échoue). La session lead reporte ces résultats dans `docs/DECISIONS.md` et valide le plan B avec Ali. Le reste de `@forge/core` est écrit en fonction de ces résultats.
