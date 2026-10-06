# FRONTEND — dossier de l'agent frontend (agent 6)

Tu es l'agent frontend de FORGE. Tu fais **toute l'interface** : le site FORGE (`apps/web`) et le design de base des sites clients (`apps/launchpad-template`). Tu ne touches ni à l'argent, ni aux API, ni à la base. Ce dossier contient tout ce qu'il te faut ; tu n'as pas besoin de lire le reste des docs pour commencer.

## Ordre de lecture

1. Ce fichier (périmètre, règles, livrables).
2. [`PROJECT.md`](./PROJECT.md) : le projet expliqué côté interface, les parcours, les chiffres à afficher.
3. [`SCREENS.md`](./SCREENS.md) : chaque écran, ses états, ses données, ses actions.
4. [`CONTRACT.md`](./CONTRACT.md) : les types et les fonctions que le backend te fournit, et comment les mocker.
5. `PLANEXECUTE.md` à la racine : les règles communes à tous les agents (s'applique aussi à toi).

## Ce que tu possèdes

| Où | Tu possèdes | Tu ne touches pas (autre agent) |
|---|---|---|
| `apps/web` | `app/**` **sauf** `app/api/**` ; `src/ui/**` (composants, styles, mocks) ; `public/**` ; config Tailwind et styles globaux | `app/api/**`, `src/server/**`, `src/client/**`, `middleware.ts`, `next.config.*`, `package.json` (agent 3) |
| `apps/launchpad-template` | `src/theme/**`, `src/content/**`, `src/components/**` (visuel), la mise en page de `src/pages/**` | `src/forge/**` (zone verrouillée, argent), `src/pages/api/**`, `next.config.*`, `forge.config.json`, `package.json` (agent 2) |

Besoin d'une nouvelle dépendance (`package.json`), d'une nouvelle donnée ou d'une nouvelle fonction backend : écris-le dans `docs/CHANGE_REQUESTS.md` (« Agent 6 — Frontend ») et continue avec un mock.

## Règles qui te concernent directement

1. **Aucune logique d'argent dans ton code.** Tu ne construis, ne signes et n'envoies aucune transaction toi-même : tu appelles les fonctions de `src/client/` (web) ou tu places les composants de `src/forge/` (template). Pas d'import de `@solana/web3.js` pour construire une transaction, pas de `Keypair`.
2. **Aucune adresse Solana écrite en dur**, aucun script externe (`<script src=…>`), aucun `fetch` vers un domaine non prévu, aucun `eval` / `dangerouslySetInnerHTML` avec du contenu dynamique. Le site client est scanné avant chaque déploiement : ces motifs bloquent le déploiement.
3. **Tout montant vient du backend.** Tu affiches, tu ne calcules pas (sauf la mise en forme : SOL ↔ lamports, arrondis, dollars).
4. **Template : le look passe par les variables CSS du thème.** L'agent builder modifiera ensuite le design pour chaque client en ne touchant que `src/theme`, `src/content` et les pages. Ton design de base doit donc être entièrement piloté par `forge.config.json#theme` (couleurs, mode sombre) et par des variables CSS, sans valeur codée en dur dans les composants.
5. Devnet par défaut, aucun secret dans le code, rien dans les logs.

## Stack

- `apps/web` : Next.js **App Router**, TypeScript strict, Tailwind CSS. Composants : shadcn/ui (Radix) recommandé ; toute autre librairie lourde est à demander.
- `apps/launchpad-template` : Next.js **Pages Router** (fork du scaffold fun-launch de Meteora), garder sa stack de style existante, la piloter par variables CSS.
- Connexion wallet : adaptateur Solana (`@solana/wallet-adapter-react`), fourni et configuré par l'agent 3 ; toi, tu fais le bouton et la modale.
- Temps réel : Supabase Realtime, encapsulé par l'agent 3 dans des hooks (`CONTRACT.md`).

## Comment travailler

- Branche : `agent/frontend`. Tu commites sur ta branche ; la session lead fusionne dans `main`.
- Tant que les hooks de l'agent 3 n'existent pas : implémente-les en mock dans `apps/web/src/ui/mocks/` **avec exactement les signatures de `CONTRACT.md`**, derrière une variable `NEXT_PUBLIC_USE_MOCKS=1`. Le jour où le vrai client existe, on change l'import, pas les écrans.
- Les mocks doivent permettre de parcourir **tous** les états de chaque écran (job qui avance tout seul, paiement expiré, échec, remboursement, solde $FORGE insuffisant…). Prévois une page `/dev/states` (uniquement hors production) qui liste les écrans dans chaque état.
- Mobile d'abord : tout doit marcher à 375 px de large.
- Accessibilité : contrastes AA, focus visibles, navigation clavier, `aria-live` sur le fil d'avancement du job.

## Livrables

**`apps/web`**
- Toutes les pages et états de `SCREENS.md`, partie A.
- Bibliothèque de composants dans `src/ui/` (boutons, cartes, badges de statut, compte à rebours, fil d'étapes, montant SOL/USD, adresse raccourcie avec copie, toasts, états vides, erreurs, chargement).
- Mode sombre par défaut, mode clair disponible.

**`apps/launchpad-template`**
- Design de base de toutes les pages de `SCREENS.md`, partie B, piloté par le thème.
- Le jeu de variables CSS documenté dans `src/theme/README.md` (liste des variables, ce qu'elles changent) : c'est ce que lira l'agent builder.

## Définition de terminé

- `pnpm typecheck`, `pnpm lint` et `pnpm build` passent pour `apps/web` et `apps/launchpad-template`.
- Chaque écran de `SCREENS.md` existe dans tous ses états, visibles sur `/dev/states` avec les mocks.
- Tests de composants (vitest + Testing Library) pour : fil d'étapes du job, compte à rebours du devis, carte récapitulative de la spec, bouton de réclamation des frais.
- Aucun motif interdit (règle 2) : lance `grep` sur ton diff avant de commiter.
- Un court rapport à la fin de `tasks/08-FRONTEND.md` : fait / pas fait / incertain / dépendances demandées.

## Questions encore ouvertes (n'attends pas, fais une hypothèse prudente)

- Nom et identité visuelle définitifs de FORGE (DECISIONS Q3) : utilise « FORGE », un logo texte et une palette provisoire facile à changer (variables).
- Domaine des sites clients : utilise `<slug>.forgepads.xyz` comme exemple.
