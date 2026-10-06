# 07 — MAINNET : tests réels et lancement

**Qui** : Ali + session lead. Petits montants uniquement (budget total 0,5 à 1 SOL).

## Avant de passer en mainnet

- [ ] Le parcours d'intégration devnet (`tasks/06`) passe entièrement.
- [ ] Multisig Squads mainnet créé, membres et seuil validés (Q1).
- [ ] Limite de dépense Anthropic fixée ; budget par job vérifié.
- [ ] Helius et Supabase passés en offre payante ; clé Jupiter créée ; compte de référence Jupiter et comptes token SOL + USDC créés, détenus par le multisig.
- [ ] Compte de référence Meteora (WSOL) détenu par le multisig.
- [ ] `SOLANA_CLUSTER=mainnet-beta` uniquement sur les environnements de production.

## Tests mainnet (petits montants)

- [ ] Créer un launchpad de test complet (paiement réel ~33 $, ou prix temporaire réduit en variable d'env pour le test).
- [ ] Interface du template : liste des coins via Jupiter, `BuyButton` sur un coin sur la courbe.
- [ ] **Affichage dans Phantom et Backpack** : le transfert de 0,3 % et le swap s'affichent sans avertissement bloquant.
- [ ] Référence Meteora et frais plateforme reçus sur les comptes du multisig.
- [ ] Faire graduer un coin de test (seuil 10 SOL : utiliser un launchpad de test à seuil bas si possible, sinon tester la graduation uniquement sur devnet avec l'outil manuel) ; trade via `JupiterTrade` ; frais intégrateur reçus (montant, monnaie).
- [ ] Claims automatiques vers le multisig ; réclamation partenaire par le client.
- [ ] Alertes Telegram reçues (simuler un solde bas).

## Lancement de $FORGE

- [ ] L'agent construit le launchpad FORGE comme pour un vrai client.
- [ ] Simuler la courbe pour connaître le coût du premier achat équipe (3 à 5 % de la supply).
- [ ] Premier achat équipe, annoncé publiquement, bloqué avec l'outil choisi (Q4).
- [ ] Renseigner `FORGE_MINT` et `FORGE_GATING_AMOUNT` en production → le token-gating s'active.
- [ ] Sortir le buyback du mode simulation.
- [ ] Activer les contacts de l'équipe au moment du lancement.

## Après le lancement

- [ ] Suivi quotidien des alertes et des coûts (OPERATIONS.md).
- [ ] Revue hebdomadaire de `FORGE_GATING_AMOUNT`.
- [ ] Compte X de l'agent (reporté).
