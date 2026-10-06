# CONTRACT — what the backend provides to the interface

The `apps/web` backend (agent 3) exposes everything the interface needs in **`apps/web/src/client/`**. You import only from there (and from `@forge/shared` for types). The lead session translates this file into types in `packages/shared/src/web-client.ts` before the start; if a signature differs, `packages/shared` is the source of truth.

As long as `src/client/` does not exist, write the same functions as mocks in `apps/web/src/ui/mocks/` and choose the implementation with `NEXT_PUBLIC_USE_MOCKS`.

## Types

```ts
// Amounts: lamports arrive as a string (serialized bigint). 1 SOL = 1_000_000_000 lamports.
type Lamports = string;

type JobStatus =
  | 'spec_ready' | 'paid' | 'building' | 'preview_ready' | 'approved'
  | 'onchain_setup' | 'awaiting_owner_signature' | 'owner_signed'
  | 'deploying' | 'live' | 'failed' | 'refunded';
type JobType = 'create_launchpad' | 'modify_launchpad';
type FailedStage = 'build' | 'onchain' | 'deploy';
type LaunchpadStatus = 'draft' | 'live' | 'sleeping' | 'disabled';

interface Session { wallet: string }

interface Gating { ok: boolean; required: string; balance: string; enabled: boolean } // enabled=false before $FORGE launches

interface Flags { signupsPaused: boolean }

interface LaunchpadSpecDraft {            // partial version during the chat; complete = LaunchpadSpec (INTERFACES.md §2)
  name?: string; slug?: string;
  tradingFeeBps?: number;                 // 50..200 (display as %: 100 bps = 1%)
  coinCreatorSharePct?: number;           // 0..50
  poolCreationFeeSol?: number;            // 0 or 0.001..1
  antiSniper?: boolean;
  theme?: { primaryColor?: string; accentColor?: string; darkMode?: boolean; tagline?: string; logoUrl?: string; designNotes?: string };
  launchpadCoin?: { name?: string; symbol?: string; description?: string; imageUrl?: string; firstBuySol?: number };
  ownerWallet?: string;
}

interface SpecValidation { complete: boolean; errors: Record<string, string> } // key = field path, e.g. "launchpadCoin.symbol"

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
  spec: LaunchpadSpecDraft;               // complete
  onchain: { launchpadConfig: string | null; launchpadCoinConfig: string | null; launchpadCoinMint: string | null };
  versions: { jobId: string; createdAt: string; request: string | null; previewUrl: string | null }[];
  jobs: Job[];
}

type TxPhase = 'idle' | 'awaiting_signature' | 'sending' | 'confirmed' | 'rejected' | 'error';
interface TxResult { phase: TxPhase; signature?: string; error?: string }
```

## Functions and hooks (`apps/web/src/client/`)

| Function | Role | Screen |
|---|---|---|
| `useSession(): { session: Session \| null; connect(): Promise<void>; disconnect(): Promise<void>; status: 'idle' \| 'signing' \| 'error' }` | wallet connection + message signing | A2 |
| `useFlags(): Flags` | kill switches | A1 |
| `useGating(): { gating: Gating \| null; loading: boolean; recheck(): Promise<void> }` | $FORGE check | A3 |
| `useChat(opts: { conversationId?: string; launchpadId?: string }): { messages: { role: 'user' \| 'assistant'; content: string }[]; send(text: string): void; streaming: boolean; spec: LaunchpadSpecDraft; validation: SpecValidation; rateLimited: boolean; conversationId: string \| null }` | streamed chat + spec that fills in | A4 |
| `confirmSpec(conversationId: string): Promise<{ launchpadId: string; jobId: string }>` | confirm the creation | A4 |
| `requestModification(launchpadId: string, conversationId: string): Promise<{ jobId: string }>` | confirm a change | A4 |
| `getQuote(jobId: string): Promise<Quote>` | new quote | A5 |
| `payQuote(quote: Quote, onPhase: (p: TxPhase) => void): Promise<TxResult>` | signs, sends, confirms the payment | A5 |
| `useJob(jobId: string): { job: Job \| null; events: JobEvent[]; loading: boolean }` | real time | A6 |
| `approvePreview(jobId: string): Promise<void>` | approve the preview | A6 |
| `getOwnerTransactionSummary(jobId: string): Promise<OwnerTransactionSummary>` | summary before signing | A7 |
| `signOwnerTransaction(jobId: string, onPhase: (p: TxPhase) => void): Promise<TxResult>` | signs and sends the launch transaction | A7 |
| `useLaunchpads(): { launchpads: LaunchpadSummary[]; loading: boolean; refresh(): void }` | dashboard | A8 |
| `useLaunchpad(id: string): { launchpad: LaunchpadDetail \| null; loading: boolean }` | detail | A9 |
| `claimPartnerFees(launchpadId: string, onPhase: (p: TxPhase) => void): Promise<TxResult>` | claim fees | A8 |
| `reactivateLaunchpad(launchpadId: string): Promise<void>` | wake from sleep mode | A8 |
| `formatSol(lamports: Lamports, opts?): string`, `formatUsd(n: number): string`, `shortAddress(a: string): string`, `explorerTxUrl(sig: string): string` | formatting (provided to keep the display consistent) | everywhere |

All functions reject with an `Error` whose `message` is readable by the user, or a `ClientError` `{ code: 'RATE_LIMITED' | 'UNAUTHORIZED' | 'GATING_REQUIRED' | 'SIGNUPS_PAUSED' | 'QUOTE_EXPIRED' | 'WRONG_WALLET' | 'NETWORK'; message: string }`.

## Status labels (to centralize in `src/ui/`)

| Status | Client label |
|---|---|
| `spec_ready` | Awaiting payment |
| `paid` | Payment received |
| `building` | Building |
| `preview_ready` | Preview ready |
| `approved` | Approved |
| `onchain_setup` | Connecting to Meteora |
| `awaiting_owner_signature` | Your turn to sign the launch |
| `owner_signed` | Launch signed |
| `deploying` | Going live |
| `live` | Live |
| `failed` | Problem (see detail depending on `failedStage`) |
| `refunded` | Refunded |

## Client site (template)

No API client on the template side for you: the components in `src/forge/` (`TradePanel`, `CreateCoin`, `ClaimCreatorFees`) connect on their own. You receive:

```ts
// read by agent 2 from forge.config.json, exposed read-only
interface SiteConfig {
  name: string; slug: string;
  theme: { primaryColor: string; accentColor: string; darkMode: boolean };
  content: { tagline: string; about: string };
  mode: 'live' | 'sleeping' | 'disabled';
}
```

and the coin lists via the existing hooks of the fun-launch scaffold (Jupiter), kept by agent 2.

## Expected mocks

In `apps/web/src/ui/mocks/`, one scenario per journey, controllable from `/dev/states`:
- a creation job that advances on its own one step every 3 s until `live`;
- a job that fails once and then succeeds; a refunded job; a job failing at `onchain`;
- a quote that expires in 10 s; rejected signature; wrong wallet;
- insufficient gating; signups paused; chat message limit;
- a chat that fills in the spec field by field;
- dashboard empty, with 1 launchpad, with 3 launchpads (including one sleeping and one disabled).
