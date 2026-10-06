# CONTRACT — ce que le backend fournit à l'interface

Le backend de `apps/web` (agent 3) expose tout ce dont l'interface a besoin dans **`apps/web/src/client/`**. Tu importes uniquement depuis là (et depuis `@forge/shared` pour les types). La session lead traduit ce fichier en types dans `packages/shared/src/web-client.ts` avant le démarrage ; si une signature diffère, c'est `packages/shared` qui fait foi.

Tant que `src/client/` n'existe pas, écris les mêmes fonctions en mock dans `apps/web/src/ui/mocks/` et choisis l'implémentation avec `NEXT_PUBLIC_USE_MOCKS`.

## Types

```ts
// Montants : les lamports arrivent en string (bigint sérialisé). 1 SOL = 1_000_000_000 lamports.
type Lamports = string;

type JobStatus =
  | 'spec_ready' | 'paid' | 'building' | 'preview_ready' | 'approved'
  | 'onchain_setup' | 'awaiting_owner_signature' | 'owner_signed'
  | 'deploying' | 'live' | 'failed' | 'refunded';
type JobType = 'create_launchpad' | 'modify_launchpad';
type FailedStage = 'build' | 'onchain' | 'deploy';
type LaunchpadStatus = 'draft' | 'live' | 'sleeping' | 'disabled';

interface Session { wallet: string }

interface Gating { ok: boolean; required: string; balance: string; enabled: boolean } // enabled=false avant le lancement de $FORGE

interface Flags { signupsPaused: boolean }

interface LaunchpadSpecDraft {            // version partielle pendant le chat ; complète = LaunchpadSpec (INTERFACES.md §2)
  name?: string; slug?: string;
  tradingFeeBps?: number;                 // 50..200 (afficher en % : 100 bps = 1 %)
  coinCreatorSharePct?: number;           // 0..50
  poolCreationFeeSol?: number;            // 0 ou 0,001..1
  antiSniper?: boolean;
  theme?: { primaryColor?: string; accentColor?: string; darkMode?: boolean; tagline?: string; logoUrl?: string; designNotes?: string };
  launchpadCoin?: { name?: string; symbol?: string; description?: string; imageUrl?: string; firstBuySol?: number };
  ownerWallet?: string;
}

interface SpecValidation { complete: boolean; errors: Record<string, string> } // clé = chemin du champ, ex. "launchpadCoin.symbol"

interface Quote { paymentId: string; kind: 'creation' | 'modification'; lamports: Lamports; usdAmount: number; expiresAt: string /* ISO */ }

interface Job {
  id: string; launchpadId: string; type: JobType; status: JobStatus;
  attempts: number; failedStage: FailedStage | null; error: string | null;
  previewUrl: string | null; createdAt: string; updatedAt: string;
  refund?: { lamports: Lamports; signature: string } | null;
}

interface JobEvent { id: number; jobId: string; message: string; createdAt: string }

interface OwnerTransactionSummary { coinName: string; coinSymbol: string; firstBuyLamports: Lamports; estimatedNetworkFeeLamports: Lamports; ownerWallet: string }

interface LaunchpadSummary {
  id: string; name: string; slug: string; siteUrl: string | null; status: LaunchpadStatus;
  coin: { name: string; symbol: string; mint: string | null; imageUrl: string };
  coinsCount: number; claimablePartnerFeesLamports: Lamports;
  includedModificationsLeft: number; activeJobId: string | null;
}

interface LaunchpadDetail extends LaunchpadSummary {
  spec: LaunchpadSpecDraft;               // complète
  onchain: { launchpadConfig: string | null; launchpadCoinConfig: string | null; launchpadCoinMint: string | null };
  versions: { jobId: string; createdAt: string; request: string | null; previewUrl: string | null }[];
  jobs: Job[];
}

type TxPhase = 'idle' | 'awaiting_signature' | 'sending' | 'confirmed' | 'rejected' | 'error';
interface TxResult { phase: TxPhase; signature?: string; error?: string }
```

## Fonctions et hooks (`apps/web/src/client/`)

