# 00 — SETUP (Ali, à la main)

Ce que les agents ne peuvent pas faire. Compte 2 à 4 heures. Les étapes marquées **[devnet suffit]** peuvent attendre pour la partie mainnet.

Garde toutes les clés dans un gestionnaire de mots de passe. Ne les colle jamais dans une conversation avec un agent : mets-les dans les fichiers `.env` toi-même.

## 1. Code

- [ ] Créer une organisation GitHub (ex. `forge-launchpads`).
- [ ] Créer le monorepo privé `forge` et y déposer tous les fichiers `.md` de ce pack.
- [ ] Créer un repo template vide `launchpad-template` (sera rempli depuis `apps/launchpad-template`), cocher "Template repository".
- [ ] Créer une **GitHub App** dans l'organisation : permission `Contents: read & write`, installée sur l'organisation. Noter l'App ID et générer une clé privée (pour le builder).
- [ ] Créer un jeton pour publier `@forge/core` sur GitHub Packages (registre privé).

## 2. Hébergement

- [ ] Vercel : créer une équipe, offre Pro (1 membre). Créer un jeton API (pour le builder). Noter l'ID d'équipe.
- [ ] Domaines : acheter le domaine FORGE et un **domaine séparé** pour les sites clients (ex. `forgepads.xyz`). Brancher le domaine clients sur Vercel avec un wildcard `*.forgepads.xyz`.
- [ ] Hetzner : 2 VPS Ubuntu.
  - VPS 1 (builder) : 4 vCPU, 8 Go RAM, Docker installé.
  - VPS 2 (signer) : petit modèle. Pare-feu : SSH depuis ton IP uniquement, API du signer accessible uniquement depuis l'IP du VPS 1.
- [ ] Supabase : créer un projet (offre gratuite pour le dev).
- [ ] Cloudflare : créer un bucket R2 et ses clés d'accès (images des coins).

## 3. Blockchain

- [ ] Helius : compte, clé API, URL RPC devnet et mainnet.
- [ ] Jupiter : clé API sur le portail développeur. **[devnet suffit : à faire avant les tests mainnet]**
- [ ] Wallets de l'équipe (Phantom ou Ledger), un par membre du multisig.
- [ ] Multisig Squads : créer le multisig avec les membres et le seuil décidés (Q1 dans DECISIONS.md). Noter l'adresse du **vault**. Créer d'abord une version **devnet** pour les tests.
- [ ] Faux $FORGE sur devnet : l'agent 1 le crée dans ses scripts ; tu n'as rien à faire ici.
- [ ] SOL devnet : https://faucet.solana.com (connexion GitHub) quand les scripts affichent l'adresse à alimenter.
- [ ] SOL mainnet pour les tests : 0,5 à 1 SOL sur un wallet de test. **[plus tard]**

## 4. IA

- [ ] Console Anthropic : clé API dédiée au produit (pas ton abonnement), **limite de dépense mensuelle** fixée.
- [ ] Ton abonnement Claude sert uniquement à faire tourner les agents de dev.

## 5. Alertes

- [ ] Créer un bot Telegram (BotFather), l'ajouter au groupe de l'équipe, noter le token et l'ID du groupe.

## 6. Fichiers `.env`

Remplis un `.env` par app à partir des `.env.example` que les agents vont créer (liste complète dans `docs/INTERFACES.md`, section 8). Sur les VPS, mets les `.env` directement sur la machine, jamais dans git.
