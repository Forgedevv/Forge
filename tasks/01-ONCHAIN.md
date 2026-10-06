# 01 — ON-CHAIN (agent 1)

**Tu possèdes** : `packages/core`, `scripts/devnet-tests`.
**Tu lis** : `PLANEXECUTE.md`, `docs/METEORA.md`, `docs/DEVNET_TESTS.md`, `docs/INTERFACES.md`, `docs/SECURITY.md` (sections 1, 5).

Tu écris le **noyau de transactions** utilisé par tous les autres : le template (swaps, claims), le web (paiements), le signer (configs, pools, claims, buyback). C'est le code le plus sensible du projet. Il doit être simple, testé et sans dépendance inutile.

## Étape A — Tests devnet (en premier, bloquant)

- [ ] `scripts/devnet-tests/` : les 4 tests de `docs/DEVNET_TESTS.md`, avec reprise, refus hors devnet, rapports.
- [ ] Créer aussi un **faux $FORGE** (mint SPL sur devnet) et l'enregistrer dans `.state/`, pour les tests de token-gating des autres agents.
- [ ] `reports/SUMMARY.md` avec les 4 résultats et le plan B proposé si besoin.

Tant que les tests 1 à 3 ne sont pas passés (ou leur plan B choisi), n'écris pas les fonctions correspondantes de l'étape B.

## Étape B — `@forge/core`

Structure :

```
packages/core/src/
├── addresses.ts      # adresses FORGE lues depuis l'env, validées au chargement
├── constants.ts      # réexporte packages/shared + bornes du SDK
├── validate.ts       # validation des paramètres on-chain (bornes METEORA.md + INTERFACES.md)
├── config.ts         # construction des 2 configs à partir d'une LaunchpadSpec
├── pool.ts           # création de pool + premier achat (transaction partiellement signable)
├── swap.ts           # swap avec référence + frais plateforme (achat et vente)
├── claims.ts         # réclamation créateur (vers receiver) et partenaire
├── reads.ts          # pools d'une config, progression de la courbe, métriques de frais
├── payments.ts       # transaction de paiement SOL vers la caisse, vérification d'un paiement
├── gating.ts         # solde $FORGE d'un wallet
└── index.ts
```

- [ ] `addresses.ts` : `FORGE_MULTISIG_VAULT`, `FORGE_METEORA_REFERRAL_ACCOUNT`, `FORGE_PLATFORM_FEE_WALLET`, `FORGE_CASHBOX_WALLET`, `FORGE_MINT` lus depuis l'env ; erreur au démarrage si absent ou invalide.
- [ ] `validate.ts` : une fonction par config ; refuse tout ce qui sort des bornes ; tests unitaires pour chaque borne.
- [ ] `config.ts` : `buildLaunchpadConfig(spec)` et `buildLaunchpadCoinConfig(spec)` → `ConfigParameters` + `feeClaimer` + `leftoverReceiver`, selon `docs/METEORA.md` (section "Réglages des deux configs"). Utiliser les helpers `buildCurve*` du SDK.
- [ ] `pool.ts` : `buildLaunchCoinTx({ config, creator, owner, mintKeypair, metadataUri, firstBuyLamports })` → transaction avec `createPoolWithFirstBuy`, prête à être signée par le créateur et le mint (côté signer) puis par le client. Paramètre optionnel `durableNonce` (compte de nonce + autorité) : une transaction classique expire en ~1 minute, trop court pour que le client signe ; avec un nonce durable elle reste valide jusqu'à utilisation.
- [ ] `swap.ts` : `buildBuyTx` et `buildSellTx` avec `referralTokenAccount` = référence FORGE et le transfert de 30 bps ; refuse de construire un swap sur un pool gradué (le template utilise Jupiter dans ce cas). Respecter la taille de transaction (lookup table si besoin).
- [ ] `claims.ts` : `buildCreatorClaimTx(pool, creator, receiver)`, `buildPartnerClaimTx(pool, feeClaimer)`.
- [ ] `reads.ts` : `listCoinsOfConfig`, `isGraduated`, `curveProgress`, `feeMetrics`.
- [ ] `payments.ts` : `buildPaymentTx(payer, lamports)` vers la caisse avec un mémo `jobId` ; `verifyPayment(signature, { payer, lamports, jobId })`.
- [ ] `gating.ts` : `getForgeBalance(wallet)`.
- [ ] Tests unitaires (vitest) sans réseau pour validate et la construction des transactions ; tests d'intégration devnet pour pool, swap, claims, payments.
- [ ] Publication : script `pnpm --filter @forge/core publish` vers GitHub Packages, version sémantique. **La version utilisée par le template est épinglée exactement** (pas de `^`).

## Interfaces dont tu dépends

`packages/shared` (écrit par la session lead). Si un type manque, mock local + `docs/CHANGE_REQUESTS.md`.

## Rapport

_À remplir en fin de tâche : fait / pas fait / incertain / dépendances ajoutées / résultats des tests devnet._
