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
  poolCreationFeeSol: { min: 0, max: 1 },         // frais de création d'un coin, fixé par le client
  migrationThresholdSol: 10,                      // imposé (robots Meteora)
} as const;

export const OPS = {
  dormantDaysBeforeSleep: 30,
  claimIntervalHours: 24,
  agentBudgetUsdPerJob: 15,
  agentTimeoutMinutes: 30,
} as const;
```

## 2. `LaunchpadSpec` — produite par le chat, consommée par le builder et le signer

```ts
import { z } from 'zod';

export const LaunchpadSpec = z.object({
  version: z.literal(1),
  ownerWallet: z.string(),                     // wallet du client, = feeClaimer des deux configs
  name: z.string().min(2).max(32),             // "MoonPad"
  slug: z.string().regex(/^[a-z0-9-]{3,32}$/), // "moonpad" -> moonpad.<domaine-clients>
  quote: z.literal('SOL'),
  tradingFeeBps: z.number().int().min(50).max(200),
  coinCreatorSharePct: z.number().int().min(0).max(50),
  poolCreationFeeSol: z.number().min(0).max(1),
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

Généré par le builder dans le repo du client. L'agent peut modifier `theme` et `content`, **jamais** `onchain`.

```json
{
  "version": 1,
  "name": "MoonPad",
  "slug": "moonpad",
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
  'queued',        // créé par apps/web
  'spec_ready',    // LaunchpadSpec validée par le client
  'paid',          // paiement confirmé on-chain
  'building',      // builder : conteneur en cours
  'preview_ready', // URL d'aperçu disponible
  'approved',      // le client a validé l'aperçu
  'onchain_setup', // signer : configs créées, transaction de lancement prête
  'awaiting_owner_signature', // le client doit signer le premier achat
  'deploying',     // mise en production Vercel
  'live',
  'failed',        // tentative échouée (voir attempts)
  'refunded',
]);
export const JobType = z.enum(['create_launchpad', 'modify_launchpad']);
```

Règles :
- `failed` avec `attempts < 2` → le builder relance automatiquement (`building`).
- `failed` avec `attempts = 2` → le signer détecte le job, rembourse le paiement depuis la caisse → `refunded`.
- Une modification suit le même chemin sans `onchain_setup` ni `awaiting_owner_signature`.

## 5. Base de données (Supabase)

```sql
create table users (
  wallet text primary key,
  created_at timestamptz default now()
);

create table launchpads (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text references users(wallet),
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
  launchpad_id uuid references launchpads(id),
  type text not null,                       -- JobType
  status text not null,                     -- JobStatus
  attempts int not null default 0,
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
  payer_wallet text not null,
  kind text not null,                       -- creation | modification
  usd_amount numeric not null,
  lamports bigint not null,
  quote_expires_at timestamptz not null,
  tx_signature text unique,
  status text not null default 'quoted',    -- quoted | confirmed | expired | refunded
  refund_signature text,
  created_at timestamptz default now()
);

create table chat_messages (
  id bigserial primary key,
  launchpad_id uuid references launchpads(id),
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

Row Level Security : un client ne lit que ses lignes (`owner_wallet` = wallet authentifié). Le builder et le signer utilisent la clé de service, uniquement sur leurs VPS.

Prise d'un job par le builder (sans doublon) :

```sql
update jobs set status = 'building', locked_by = $1, locked_at = now(), attempts = attempts + 1
where id = (
  select id from jobs where status in ('paid','approved') and (locked_at is null or locked_at < now() - interval '45 minutes')
  order by created_at limit 1 for update skip locked
) returning *;
```

## 6. API de `apps/web`

| Route | Entrée | Sortie | Notes |
|---|---|---|---|
| `POST /api/auth/nonce` | `{ wallet }` | `{ nonce }` | |
| `POST /api/auth/verify` | `{ wallet, signature }` | session | signature du message contenant le nonce |
| `GET /api/gating` | session | `{ ok, required, balance }` | quantité `FORGE_GATING_AMOUNT` du mint `FORGE_MINT` |
| `POST /api/chat` | `{ launchpadId?, message }` | flux de texte | phase de conception, produit une `LaunchpadSpec` |
| `POST /api/spec/confirm` | `{ launchpadId, spec }` | `{ jobId }` | validation zod + bornes |
| `POST /api/payments/quote` | `{ jobId, kind }` | `{ paymentId, lamports, expiresAt, transaction }` | transaction de paiement non signée, prix en dollars converti au cours du moment |
| `POST /api/payments/confirm` | `{ paymentId, signature }` | `{ status }` | vérifie on-chain : montant, destinataire = caisse, signataire = wallet de la session |
| `POST /api/jobs/:id/approve` | session | `{ status }` | le client valide l'aperçu |
| `GET /api/jobs/:id/owner-transaction` | session | `{ transaction }` | transaction de lancement partiellement signée par FORGE, à signer par le client |
| `POST /api/jobs/:id/owner-transaction` | `{ signedTransaction }` | `{ signature }` | envoi on-chain |
| `GET /api/launchpads/:id/claim-transaction` | session | `{ transaction }` | réclamation des frais partenaire du client |
| `POST /api/rpc` | requête JSON-RPC | réponse | relais Helius, liste blanche de méthodes, limite de débit par IP |

## 7. API interne builder → signer

HTTP sur le réseau privé ; chaque requête porte un en-tête `X-Forge-Signature` = HMAC-SHA256 du corps avec `SIGNER_HMAC_SECRET`, plus un horodatage (rejet au-delà de 60 s).

| Route | Entrée | Sortie | Contrôles du signer |
|---|---|---|---|
| `POST /v1/configs` | `{ jobId }` | `{ launchpadConfig, launchpadCoinConfig }` | relit le job et la spec dans Supabase, paiement `confirmed`, validation des bornes |
| `POST /v1/launch-coin/prepare` | `{ jobId }` | `{ partiallySignedTx, mint }` | crée un wallet créateur dédié, signe en tant que créateur, le client signera en tant qu'acheteur. Transaction construite avec un **nonce durable** pour ne pas expirer pendant que le client signe. Le builder l'écrit dans `jobs.owner_tx` |
| `GET /v1/health` | — | `{ ok }` | |

Le signer ne prend jamais d'adresse ou de montant venant de la requête : il relit tout dans Supabase.

## 8. Variables d'environnement

| Variable | web | template | builder | signer |
|---|---|---|---|---|
| `SOLANA_CLUSTER` | ✓ | ✓ | ✓ | ✓ |
| `RPC_URL` (Helius) | ✓ (serveur) | ✓ (serveur) | | ✓ |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | ✓ | | | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ (serveur) | | ✓ | ✓ |
| `ANTHROPIC_API_KEY` | ✓ (chat de conception) | | ✓ (passerelle seulement) | |
| `FORGE_MINT`, `FORGE_GATING_AMOUNT` | ✓ | | | |
| `FORGE_CASHBOX_WALLET` (caisse) | ✓ | | | |
| `FORGE_MULTISIG_VAULT` | | ✓ (via core) | | ✓ |
| `FORGE_METEORA_REFERRAL_ACCOUNT` | | ✓ (via core) | | |
| `FORGE_PLATFORM_FEE_WALLET` | | ✓ (via core) | | |
| `FORGE_JUPITER_REFERRAL_ACCOUNT` | | ✓ | | |
| `JUPITER_API_KEY` | ✓ | ✓ | | ✓ |
| `R2_*` | ✓ | ✓ | | |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ORG` | | | ✓ | |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | | | ✓ | |
| `SIGNER_URL`, `SIGNER_HMAC_SECRET` | | | ✓ | ✓ |
| `SIGNER_KEYSTORE_PASSPHRASE` | | | | ✓ |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | | ✓ | ✓ |

**Caisse** : `FORGE_CASHBOX_WALLET` est un wallet détenu par le signer. Il reçoit les paiements, garde un petit tampon pour les remboursements et les frais de transaction, et le reste est transféré chaque jour vers le multisig. `apps/web` ne détient aucune clé : les remboursements sont faits par le signer, qui surveille les jobs `failed` avec `attempts = 2`.