| Fonction | Rôle | Écran |
|---|---|---|
| `useSession(): { session: Session \| null; connect(): Promise<void>; disconnect(): Promise<void>; status: 'idle' \| 'signing' \| 'error' }` | connexion wallet + signature du message | A2 |
| `useFlags(): Flags` | coupe-circuits | A1 |
| `useGating(): { gating: Gating \| null; loading: boolean; recheck(): Promise<void> }` | vérification $FORGE | A3 |
| `useChat(opts: { conversationId?: string; launchpadId?: string }): { messages: { role: 'user' \| 'assistant'; content: string }[]; send(text: string): void; streaming: boolean; spec: LaunchpadSpecDraft; validation: SpecValidation; rateLimited: boolean; conversationId: string \| null }` | chat en flux + spec qui se remplit | A4 |
| `confirmSpec(conversationId: string): Promise<{ launchpadId: string; jobId: string }>` | confirmer la création | A4 |
| `requestModification(launchpadId: string, conversationId: string): Promise<{ jobId: string }>` | confirmer une modif | A4 |
| `getQuote(jobId: string): Promise<Quote>` | nouveau devis | A5 |
| `payQuote(quote: Quote, onPhase: (p: TxPhase) => void): Promise<TxResult>` | signe, envoie, confirme le paiement | A5 |
| `useJob(jobId: string): { job: Job \| null; events: JobEvent[]; loading: boolean }` | temps réel | A6 |
| `approvePreview(jobId: string): Promise<void>` | valider l'aperçu | A6 |
| `getOwnerTransactionSummary(jobId: string): Promise<OwnerTransactionSummary>` | résumé avant signature | A7 |
| `signOwnerTransaction(jobId: string, onPhase: (p: TxPhase) => void): Promise<TxResult>` | signe et envoie la transaction de lancement | A7 |
| `useLaunchpads(): { launchpads: LaunchpadSummary[]; loading: boolean; refresh(): void }` | tableau de bord | A8 |
| `useLaunchpad(id: string): { launchpad: LaunchpadDetail \| null; loading: boolean }` | détail | A9 |
| `claimPartnerFees(launchpadId: string, onPhase: (p: TxPhase) => void): Promise<TxResult>` | réclamer ses frais | A8 |
| `reactivateLaunchpad(launchpadId: string): Promise<void>` | sortir de veille | A8 |
| `formatSol(lamports: Lamports, opts?): string`, `formatUsd(n: number): string`, `shortAddress(a: string): string`, `explorerTxUrl(sig: string): string` | mise en forme (fournies pour garder un affichage cohérent) | partout |

Toutes les fonctions rejettent avec une `Error` dont le `message` est lisible par l'utilisateur, ou une `ClientError` `{ code: 'RATE_LIMITED' | 'UNAUTHORIZED' | 'GATING_REQUIRED' | 'SIGNUPS_PAUSED' | 'QUOTE_EXPIRED' | 'WRONG_WALLET' | 'NETWORK'; message: string }`.

## Libellés des statuts (à centraliser dans `src/ui/`)

| Statut | Libellé client |
|---|---|
| `spec_ready` | En attente de paiement |
| `paid` | Paiement reçu |
| `building` | Construction en cours |
| `preview_ready` | Aperçu prêt |
| `approved` | Validé |
| `onchain_setup` | Branchement sur Meteora |
| `awaiting_owner_signature` | À toi de signer le lancement |
| `owner_signed` | Lancement signé |
| `deploying` | Mise en ligne |
| `live` | En ligne |
| `failed` | Problème (voir détail selon `failedStage`) |
| `refunded` | Remboursé |

## Site client (template)

Pas de client API côté template pour toi : les composants de `src/forge/` (`TradePanel`, `CreateCoin`, `ClaimCreatorFees`) se branchent seuls. Tu reçois :

```ts
// lu par l'agent 2 depuis forge.config.json, exposé en lecture seule
interface SiteConfig {
  name: string; slug: string;
  theme: { primaryColor: string; accentColor: string; darkMode: boolean };
  content: { tagline: string; about: string };
  mode: 'live' | 'sleeping' | 'disabled';
}
```

et les listes de coins via les hooks existants du scaffold fun-launch (Jupiter), conservés par l'agent 2.

## Mocks attendus

Dans `apps/web/src/ui/mocks/`, un scénario par parcours, pilotable depuis `/dev/states` :
- job de création qui avance tout seul d'une étape toutes les 3 s jusqu'à `live` ;
- job qui échoue une fois puis réussit ; job remboursé ; job en échec `onchain` ;
- devis qui expire en 10 s ; signature refusée ; mauvais wallet ;
- gating insuffisant ; inscriptions en pause ; limite de messages du chat ;
- chat qui remplit la spec champ par champ ;
- tableau de bord vide, avec 1 launchpad, avec 3 launchpads (dont un en veille et un désactivé).
