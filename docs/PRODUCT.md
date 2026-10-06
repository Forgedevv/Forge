# PRODUCT — ce que fait FORGE

## En une phrase

Un client décrit son launchpad à un agent IA ; l'agent code son site, FORGE le branche sur Meteora et lance le coin du launchpad ; une part des frais de trading revient à FORGE et sert à racheter $FORGE.

## Les acteurs

| Acteur | Rôle | Paie | Touche |
|---|---|---|---|
| Client (ex. Hugo) | Fait construire son launchpad | ~33 $ en SOL à la création, détient des $FORGE | Part partenaire de tous les coins de son launchpad ; ses tokens du premier achat |
| Créateur de coin (ex. Lisa) | Lance un coin sur le launchpad du client | Frais de création fixés par le client | Part créateur de son coin |
| Trader | Achète et vend | Frais Meteora (~1 %) + frais plateforme FORGE (0,3 %) | — |
| FORGE | Construit, héberge, lance le coin du launchpad | IA, serveurs, RPC | Prix de création, part créateur du coin du launchpad, référence, frais plateforme |
| Meteora | Contrats on-chain | — | 20 % des frais de trading (moins la référence) |
| Jupiter | Trading des coins gradués | — | 20 % de nos frais intégrateur |

## Flow 1 : création (exemple Hugo / MoonPad)

1. **Hugo parle à l'agent** sur le site FORGE : nom (MoonPad), frais de trading (1 %), monnaie (SOL), style. L'agent pose ses questions et produit une spécification (`LaunchpadSpec`, voir `INTERFACES.md`).
2. **Vérification du token** : Hugo doit détenir une quantité fixe de $FORGE (`FORGE_GATING_AMOUNT`, ~100 $, revue chaque semaine). Rien n'est dépensé. Revérifié à chaque utilisation de l'agent.
3. **Paiement** : prix fixé à **33 $**, converti en SOL au moment du devis (~0,3 SOL). Devis valable 120 secondes. Hugo signe le paiement depuis le wallet qui recevra ses frais.
4. **L'agent code le site** : repo GitHub créé depuis le template, l'agent modifie le design, les pages et les textes. Le noyau de transactions (`@forge/core`) est verrouillé.
5. **Scan + aperçu** : scan de sécurité sur notre VPS, puis déploiement d'aperçu Vercel. Hugo valide.
6. **Configs Meteora** : le signer FORGE crée deux configs :
   - **config du launchpad** : `feeClaimer` = wallet d'Hugo, pour tous les coins lancés sur MoonPad ;
   - **config du coin du launchpad** : `feeClaimer` = wallet d'Hugo, `creatorTradingFeePercentage` = 25 (FORGE est créateur).
7. **Lancement de $MOON** : un wallet créateur dédié à MoonPad crée le pool. Hugo paie et signe son premier achat dans la même transaction et reçoit ses $MOON.
8. **Mise en ligne** : le site passe en production sur Vercel, sous-domaine du domaine des sites clients.

**Échec** : 2 essais inclus. Si l'agent échoue deux fois, remboursement automatique du paiement.

## Flow 2 : modifications

- Hugo redemande l'agent depuis son tableau de bord.
- Revérification des $FORGE.
- **2 modifs incluses** dans la création, puis **5,50 $ par modif** (converti en SOL, ~0,05 SOL).
- Budget API plafonné par demande, même scan, même aperçu, même validation.
- Historique des versions, retour arrière possible.
- Les paramètres on-chain (frais, courbe, destinataire) ne changent pas : une config Meteora est figée.

## Flow 3 : revenus

### Coin encore sur la courbe (avant graduation)

Le trade passe par **notre bouton d'achat**, qui appelle Meteora directement. Exemple : achat de 1 000 $, frais Meteora 1 % = 10 $, frais plateforme 0,3 % = 3 $.

| | $MOON (coin du launchpad) | $CAT (coin de Lisa) |
|---|---|---|
| Meteora | 1,60 $ | 1,60 $ |
| Référence → FORGE | 0,40 $ | 0,40 $ |
| Créateur | 2 $ → FORGE (25 % des 8 $) | 2 $ → Lisa (25 % des 8 $) |
| Partenaire (Hugo) | 6 $ | 6 $ |
| Frais plateforme → FORGE | 3 $ | 3 $ |
| **Total FORGE** | **5,40 $** | **3,40 $** |

Si le trade passe par un bot ou un terminal (pas notre bouton) : FORGE ne touche que la part créateur sur $MOON, rien sur $CAT.

### Coin gradué (après la migration)

Le trade passe par le plugin Jupiter avec notre frais intégrateur de 30 bps ; Jupiter en garde 20 %. Plus de référence Meteora pour nous.

| | $MOON | $CAT |
|---|---|---|
| Frais intégrateur (0,3 % − 20 %) | 2,40 $ | 2,40 $ |
| Part créateur (via la liquidité du pool, hypothèse) | ~2 $ | 0 $ |
| **Total FORGE** | **~4,40 $** | **2,40 $** |

### Où va l'argent

- **Prix de création et modifs** → caisse d'exploitation (paie l'IA et les serveurs).
- **Tous les revenus de trading** → multisig, puis **buyback de $FORGE**. Pas de burn : les tokens rachetés restent dans la trésorerie.
- **Règle de secours** : si les créations ne couvrent plus les coûts fixes, 10 à 20 % des revenus de trading vont à la caisse (décision manuelle de l'équipe).

## Chiffres clés

| Élément | Valeur |
|---|---|
| Prix de création | 33 $ en SOL (~0,3 SOL) |
| Modifs incluses | 2, puis 5,50 $ chacune |
| Essais avant remboursement | 2 |
| Seuil de token-gating | quantité fixe de $FORGE (~100 $), revue chaque semaine |
| Part créateur FORGE sur le coin du launchpad | 25 % |
| Frais plateforme | 30 bps (notre bouton) ; 30 bps intégrateur Jupiter après graduation |
| Frais de trading proposés aux clients | entre 50 et 200 bps |
| Seuil de migration | 10 SOL |
| Mise en veille | 30 jours sans trade |
| Marge par création | ~15 $ |
| Coûts fixes | ~110 $/mois après le lancement public |

## $FORGE

- Lancé sur **le launchpad FORGE, construit par notre propre agent**, une fois le MVP validé sur mainnet.
- FORGE est créateur de $FORGE : la part créateur de ses trades alimente aussi le buyback.
- Part équipe : premier achat de 3 à 5 % de la supply, annoncé publiquement, bloqué un temps.
- Avant son lancement, le token-gating utilise un faux $FORGE sur devnet.

## Hors périmètre du MVP

- Compte X de l'agent (après le lancement).
- Monnaie de cotation autre que SOL.
- Domaines personnalisés des clients (sous-domaines uniquement au départ).
