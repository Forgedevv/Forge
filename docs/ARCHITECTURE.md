# ARCHITECTURE

## Principe

Tout ce qui touche à l'argent est soit **figé** (`@forge/core`, à version épinglée), soit **isolé** (`apps/signer` sur sa propre machine, le multisig Squads). L'agent IA ne peut modifier que le visuel des sites clients.

## Vue d'ensemble

```
                   ┌──────────────┐          ┌──────────────────────┐
  Client (Hugo) ──►│  apps/web    │◄────────►│  Supabase            │
  navigateur       │  Vercel      │  DB +    │  Postgres + Realtime │
                   │  chat, API,  │  realtime│  jobs, paiements...  │
                   │  dashboard   │          └──────────┬───────────┘
                   └──────┬───────┘                     │ jobs
                          │ /api/rpc (relais)           ▼
                          │                  ┌──────────────────────┐
                          │                  │  apps/builder        │  VPS 1 (Hetzner)
                          │                  │  worker + Docker     │
                          │                  │  passerelle IA       │──► API Anthropic
                          │                  │  scan                │──► GitHub (repo client)
                          │                  └──────────┬───────────┘──► Vercel (déploiement)
                          │                             │ HTTP privé signé (HMAC)
                          ▼                             ▼
                   ┌──────────────┐          ┌──────────────────────┐
                   │ Helius RPC   │◄─────────│  apps/signer         │  VPS 2 (Hetzner)
                   └──────┬───────┘          │  wallets créateurs   │
                          │                  │  claims, buyback     │──► Telegram (alertes)
                          ▼                  └──────────┬───────────┘
                   ┌──────────────┐                     │
                   │ Meteora DBC  │                     ▼
                   │ (on-chain)   │          ┌──────────────────────┐
                   └──────────────┘          │  Multisig Squads     │
                                             │  revenus, $FORGE     │
                                             └──────────────────────┘

  Traders ──► site client (Vercel) ──► avant graduation : bouton FORGE → Meteora (via @forge/core)
                                   └─► après graduation : plugin Jupiter (frais intégrateur)
```

## Composants

### `packages/shared` — contrats
Types et schémas zod partagés : `LaunchpadSpec`, statuts de job, payloads d'API, constantes métier. Écrit par la session lead au démarrage. Voir `INTERFACES.md`.

### `packages/core` — noyau de transactions (verrouillé)
- Wrappers du SDK Meteora : création de config, création de pool avec premier achat, swap avec référence et frais plateforme, claims, lecture des pools d'une config.
- Validation des paramètres on-chain (bornes dans `METEORA.md`).
- Adresses FORGE lues depuis l'environnement (`addresses.ts`).
- Publié sur GitHub Packages (registre privé) à version épinglée. Les sites clients l'installent depuis ce registre ; l'agent builder ne peut ni le modifier ni changer sa version.

### `apps/web` — site FORGE (Vercel)
- Connexion par signature de wallet.
- Chat avec l'agent (phase de conception : Claude API, produit la `LaunchpadSpec`).
- Devis et vérification des paiements, token-gating, quotas, remboursements.
- Tableau de bord client : ses launchpads, versions, aperçus, bouton de réclamation de ses frais partenaire.
- File de jobs dans Supabase ; avancement en temps réel via Supabase Realtime.
- `/api/rpc` : relais vers Helius avec limite de débit (la clé Helius ne quitte jamais le serveur).

### `apps/launchpad-template` — template des sites clients
- Fork du scaffold fun-launch de Meteora Invent.
- Avant graduation : **notre bouton d'achat** (swap via `@forge/core`, avec référence + 0,3 %).
- Après graduation : plugin Jupiter avec notre compte de référence Jupiter et 30 bps.
- Page de réclamation des frais créateur pour les créateurs de coins.
- Lit sa configuration depuis un fichier `forge.config.json` (généré par l'agent) + variables d'env.
- Publié comme **repo template GitHub** ; chaque client a un repo créé depuis ce template.

### `apps/builder` — worker de l'agent (VPS 1)
- Récupère les jobs `create_launchpad` et `modify_launchpad` dans Supabase.
- Pour chaque job : conteneur Docker isolé, Claude Code en mode headless, jeton GitHub limité au repo du client, réseau limité.
- **Passerelle IA** sur la machine hôte : détient la vraie clé Anthropic, donne au conteneur un jeton temporaire à budget plafonné (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`).
- **Scan** avant chaque push : bloque toute modification du noyau, toute nouvelle adresse Solana, tout script externe, toute demande d'approbation de tokens.
- Crée les projets Vercel et récupère les URL d'aperçu.
- Demande au signer de créer les configs et de préparer la transaction de lancement du coin.

### `apps/signer` — signer et trésorerie (VPS 2, séparé)
- Seul composant qui détient des clés de FORGE : un wallet créateur par launchpad (clés chiffrées), un wallet "payeur" pour les frais de transaction, le wallet du bot de buyback.
- Crée les configs Meteora, prépare les transactions de création de pool (signature partielle), réclame les frais créateur vers le multisig, exécute le buyback.
- N'accepte que des requêtes signées (HMAC) venant du builder, et revérifie dans Supabase que le paiement du job est confirmé.
- Aucun port public entrant hormis l'API privée, accessible uniquement depuis l'IP du VPS 1.
- Alertes Telegram.

### Multisig Squads
- Reçoit : frais plateforme, référence (compte de référence détenu par le multisig), frais créateur réclamés, frais intégrateur Jupiter.
- Limite de dépense quotidienne vers le wallet du bot de buyback.
- Les $FORGE rachetés y reviennent.

## Infra

| Service | Rôle | Coût |
|---|---|---|
| Vercel Pro (1 membre) | `apps/web` + sites clients + aperçus | 20 $/mois |
| Hetzner VPS 1 | builder, Docker, passerelle IA, scan | ~10 $/mois |
| Hetzner VPS 2 | signer, buyback, alertes | ~5 $/mois |
| Supabase | base + realtime | 0 $ en dev, 25 $/mois au lancement public |
| Helius | RPC devnet + mainnet | 0 $ en dev, 49 $/mois au lancement public |
| Cloudflare R2 | images et métadonnées des coins | offre gratuite |
| GitHub (organisation) | monorepo, repo template, repos clients, registre privé | gratuit |
| Jupiter | plugin, API de données, programme de référence | clé gratuite au départ |
| Domaines | FORGE + domaine séparé des sites clients | ~30 $/an |

## Flux des jobs

```
spec_ready → paid → building → preview_ready → approved → onchain_setup → awaiting_owner_signature → owner_signed → deploying → live
                       │                                        │                                                       │
                       └─► failed (build) ─► relance si attempts < 2,            failed (onchain / deploy) : alerte + traitement manuel,
                                             remboursement si attempts = 2        pas de remboursement automatique
```

Une modification saute `onchain_setup`, `awaiting_owner_signature` et `owner_signed` : `approved → deploying → live`.

Détail des statuts et des transitions : `INTERFACES.md`.

## Environnements

| | devnet | mainnet |
|---|---|---|
| Logique on-chain (core, signer) | tests par scripts | petits montants avant ouverture |
| Interface du template | non testable (Jupiter n'indexe pas devnet) | petits montants |
| Migration | outil de migration manuelle Meteora | robots Meteora |
| $FORGE | faux token créé sur devnet | vrai token, lancé après validation |
