# DECISIONS

Tenu à jour par la session lead. Les agents le lisent, ne le modifient pas.

## Prises

| # | Décision | Détail |
|---|---|---|
| D1 | Chaîne et moteur | Solana + Meteora Dynamic Bonding Curve, aucun smart contract à nous |
| D2 | Prix de création | 33 $ en SOL (~0,3 SOL), prix fixé en dollars |
| D3 | Modifs | 2 incluses, puis 5,50 $ chacune |
| D4 | Échec de l'agent | 2 essais, puis remboursement automatique |
| D5 | Accès à l'agent | détenir une quantité fixe de $FORGE (~100 $), revue chaque semaine, revérifiée à chaque utilisation |
| D6 | Part créateur FORGE | 25 % sur le coin de chaque launchpad, FORGE est son créateur |
| D7 | Frais plateforme | 30 bps sur notre bouton d'achat avant graduation ; 30 bps de frais intégrateur Jupiter après |
| D8 | Revenus de trading | 100 % buyback de $FORGE, pas de burn, tokens en trésorerie |
| D9 | Règle de secours | si les créations ne couvrent plus les coûts fixes, 10 à 20 % des revenus de trading vont à la caisse (décision manuelle) |
| D10 | Agent builder | code le design de chaque launchpad, un repo + un déploiement Vercel par client |
| D11 | Interface client | chat sur le site FORGE |
| D12 | Infra | Vercel + 2 VPS Hetzner (builder / signer séparés) + Supabase + Helius + Squads |
| D13 | Lancement de $FORGE | sur le launchpad FORGE construit par notre agent, après validation du MVP sur mainnet |
| D14 | Part équipe $FORGE | premier achat de 3 à 5 % de la supply, annoncé, bloqué un temps |
| D15 | Monnaie | SOL uniquement dans le MVP |
| D16 | Seuil de migration | 10 SOL |
| D17 | Reporté | compte X de l'agent, domaines personnalisés, avis juridique, accord d'équipe écrit |
| D18 | Échec après validation | un échec à l'étape on-chain ou déploiement n'est ni relancé ni remboursé automatiquement : alerte + traitement manuel (des configs ont pu être créées) |
## Ouvertes (à trancher par l'équipe)

| # | Question | Bloque |
|---|---|---|
| Q1 | Membres du multisig et nombre de signatures (proposition : 2 sur 3) | création du multisig (setup) |
| Q2 | Qui avance les frais de départ (~150 $ puis ~110 $/mois) | ouverture des comptes |
| Q3 | Nom FORGE définitif et domaines (FORGE + domaine séparé des sites clients) | setup Vercel |
| Q4 | Outil de blocage du premier achat du client (Streamflow, Jupiter Lock…) et durée | fin du MVP (pas bloquant pour commencer) |
| Q5 | Premiers clients testeurs | tests mainnet |
| Q6 | Qui gère le support | lancement public |
| Q7 | Date de lancement public | planning |

## Résultats des tests devnet

| Test | Résultat | Plan B appliqué |
|---|---|---|
| 1. Référence Meteora | à faire | — |
| 2. Part créateur | à faire | — |
| 3. Premier achat client | à faire | — |
| 4. Frais plateforme | à faire | — |
