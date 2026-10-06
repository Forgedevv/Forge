# INTERFACES — contrats entre agents

Ce fichier définit tout ce que les agents partagent. La session lead le traduit en code dans `packages/shared` **avant** de lancer les autres agents. Personne d'autre ne modifie ces contrats : un changement passe par `docs/CHANGE_REQUESTS.md`.

## 1. Constantes métier (`packages/shared/src/constants.ts`)

```ts
export const PRICING = {
  creationUsd: 33,
  modificationUsd: 5.5,
  includedModifications: 2,
  maxAttemptsBeforeRefund: 2,
  quoteValiditySeconds: 120,
} as const;

export const FEES = {
  platformFeeBps: 30,          // notre frais sur notre bouton d'achat
  jupiterIntegratorFeeBps: 30, // après graduation, Jupiter en garde 20 %
  forgeCreatorSharePct: 25,    // part créateur FORGE sur le coin de chaque launchpad
} as const;

export const CLIENT_BOUNDS = {
  tradingFeeBps: { min: 50, max: 200 },          // ce qu'on propose aux clients
  coinCreatorSharePct: { min: 0, max: 50, default: 25 },
  // frais de création d'un coin, fixé par le client : 0 (pas de frais) ou entre 0,001 et 1 SOL
  // (0,001 SOL = MIN_POOL_CREATION_FEE du SDK). Que le SDK accepte 0 est à confirmer au test 1 ;
  // sinon le minimum devient 0,001.
  poolCreationFeeSol: { min: 0.001, max: 1, allowZero: true },
  migrationThresholdSol: 10,                      // imposé (robots Meteora)
} as const;

export const OPS = {
  dormantDaysBeforeSleep: 30,
  claimIntervalHours: 24,
  agentBudgetUsdPerJob: 15,
  agentTimeoutMinutes: 30,
  jobLockStaleMinutes: 45,     // au-delà, un job actif sans nouvelles est considéré planté
} as const;
```

## 2. `LaunchpadSpec` — produite par le chat, consommée par le builder et le signer

```ts
import { z } from 'zod';

const SolanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const LaunchpadSpec = z.object({
  version: z.literal(1),
  ownerWallet: SolanaAddress,                  // wallet du client = wallet de la session = payeur = feeClaimer des deux configs
  name: z.string().min(2).max(32),             // "MoonPad"
  slug: z.string().regex(/^[a-z0-9-]{3,32}$/), // "moonpad" -> moonpad.<domaine-clients>
  quote: z.literal('SOL'),
  tradingFeeBps: z.number().int().min(50).max(200),
  coinCreatorSharePct: z.number().int().min(0).max(50).default(25),
  poolCreationFeeSol: z.number().refine(v => v === 0 || (v >= 0.001 && v <= 1), {
    message: 'poolCreationFeeSol doit valoir 0 ou être entre 0,001 et 1 SOL',
  }),
  antiSniper: z.boolean().default(true),
  theme: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    darkMode: z.boolean(),
    tagline: z.string().max(120),
    logoUrl: z.string().url().optional(),
    designNotes: z.string().max(2000),         // instructions libres pour l'agent builder
  }),
  launchpadCoin: z.object({
    name: z.string().min(1).max(32),
    symbol: z.string().regex(/^[A-Z0-9]{2,10}$/),
    description: z.string().max(500),
    imageUrl: z.string().url(),
    firstBuySol: z.number().min(0).max(100),   // payé par le client
  }),
});
export type LaunchpadSpec = z.infer<typeof LaunchpadSpec>;
```

## 3. `forge.config.json` — lu par chaque site client

Généré par le builder dans le repo du client. L'agent peut modifier `theme` et `content`, **jamais** `onchain` ni `mode`. `mode` : `live` | `sleeping` (mise en veille) | `disabled` (coupé par FORGE), écrit uniquement par le builder.

```json
{
  "version": 1,
  "name": "MoonPad",
  "slug": "moonpad",
  "mode": "live",
  "onchain": {
    "cluster": "mainnet-beta",
    "launchpadConfig": "<adresse config du launchpad>",
    "launchpadCoinConfig": "<adresse config du coin du launchpad>",
    "launchpadCoinMint": "<mint de $MOON>",
    "ownerWallet": "<wallet d'Hugo>"
  },
  "theme": { "primaryColor": "#7C3AED", "accentColor": "#F59E0B", "darkMode": true },
  "content": { "tagline": "...", "about": "..." }
}
```

Les adresses FORGE (multisig, référence Meteora, référence Jupiter, wallet des frais plateforme) ne sont **pas** dans ce fichier : elles sont dans `@forge/core`, lues depuis l'environnement de build.

