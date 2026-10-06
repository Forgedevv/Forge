# PROJECT — FORGE expliqué pour l'interface

## En une phrase

Un client décrit son launchpad (un site où d'autres lancent et échangent des coins Solana) à un agent IA dans un chat ; l'agent code son site, FORGE le branche sur Meteora et lance le coin du launchpad ; ensuite, une part des frais de trading revient au client et à FORGE.

## Vocabulaire

| Terme | Sens pour l'utilisateur |
|---|---|
| Launchpad | Le site du client, ex. « MoonPad », en ligne sur `moonpad.forgepads.xyz` |
| Coin du launchpad | Le token du launchpad lui-même, ex. `$MOON`, créé au lancement |
| Coin | Un token lancé par n'importe qui sur le launchpad, ex. `$CAT` de Lisa |
| Courbe / graduation | Un coin démarre sur une courbe de prix ; à 10 SOL récoltés il « gradue » et s'échange ensuite sur Jupiter |
| Frais partenaire | La part des frais de trading qui revient au client sur **tous** les coins de son launchpad ; il la réclame depuis son tableau de bord |
| Frais créateur | La part qui revient au créateur d'un coin ; réclamée sur le site du launchpad |
| $FORGE | Le token de FORGE ; il faut en détenir une quantité pour utiliser l'agent (rien n'est dépensé) |
| Aperçu | Une version de test du site, à valider avant la mise en ligne |

## Les personnes qui verront ton interface

| Qui | Où | Ce qu'il veut |
|---|---|---|
| **Client** (ex. Hugo) | site FORGE (`apps/web`) | décrire son launchpad, payer, suivre la construction, valider, lancer son coin, réclamer ses frais, demander des modifs |
| **Créateur de coin** (ex. Lisa) | site du client (template) | créer un coin, réclamer ses frais créateur |
| **Trader** | site du client (template) | voir les coins, acheter, vendre |

## Parcours 1 — Création d'un launchpad (site FORGE)

1. **Arrivée** sur la page d'accueil : ce que fait FORGE, le prix, un bouton « Connecter mon wallet ».
2. **Connexion** : le client choisit son wallet (Phantom, Backpack…), signe un message (gratuit, aucune transaction). Une session est ouverte.
3. **Vérification $FORGE** : s'il n'a pas assez de $FORGE, écran bloquant qui montre le nombre requis et son solde. Tant que $FORGE n'est pas lancé, cette étape passe toujours.
4. **Chat de conception** : l'agent pose ses questions (nom, frais de trading, part créateur, frais de création d'un coin, style, couleurs, coin du launchpad et son premier achat). Les réponses arrivent en flux, mot à mot. Quand tout est réuni, une **carte récapitulative** s'affiche ; le client peut demander des changements dans le chat ou **confirmer**.
5. **Paiement** : 33 $ convertis en SOL au moment du devis (~0,3 SOL). Le devis est valable **120 secondes** (compte à rebours). Le client signe le paiement dans son wallet ; on attend la confirmation on-chain. Devis expiré → bouton « Nouveau devis ».
6. **Construction** : page de suivi en temps réel. Des messages lisibles arrivent (« Je crée ton repo », « Je code le design », « Aperçu prêt »). Durée : quelques minutes à ~30 min.
7. **Aperçu** : lien (et si possible cadre intégré) vers l'aperçu. Le client clique « Valider ».
8. **Branchement on-chain** : FORGE crée les configs et prépare la transaction de lancement (étape automatique, quelques secondes à une minute).
9. **Lancement du coin** : le client signe **une** transaction qui crée `$MOON` et fait son premier achat (montant choisi dans le chat, payé par lui, il reçoit ses `$MOON`). Expliquer clairement ce qu'il signe et combien.
10. **En ligne** : le site passe en production sur `moonpad.forgepads.xyz`. Écran de réussite avec le lien.

**Échec** : si la construction échoue, FORGE réessaie automatiquement une fois. Après deux échecs, le paiement est **remboursé automatiquement** (afficher l'état « Remboursé » avec le lien de la transaction). Si l'échec arrive après la validation, l'équipe est prévenue et s'en occupe : afficher « Notre équipe s'en occupe » (pas de remboursement automatique).

## Parcours 2 — Modification (site FORGE)

Depuis le tableau de bord : « Demander une modif » → nouvelle vérification $FORGE → chat (on décrit le changement) → paiement si plus de modif incluse (2 incluses, puis 5,50 $) → construction → aperçu → validation → mise en ligne. Les réglages on-chain (frais, destinataire) **ne peuvent pas changer** : le dire clairement si le client le demande.

## Parcours 3 — Revenus (tableau de bord)

Le client voit, par launchpad : statut, nombre de coins, frais partenaire disponibles à réclamer (en SOL), bouton « Réclamer » (une transaction à signer), modifs restantes, historique des versions.

## Parcours 4 — Site client (template)

- **Accueil** : liste des coins (nouveaux, bientôt gradués, gradués), recherche.
- **Page d'un coin** : graphique, panneau d'achat/vente, progression de la courbe, holders, transactions.
- **Avant graduation**, le panneau d'achat affiche le **frais plateforme de 0,3 %** et le total avant signature. **Après graduation**, c'est le module Jupiter.
- **Créer un coin** : formulaire (nom, symbole, image, description, premier achat), frais de création fixés par le launchpad affichés.
- **Mes frais créateur** : un créateur connecté voit ses coins et réclame sa part.
- Pages **veille** (launchpad inactif) et **maintenance** (launchpad désactivé).

## Chiffres affichés à l'utilisateur

| Élément | Valeur |
|---|---|
| Prix de création | 33 $ en SOL (montant SOL exact donné par le devis) |
| Modifs | 2 incluses, puis 5,50 $ chacune |
| Validité d'un devis | 120 s |
| Frais plateforme (achat avant graduation) | 0,3 % |
| Frais de trading d'un launchpad | entre 0,5 % et 2 %, choisi par le client |
| Seuil de graduation | 10 SOL |
| Mise en veille | après 30 jours sans trade |

Ces valeurs viennent du backend (`CONTRACT.md`) : ne les écris pas en dur, sauf dans les textes marketing de la page d'accueil (centralisés dans un seul fichier de contenu).

## Ton et langue

- Interface en **français** au départ, textes centralisés (un fichier par page) pour permettre l'anglais plus tard.
- Ton simple, tutoiement, phrases courtes. Jamais de jargon sans explication (« signer », « gradué », « frais partenaire » ont une infobulle).
- Toujours dire **ce que l'utilisateur va signer** et **combien ça coûte** avant d'ouvrir son wallet.
