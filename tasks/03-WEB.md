# 03 — WEB (agent 3)

**Tu possèdes** : `apps/web` (`app/api/**`, `src/server/**`, `src/client/**`, `middleware.ts`, `next.config.*`, `package.json`), `supabase`. **L'interface (pages, composants, styles) appartient à l'agent 6** (frontend, voir `docs/frontend/`) : tu ne fais aucun écran.

Ton livrable côté interface est **`src/client/`** : exactement les types, fonctions et hooks de `docs/frontend/CONTRACT.md` (connexion wallet, chat en flux, devis et paiement, suivi temps réel, signature du lancement, tableau de bord, réclamation des frais). Tu configures aussi le fournisseur wallet (`@solana/wallet-adapter-react`) et Supabase côté navigateur. Commence par ce client, avec ses tests : l'agent 6 travaille sur des mocks qui ont les mêmes signatures.
**Tu lis** : `PLANEXECUTE.md`, `docs/INTERFACES.md` (tout), `docs/PRODUCT.md`, `docs/SECURITY.md` (sections 9, 10, 11), `docs/OPERATIONS.md` (flags).

Tu construis le site FORGE : là où le client parle à l'agent, paie, suit la construction, valide l'aperçu, signe le lancement de son coin et réclame ses frais. Tu ne détiens **aucune clé** de wallet FORGE.

## Base de données

- [ ] `supabase/migrations/` : schéma de `INTERFACES.md` §5, avec Row Level Security (un client ne lit que ses lignes), index sur `jobs(status, created_at)`, table `flags` initialisée.
- [ ] Realtime activé sur `jobs` et `job_events`.

## Site (Next.js App Router, Vercel)

- [ ] Connexion par wallet (adaptateur Solana) + signature d'un nonce → session (`/api/auth/*`).
- [ ] **Chat de conception** (`/api/chat`) : Claude API (modèle Sonnet), prompt système qui pose les questions nécessaires et produit une `LaunchpadSpec` valide (zod) ; reste dans les bornes de `CLIENT_BOUNDS` ; affiche un récapitulatif clair avant confirmation. Limite de débit par wallet. Messages stockés par conversation (`conversations`, `chat_messages`), le launchpad n'existant qu'à la confirmation (`/api/spec/confirm`, qui refuse si `spec.ownerWallet` ≠ wallet de la session).
- [ ] Token-gating (`/api/gating`) avant d'ouvrir le chat et avant chaque modif, via `getForgeBalance` de core. Désactivé tant que `FORGE_MINT` n'est pas défini.
- [ ] Paiement : `/api/payments/quote` (prix en dollars → lamports au cours du moment, via l'API prix de Jupiter, devis 120 s) et `/api/payments/confirm` (vérification on-chain complète, voir SECURITY.md §10). Passe le job en `paid`.
- [ ] Suivi en temps réel : page du job abonnée à `jobs` et `job_events` (Supabase Realtime), affichage des étapes et de l'URL d'aperçu.
- [ ] Validation de l'aperçu (`/api/jobs/:id/approve`).
- [ ] Signature du lancement du coin : récupérer la transaction partiellement signée (`owner-transaction`), la faire signer par le wallet du client, l'envoyer, suivre la confirmation, puis passer le job en `owner_signed`.
- [ ] Tableau de bord client : ses launchpads, statut, versions, modifs restantes, bouton "réclamer mes frais" (`buildPartnerClaimTx` de core), bouton "demander une modif".
- [ ] Quotas : `included_modifications_left` décrémenté ; au-delà, devis à 5,50 $.
- [ ] Relais RPC `/api/rpc` : liste blanche de méthodes, limite de débit par IP, taille max.
- [ ] Flag `signups_paused` respecté.
- [ ] Les pages (accueil, chat, paiement, suivi, tableau de bord, FAQ, CGU) sont faites par l'agent 6 : vérifie seulement que chaque écran de `docs/frontend/SCREENS.md` partie A a ses données dans `src/client/`.

## Tests

- [ ] Tests unitaires : validation de spec, calcul de devis, vérification de paiement (avec transactions devnet réelles en fixture).
- [ ] Test RLS : un wallet ne voit pas les launchpads d'un autre.
- [ ] Parcours complet en local contre devnet avec le faux $FORGE et des jobs simulés (le builder peut être mocké).

## Dépendances

`@forge/core` (agent 1) pour gating, paiements, claims. `packages/shared` pour les types. Le builder et le signer communiquent avec toi uniquement via Supabase.

## Rapport

_À remplir en fin de tâche._