## 4. Statuts de job

```ts
export const JobStatus = z.enum([
  'spec_ready',    // créé par apps/web : spec confirmée (création) ou demande de modif enregistrée
  'paid',          // paiement confirmé on-chain
  'building',      // builder : conteneur en cours
  'preview_ready', // URL d'aperçu disponible
  'approved',      // le client a validé l'aperçu
  'onchain_setup', // builder + signer : création des configs et préparation de la transaction de lancement
  'awaiting_owner_signature', // transaction prête dans jobs.owner_tx, le client doit signer le premier achat
  'owner_signed',  // apps/web : transaction du client confirmée on-chain
  'deploying',     // builder : merge sur main, mise en production Vercel
  'live',
  'failed',        // étape échouée (voir failed_stage et attempts)
  'refunded',
]);
export const JobType = z.enum(['create_launchpad', 'modify_launchpad']);
export const FailedStage = z.enum(['build', 'onchain', 'deploy']);
```

Chemins :

```
création : spec_ready → paid → building → preview_ready → approved → onchain_setup
           → awaiting_owner_signature → owner_signed → deploying → live
modif    : spec_ready → paid → building → preview_ready → approved → deploying → live
```

Qui fait quoi :

| Transition | Fait par |
|---|---|
| → `spec_ready`, → `paid`, → `approved`, → `owner_signed` | `apps/web` |
| → `building`, → `preview_ready`, → `onchain_setup`, → `awaiting_owner_signature`, → `deploying`, → `live`, → `failed` | `apps/builder` |
| → `refunded` | `apps/signer` |

Règles d'échec :
- Le builder note l'étape qui a échoué dans `failed_stage`.
- **`failed_stage = 'build'`** (avant toute action on-chain) :
  - `attempts < 2` : le builder relance automatiquement (`building`) ;
  - `attempts = 2` : le signer rembourse le paiement depuis la caisse → `refunded`.
