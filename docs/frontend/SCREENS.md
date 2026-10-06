# SCREENS — tous les écrans et leurs états

Pour chaque écran : route, données (voir `CONTRACT.md`), actions, états. « Global » s'applique partout.

## Global (les deux sites)

- **Chargement** : squelettes, jamais d'écran blanc.
- **Erreur réseau** : message clair + bouton « Réessayer ».
- **Wallet non connecté** sur une page qui en a besoin : invitation à connecter.
- **Transaction en cours** : 3 phases visibles — « Signe dans ton wallet » → « Envoi… » → « Confirmé » (avec lien vers l'explorateur) ; refus de signature par l'utilisateur = message neutre, pas une erreur.
- **Toasts** pour les confirmations courtes.
- Adresse raccourcie (`7xKX…9fQa`) avec bouton copier.
- Montants : SOL avec 2 à 4 décimales selon la taille, équivalent en dollars en gris quand il est fourni.

---

## A. Site FORGE (`apps/web`)

### A1. Accueil — `/`
- Contenu : promesse, « comment ça marche » en 4 étapes, prix (33 $, 2 modifs incluses), exemple de launchpad, FAQ courte, pied de page (CGU, FAQ).
- Actions : « Connecter mon wallet » ; si connecté : « Créer mon launchpad » et « Mon tableau de bord ».
- États : normal ; **inscriptions en pause** (`flags.signupsPaused`) → bandeau « Les créations sont en pause, réessaie plus tard », bouton de création désactivé.

### A2. Connexion — modale globale
- Choix du wallet → signature du message de connexion.
- États : choix ; attente de signature ; signature refusée ; erreur ; connecté (avatar/adresse dans l'en-tête, menu : tableau de bord, déconnexion).

### A3. Vérification $FORGE — `/new` (avant le chat) et avant chaque modif
- Données : `gating` (`ok`, `required`, `balance`).
- États : vérification en cours ; **ok** → on continue ; **insuffisant** → écran bloquant : requis vs solde, explication (« rien n'est dépensé »), lien pour obtenir des $FORGE, bouton « Revérifier ».

### A4. Chat de conception — `/new` et `/launchpads/[id]/modify`
- Mise en page : fil de discussion + panneau latéral (ou tiroir sur mobile) **« Récapitulatif »** qui se remplit au fil de la conversation.
- Messages de l'assistant en flux (mot à mot), indicateur « l'agent écrit… ».
- Carte récapitulative (création) : nom, adresse du site (`slug`), frais de trading (%), part des créateurs de coins (%), frais de création d'un coin (SOL), anti-sniper oui/non, couleurs (pastilles), mode sombre, slogan, coin du launchpad (nom, symbole, image, description, premier achat en SOL), wallet qui recevra les frais. Chaque champ invalide est signalé.
- Actions : envoyer un message ; « Confirmer et passer au paiement » (actif seulement si la spec est complète et valide).
- Modif : la carte montre la demande résumée et « modifs incluses restantes : N ».
- États : vide (message d'accueil de l'agent) ; conversation ; spec incomplète ; spec prête ; envoi de la confirmation ; erreur ; **limite de messages atteinte** (« attends un peu »).

### A5. Paiement — `/jobs/[id]/pay`
- Données : `quote` (`lamports`, `usdAmount`, `expiresAt`), `kind` (création / modif).
- Affichage : montant en SOL (gros), équivalent dollars, ce que ça inclut, **compte à rebours** jusqu'à `expiresAt`.
- Actions : « Payer » (signe et envoie via le client) ; « Nouveau devis ».
- États : devis en cours ; **devis prêt** ; signature ; confirmation on-chain ; **payé** → redirection suivi ; **devis expiré** ; paiement refusé par la vérification (message + support) ; **modif incluse** (montant 0 : pas de paiement, bouton « Continuer »).

### A6. Suivi du job — `/jobs/[id]`
- Données : `job` (statut, `previewUrl`, `error`, `failedStage`, `attempts`), `jobEvents` en temps réel.
- **Fil d'étapes** (création) : Payé → Construction → Aperçu prêt → Validé → Branchement Meteora → Signature du lancement → Mise en ligne → En ligne. Modif : Payé → Construction → Aperçu prêt → Validé → Mise en ligne → En ligne.
- Sous le fil : journal des messages (`jobEvents`), le plus récent en bas, `aria-live`.
- États par statut (libellés dans `CONTRACT.md`) :
  - `spec_ready` → bouton vers le paiement ;
  - `paid`, `building` → « Construction en cours », tentative N/2 si `attempts = 2` ;
  - `preview_ready` → bloc **Aperçu** (lien + cadre intégré si possible) + bouton « Valider l'aperçu » + « Demander un changement » (retour au chat, compte comme une modif) ;
  - `approved`, `onchain_setup` → « Branchement sur Meteora » ;
  - `awaiting_owner_signature` → renvoi vers A7 ;
  - `owner_signed`, `deploying` → « Mise en ligne » ;
  - `live` → **réussite** : lien du site, bouton tableau de bord, partage ;
  - `failed` + `failedStage = build` + `attempts < 2` → « On réessaie automatiquement » ;
  - `failed` + `failedStage` `onchain` ou `deploy` → « Un problème est survenu, notre équipe est prévenue et s'en occupe » ;
  - `refunded` → « Remboursé » + montant + lien de la transaction de remboursement.

### A7. Lancement du coin — `/jobs/[id]/launch`
- Données : `ownerTransactionSummary` (nom/symbole du coin, premier achat en SOL, frais réseau estimés).
- Explication : « Cette transaction crée $MOON et achète X SOL de $MOON pour toi. Tu reçois les tokens dans ce wallet. »
- Actions : « Signer et lancer ».
- États : préparation ; prêt ; signature ; envoi ; **confirmé** → retour au suivi ; échec d'envoi (« Réessayer », la transaction reste valable) ; **mauvais wallet connecté** (doit être le wallet propriétaire : afficher lequel).

### A8. Tableau de bord — `/dashboard`
- Données : `launchpads[]`.
- Carte par launchpad : nom, lien du site, badge de statut (`draft` brouillon, `live` en ligne, `sleeping` en veille, `disabled` désactivé), coin du launchpad, nombre de coins, **frais partenaire à réclamer** (SOL), modifs restantes, job en cours éventuel (lien vers son suivi).
- Actions : « Réclamer mes frais » (transaction à signer) ; « Demander une modif » ; « Voir » (A9) ; « Réactiver » si en veille.
- États : aucun launchpad (état vide avec bouton « Créer mon launchpad ») ; liste ; réclamation en cours / réussie ; rien à réclamer (bouton désactivé).

### A9. Détail d'un launchpad — `/launchpads/[id]`
- Réglages on-chain en lecture seule (frais, parts, adresses des configs et du coin), historique des versions (date, demande, lien d'aperçu), historique des jobs, frais réclamés.
- Mention : « Les réglages on-chain sont définitifs. »

### A10. FAQ — `/faq` et CGU — `/terms`
- FAQ : comment réclamer ses frais, pourquoi mon coin n'apparaît pas encore, que faire si la création échoue, ce qu'il se passe en veille. CGU : texte provisoire.

### A11. Hors production — `/dev/states`
- Galerie de tous les écrans dans tous leurs états avec les mocks. Inaccessible en production.

---

## B. Site client (`apps/launchpad-template`) — design de base

Tout est piloté par le thème (`forge.config.json#theme` → variables CSS). Les composants de `src/forge/` (panneau d'achat, création de coin, réclamation) sont **placés** par toi mais **pas modifiés** : tu ne fais que leur donner de la place et les habiller via les variables CSS qu'ils exposent.

### B1. Accueil — `/`
- En-tête : logo/nom du launchpad, slogan (`content.tagline`), connexion wallet, « Créer un coin ».
- Mise en avant du coin du launchpad (`$MOON`).
- Listes : nouveaux, bientôt gradués (barre de progression vers 10 SOL), gradués ; recherche.
- États : chargement ; liste vide (« Sois le premier à lancer un coin ») ; **données indisponibles** (le site bascule sur une lecture on-chain plus lente : afficher un bandeau discret).

### B2. Page d'un coin — `/coin/[mint]`
- Image, nom, symbole, créateur, description, graphique, progression de la courbe, holders, transactions.
- Emplacement du **panneau d'achat/vente** (`TradePanel` de `src/forge`) : il affiche lui-même le frais de 0,3 % et le total ; prévoir sa place en colonne droite (bureau) ou en bas fixe (mobile).
- États : sur la courbe ; **gradué** (badge, le panneau devient le module Jupiter) ; coin introuvable.

### B3. Créer un coin — `/create`
- Emplacement du formulaire `CreateCoin` de `src/forge` ; autour : explications, frais de création du launchpad, aperçu de la carte du coin.

### B4. Mes frais créateur — `/creator`
- Emplacement de `ClaimCreatorFees` de `src/forge` ; état non connecté ; aucun coin créé.

### B5. À propos — `/about`
- Contenu de `content.about`.

### B6. Veille — affichée quand le launchpad est en veille
- Page statique légère : nom, slogan, « Ce launchpad est en veille », lien vers le coin sur Jupiter. **Aucune donnée chargée** (pas de RPC).

### B7. Maintenance — affichée quand le launchpad est désactivé
- Page statique : « Ce site est indisponible. »

### Variables de thème à exposer (minimum)

`--color-primary`, `--color-accent`, `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-success`, `--color-danger`, `--radius`, `--font-heading`, `--font-body`. Mode sombre/clair dérivé de `theme.darkMode`. Documenter la liste dans `src/theme/README.md`.