- **`failed_stage = 'onchain'` ou `'deploy'`** (après validation, des configs ont pu être créées et du SOL dépensé) : **pas de relance ni de remboursement automatiques**. Alerte Telegram, traitement manuel par l'équipe. Pour relancer, l'équipe remet le job en `approved` (les routes du signer sont idempotentes, rien n'est créé en double).
- `attempts` ne compte que les tentatives de construction (`building`).

## 5. Base de données (Supabase)

```sql
create table users (
  wallet text primary key,
  created_at timestamptz default now()
);

create table launchpads (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null references users(wallet),
  slug text unique not null,
  spec jsonb not null,                      -- LaunchpadSpec
  github_repo text,
  vercel_project_id text,
  launchpad_config text,                    -- adresse Meteora
  launchpad_coin_config text,
  launchpad_coin_mint text,
  creator_wallet_ref text,                  -- identifiant du wallet créateur dans le signer (jamais la clé)
  included_modifications_left int default 2,
  status text not null default 'draft',     -- draft | live | sleeping | disabled
  last_trade_at timestamptz,
  created_at timestamptz default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  launchpad_id uuid not null references launchpads(id),
  type text not null,                       -- JobType
  status text not null,                     -- JobStatus
  attempts int not null default 0,          -- tentatives de construction uniquement
  failed_stage text,                        -- FailedStage, renseigné quand status = 'failed'
  request text,                             -- demande du client (modifs)
  preview_url text,
  owner_tx text,                            -- transaction de lancement partiellement signée (base64), avec nonce durable
  error text,
  api_cost_usd numeric default 0,
  locked_by text,                           -- id du worker qui a pris le job
  locked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id),
  payer_wallet text not null,               -- = launchpads.owner_wallet
  kind text not null,                       -- creation | modification
  usd_amount numeric not null,
  lamports bigint not null,
  quote_expires_at timestamptz not null,
  tx_signature text unique,
  status text not null default 'quoted',    -- quoted | confirmed | expired | refunded
  refund_signature text,
  created_at timestamptz default now()
);

-- Le chat commence avant que le launchpad existe : les messages sont rattachés à une conversation.
create table conversations (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null references users(wallet),
  launchpad_id uuid references launchpads(id), -- null pendant la conception, renseigné à la confirmation de la spec
  created_at timestamptz default now()
);

create table chat_messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id),
  role text not null,                       -- user | assistant | system
  content text not null,
  created_at timestamptz default now()
);

create table job_events (
  id bigserial primary key,
  job_id uuid references jobs(id),
  message text not null,                    -- affiché dans le chat en temps réel
  created_at timestamptz default now()
);

create table flags (                        -- coupe-circuits
  key text primary key,                     -- deploys_paused | buyback_paused | signups_paused
  value boolean not null default false
);
```

Row Level Security : un client ne lit que ses lignes (`owner_wallet` = wallet authentifié ; pour `jobs`, `payments`, `job_events` et `chat_messages`, via la jointure vers `launchpads` ou `conversations`). Le builder et le signer utilisent la clé de service, uniquement sur leurs VPS.

Verrous : le builder pose `locked_by` / `locked_at` quand il prend un job, et les **remet à `null`** dès que le job quitte un statut actif (`building`, `onchain_setup`, `deploying`), y compris vers `failed`.

Prise d'un job par le builder (sans doublon) — deux requêtes :

```sql
-- 1. Construction (création et modif) : nouveau job payé, ou relance après échec de construction
update jobs set status = 'building', locked_by = $1, locked_at = now(),
  attempts = attempts + 1, failed_stage = null, error = null
where id = (
  select id from jobs
  where (status = 'paid' or (status = 'failed' and failed_stage = 'build' and attempts < 2))
    and locked_at is null
  order by created_at limit 1 for update skip locked
) returning *;

-- 2. Après validation : approved (création → onchain_setup, modif → deploying) ou owner_signed (→ deploying)
update jobs set
  status = case
    when status = 'approved' and type = 'create_launchpad' then 'onchain_setup'
    else 'deploying'
  end,
  locked_by = $1, locked_at = now()
where id = (
  select id from jobs
  where status in ('approved', 'owner_signed') and locked_at is null
  order by created_at limit 1 for update skip locked
) returning *;
```

Job planté : un job resté dans un statut actif avec `locked_at` plus vieux que `OPS.jobLockStaleMinutes` est passé en `failed` par le builder, avec `failed_stage` selon le statut (`building` → `build`, `onchain_setup` → `onchain`, `deploying` → `deploy`), verrou remis à `null`, alerte Telegram.

## 6. API de `apps/web`

| Route | Entrée | Sortie | Notes |
|---|---|---|---|
| `POST /api/auth/nonce` | `{ wallet }` | `{ nonce }` | |
| `POST /api/auth/verify` | `{ wallet, signature }` | session | signature du message contenant le nonce |
| `GET /api/gating` | session | `{ ok, required, balance }` | quantité `FORGE_GATING_AMOUNT` du mint `FORGE_MINT` ; si `FORGE_MINT` est absent (avant le lancement de $FORGE), le gating est désactivé et renvoie `ok: true` |
| `POST /api/chat` | `{ conversationId?, launchpadId?, message }` | `{ conversationId }` + flux de texte | phase de conception, produit une `LaunchpadSpec`. Sans `conversationId`, crée une conversation (rattachée à `launchpadId` s'il s'agit d'une modif) |
| `POST /api/spec/confirm` | `{ conversationId, spec }` | `{ launchpadId, jobId }` | validation zod + bornes ; refuse si `spec.ownerWallet` ≠ wallet de la session ; crée le launchpad (`draft`), le rattache à la conversation, crée le job `create_launchpad` en `spec_ready` |
| `POST /api/launchpads/:id/modifications` | `{ conversationId, request }` | `{ jobId }` | session = propriétaire ; crée le job `modify_launchpad` en `spec_ready` |
| `POST /api/payments/quote` | `{ jobId, kind }` | `{ paymentId, lamports, expiresAt, transaction }` | transaction de paiement non signée, prix en dollars converti au cours du moment. `lamports = 0` si une modif incluse reste (le job passe directement en `paid`) |
| `POST /api/payments/confirm` | `{ paymentId, signature }` | `{ status }` | vérifie on-chain : montant ≥ devis, destinataire = caisse, signataire = wallet de la session **= `launchpads.owner_wallet`**, devis non expiré, signature jamais utilisée. Passe le job en `paid` |
| `POST /api/jobs/:id/approve` | session | `{ status }` | le client valide l'aperçu → `approved` |
| `GET /api/jobs/:id/owner-transaction` | session | `{ transaction }` | transaction de lancement partiellement signée par FORGE, à signer par le client |
| `POST /api/jobs/:id/owner-transaction` | `{ signedTransaction }` | `{ signature }` | envoi on-chain, puis `owner_signed` une fois la transaction confirmée |
| `GET /api/launchpads/:id/claim-transaction` | session | `{ transaction }` | réclamation des frais partenaire du client |
| `POST /api/rpc` | requête JSON-RPC | réponse | relais Helius, liste blanche de méthodes, limite de débit par IP |

### Client navigateur de `apps/web`

Les écrans (agent 6) n'appellent pas ces routes directement : ils passent par `apps/web/src/client/` (agent 3), dont les types et signatures sont définis dans `docs/frontend/CONTRACT.md`. La session lead les traduit dans `packages/shared/src/web-client.ts` en phase 0.

## 7. API interne builder → signer

HTTP sur le réseau privé ; chaque requête porte un en-tête `X-Forge-Signature` = HMAC-SHA256 du corps avec `SIGNER_HMAC_SECRET`, plus un horodatage (rejet au-delà de 60 s).

| Route | Entrée | Sortie | Contrôles du signer |
|---|---|---|---|
| `POST /v1/configs` | `{ jobId }` | `{ launchpadConfig, launchpadCoinConfig }` | relit le job et la spec dans Supabase, job en `onchain_setup`, paiement `confirmed`, validation des bornes |
| `POST /v1/launch-coin/prepare` | `{ jobId }` | `{ partiallySignedTx, mint }` | crée un wallet créateur dédié, signe en tant que créateur, le client signera en tant qu'acheteur. Transaction construite avec un **nonce durable** pour ne pas expirer pendant que le client signe. Le builder l'écrit dans `jobs.owner_tx` |
| `GET /v1/health` | — | `{ ok }` | |

Le signer ne prend jamais d'adresse ou de montant venant de la requête : il relit tout dans Supabase. Les deux routes sont idempotentes.

## 8. Variables d'environnement

`packages/core/src/addresses.ts` n'exige pas toutes les adresses au chargement : chaque app appelle au démarrage `requireAddresses([...])` avec la liste de celles qu'elle utilise (colonnes ci-dessous) et plante si l'une manque ou est invalide. `FORGE_MINT` est la seule adresse optionnelle (absente avant le lancement de $FORGE : gating désactivé, buyback en simulation) ; si elle est présente, `FORGE_GATING_AMOUNT` est obligatoire côté web.

| Variable | web | template | builder | signer |
|---|---|---|---|---|
| `SOLANA_CLUSTER` | ✓ | ✓ | ✓ | ✓ |
| `RPC_URL` (Helius) | ✓ (serveur) | ✓ (serveur) | | ✓ |
| `SUPABASE_URL` | ✓ | | ✓ | ✓ |
| `SUPABASE_ANON_KEY` | ✓ | | | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ (serveur) | | ✓ | ✓ |
| `ANTHROPIC_API_KEY` | ✓ (chat de conception) | | ✓ (passerelle seulement) | |
| `FORGE_MINT` (optionnel) | ✓ | | | ✓ (buyback) |
| `FORGE_GATING_AMOUNT` | ✓ | | | |
| `FORGE_CASHBOX_WALLET` (caisse) | ✓ | | | ✓ |
| `FORGE_MULTISIG_VAULT` | | ✓ (via core) | ✓ (injecté dans Vercel) | ✓ |
| `FORGE_METEORA_REFERRAL_ACCOUNT` | | ✓ (via core) | ✓ (injecté dans Vercel) | |
| `FORGE_PLATFORM_FEE_WALLET` | | ✓ (via core) | ✓ (injecté dans Vercel) | |
| `FORGE_JUPITER_REFERRAL_ACCOUNT` | | ✓ (via core) | ✓ (injecté dans Vercel) | ✓ (conversion des frais) |
| `JUPITER_API_KEY` | ✓ | ✓ | ✓ (injecté dans Vercel) | ✓ |
| `R2_*` | ✓ | ✓ | ✓ (injecté dans Vercel) | |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ORG` | | | ✓ | |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | | | ✓ | |
| `SIGNER_URL`, `SIGNER_HMAC_SECRET` | | | ✓ | ✓ |
| `SIGNER_KEYSTORE_PASSPHRASE` | | | | ✓ |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | | ✓ | ✓ |

« Injecté dans Vercel » : le builder ne s'en sert pas lui-même, il copie la valeur dans les variables d'env du projet Vercel de chaque client.

**Caisse** : `FORGE_CASHBOX_WALLET` est un wallet détenu par le signer (sa clé est dans le keystore, l'adresse publique dans l'env). Il reçoit les paiements, garde un petit tampon pour les remboursements et les frais de transaction, et le reste est transféré chaque jour vers le multisig. `apps/web` ne détient aucune clé : les remboursements sont faits par le signer, qui surveille les jobs `failed` avec `failed_stage = 'build'` et `attempts = 2`.
