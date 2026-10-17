# OPERATIONS — running FORGE day to day

## Alerts (Telegram, team group)

Sent by `apps/signer` and `apps/builder` via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Both refuse to start on mainnet-beta without them (the signer also in production, `NODE_ENV` other than `development` / `test`); on devnet the builder's alerts may stay in its log.

| Alert | Source | Urgency |
|---|---|---|
| Creator role transfer on one of our pools | signer (on-chain monitoring) | immediate |
| Unexpected outflow from the multisig or the cashbox | signer | immediate |
| Payer wallet or cashbox balance too low | signer | high |
| Job failed twice, refund triggered | signer | normal |
| Deployment blocked by the scan | builder | normal (may be an abuse attempt) |
| Daily API budget exceeded at 80% | builder (gateway) | high |
| Creator fees unclaimed for more than 48 h | signer | normal |
| Creator WSOL account already holds WSOL, so a claim to a third-party payer is blocked (`creator_wsol_blocked`, once per pool): unwrap it with the creator key or let the creator pay | signer | high |
| Revenue wallet not wired (`revenue_wiring`: no `revenue` key, or `FORGE_REVENUE_WALLET`, `FORGE_PLATFORM_FEE_WALLET` or the owner of the Meteora referral account disagree with it; on mainnet-beta the signer refuses to start instead) | signer (startup) | high |
| Revenue wallet: an unexplained native outflow, a failed or refused unwrap or forward, a referral account it does not hold, or too little SOL to pay an unwrap (`revenue_*`) | signer | high |
| Revenue wallet holds a token this cluster cannot convert (`revenue_unconvertible_balance`, devnet) | signer | normal |
| Buyback budget unknown, nothing bought until fixed (`buyback_budget_unconfigured`: `BUYBACK_REVENUE_SINCE` unset; `buyback_budget_unavailable`: journal directory unreadable or a corrupt `revenue-forward.*`, `claim-receipt.*` or `buyback.day-*` entry; `buyback_budget_unplanned`: part of a day budget did not fit in the orders, impossible with a validated configuration) | signer | high |
| Repeated RPC errors | signer, builder | high |
| A released site has no verified host (`site_host_missing:<slug>`: no verified subdomain and no `*.vercel.app` alias of its own Vercel project serves the promoted deployment; browsers of that site cannot reach the relay or create coins) | builder | high |

## Kill switches (`flags` table in Supabase)

| Flag | Effect |
|---|---|
| `signups_paused` | `apps/web` refuses new creations (existing clients continue) |
| `deploys_paused` | the builder stops picking up jobs and stops production changes |
| `buyback_paused` | the buyback bot stops |
| `claims_paused` | the signer stops claiming the creator share (DBC before graduation, DAMM v2 position after) to the multisig |
| `cashbox_sweep_paused` | the signer stops moving the cashbox surplus to the multisig |
| `refunds_paused` | the signer stops automatic refunds (they wait, nothing is lost) |
| `jupiter_claims_paused` | the signer stops claiming the Jupiter referral fees to the multisig (mainnet only) |
| `convert_paused` | the signer stops converting the fees received in other currencies to SOL (dry runs included); the balances wait for the next run. Also stops the swaps of the revenue job (same machinery) |
| `revenue_paused` | the signer stops the revenue job: no unwrap, no swap, no forward of the revenue wallet to the multisig; the balances wait |
| `launchpads.status = 'disabled'` | the builder deploys the maintenance page **and pauses the Vercel project**, so the site and its old previews stop serving |

Each service rereads the flags at least every minute, and the money jobs reread their flag again right before signing. The signer's job switches (`claims_paused`, `cashbox_sweep_paused`, `refunds_paused`, `jupiter_claims_paused`, `convert_paused`, `revenue_paused`) fail closed: a missing row or an unreadable `flags` table pauses the job with a high alert (`<job>_paused_flag_missing`, `<job>_paused_flags_unavailable`), so each row must exist (migrations 0005, 0013, 0015 and 0016 seed them).

## Builder feature flags (environment, read at startup)

| Variable | Effect |
|---|---|
| `BUILDER_VISUAL_REVIEW` | `off` (default) or `on`: new sites get a second agent pass on screenshots of the built site (desktop and mobile, measured overflow report), then the same scan and build; any failure of that pass keeps the first one. Costs up to 5 USD more per job (within the job budget) and a few minutes; it is skipped when less than 20 minutes or 1 USD are left. Needs `FORGE_SANDBOX_REVIEW_IMAGE`: when it is missing the review stays off and the startup log says so. |
| `FORGE_SANDBOX_REVIEW_IMAGE` | Pinned ID of the review image (`apps/builder/docker/review.Dockerfile`, printed by `build-images.sh`). Rebuild it regularly: it carries Chromium. |

The builder logs `visual review discarded, first pass kept` with the reason (`capture_failed`, `agent_failed`, `scan_blocked`, `build_failed`, `timeout`, `budget`...) when a review does not apply; a scan block of the second pass also sends a normal alert (`review_scan_blocked`). To test site quality on a laptop: `pnpm --filter @forge/builder site-test` (apps/builder/README.md).

## Priority fees

Every transaction FORGE builds carries a priority fee read from the network (core `priority-fee.ts`): the 75th percentile of the recent fees of the accounts it writes, bounded. Without it, payments, launches and claims are dropped under congestion (a late payment becomes a manual anomaly).

| Where | Setting | Cap |
|---|---|---|
| Client sites (trades, coin creations, creator fee claims) | core defaults, fixed in the template (`src/forge/priority-fee.ts`) | 1,000,000 micro-lamports per CU, 0.0005 SOL per transaction (0.00015 SOL per swap, shown with the quote) |
| FORGE site (payments, partner fee claims) | core defaults (`PAYMENT_PRIORITY_FEE`, `CLAIM_PRIORITY_FEE`) | same |
| Signer (claims, refunds, cashbox sweeps, revenue unwrap and forward, configs, nonce accounts, launches, revocations, Jupiter referral claims, buyback $FORGE returns and spending-limit withdrawals, devnet DBC buybacks) | `SIGNER_PRIORITY_FEE_*` | `SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS` per CU (default 1,000,000), `SIGNER_PRIORITY_FEE_MAX_LAMPORTS` per transaction (default 0.0005 SOL, at most 0.001 SOL; the devnet DBC buybacks at most `BUYBACK_MAX_PRIORITY_FEE_LAMPORTS`). The buyback withdraws the return's cap in each order's fee allowance and the withdrawal's fee with the day's funding |
| Signer Jupiter swaps (conversion, buyback) | Jupiter `priorityLevelWithMaxLamports` | `CONVERT_MAX_PRIORITY_FEE_LAMPORTS`, `BUYBACK_MAX_PRIORITY_FEE_LAMPORTS` |

Mainnet: keep the defaults and set `SIGNER_PRIORITY_FEE_MICRO_LAMPORTS=10000` (a floor for quiet accounts). When transactions still land late, raise `SIGNER_PRIORITY_FEE_PERCENTILE` (90) before the caps. Devnet: the defaults cost next to nothing (devnet fees are mostly zero); `SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS=0` turns the signer's priority fees off. The signer's wallets keep the cap of a transaction on top of their fee buffers (cashbox floor, revenue forward floor, claim payer). The launchpad coin launch puts the price alone when its metadata leaves no room for both instructions, and no price at all for the longest metadata (summary `priorityFeePlacement`): it uses a durable nonce, so it stays valid until it lands.

## Automatic tasks

| Task | Frequency | Service |
|---|---|---|
| Claim the creator share of each pool to the multisig: the DBC creator fees before graduation, the fees of the permanently locked DAMM v2 position after | every hour (`SIGNER_CLAIMS_INTERVAL_HOURS`) | signer |
| Transfer the cashbox surplus to the multisig | every 24 h | signer |
| Automatic refunds (2 failed builds) | continuous | signer |
| $FORGE buyback | once per UTC day the bot plans its budget from the revenue backlog (D35: what reached the vault as trading revenue since `BUYBACK_REVENUE_SINCE`, minus what the buyback already withdrew), capped at `BUYBACK_DAILY_CAP_LAMPORTS` (5 SOL on mainnet; the rest waits for the following days), withdraws the missing SOL from the vault through its Squads spending limit, then makes several small buys at random times and returns every $FORGE to the vault. Live only on mainnet-beta with `FORGE_BUYBACK_LIVE=true`, `FORGE_MINT`, `BUYBACK_REVENUE_SINCE`, `FORGE_SQUADS_MULTISIG`, `FORGE_SQUADS_SPENDING_LIMIT` and `JUPITER_API_KEY`; simulation otherwise. A refused buyback configuration (including a cap above `BUYBACK_ORDERS_PER_DAY` x `BUYBACK_MAX_ORDER_LAMPORTS`) disables the buyback alone (alert `job_module_disabled`), except on mainnet-beta with `FORGE_BUYBACK_LIVE` set: the signer then refuses to start | signer |
| Claim the Jupiter referral fees (SOL and USDC by default, `SIGNER_JUPITER_CLAIMS_MINTS`) to the revenue wallet (the referral account's partner, D34) | every 24 h (mainnet-beta only; off on devnet) | signer |
| Convert to SOL the fees the cashbox and payer wallets received in other currencies | every 24 h (mainnet, `FORGE_CONVERT_LIVE=true`, `JUPITER_API_KEY` required then; dry run otherwise) | signer |
| Revenue wallet (D34): unwrap its wrapped SOL (Meteora referral, Jupiter claims), convert its other balances to SOL (mainnet, same settings and switch as the conversion above; skipped on devnet), forward the native SOL above the reserve to the multisig, one journal entry per forward with a breakdown by source | every 24 h (`SIGNER_REVENUE_INTERVAL_HOURS`); dry run until `SIGNER_REVENUE_DRY_RUN=false` | signer |
| Check that disabled launchpads are cut (paused on Vercel) | every 15 min | builder |
| Put launchpads with no trade for 30 days into sleep mode | every 24 h | builder |
| Sweep abandoned uploads in R2 `pending/` | every 15 min: an external scheduler sends `POST /api/internal/uploads/sweep` with `Authorization: Bearer $FORGE_INTERNAL_CRON_SECRET` (Vercel Cron sends GET, so it cannot call this route directly) | web |
| Replay the devnet tests (referral, creator share) | weekly | CI or VPS 1 |

Also set an R2 lifecycle rule that deletes objects under `pending/` after 1 day, as a backstop for the sweep.

## Manual handling

- **Payment anomalies** (late payment, wrong amount, launchpad released, duplicate payment) are recorded in the `payment_anomalies` table, never refunded automatically (D20). Check unresolved rows daily, refund from the cashbox by hand, then set `resolved_at` and a `note`. A payment counts only at the `finalized` commitment; while a job has an open quote with at least 60 s left, the web hands back that same quote instead of a new one. The row's `lamports` can be empty when the transferred amount could not be read: read it from the transaction.
- **Failure after approval** (on-chain or deployment step, D18): the job stays `failed` with an alert. Configs may already exist on-chain; check them before any retry or refund.
- **Revoke a prepared launch** (wrong spec, leaked transaction, client starting over): on the signer machine, `pnpm --filter @forge/signer exec tsx src/index.ts --revoke-launch <jobId>`. The creator wallet advances the launchpad's durable nonce, so the transaction already handed out can never land; the next prepare builds a new one. It works even when `deploys_paused` is set. To rebuild an unsigned launch, clear `jobs.owner_tx` and `jobs.owner_tx_details` in the same update (the database refuses one without the other).
- **Client site host** (`launchpads.site_host`, D30): the builder records it at every release from the Vercel API; never type one by hand from a name (look-alike `*.vercel.app` projects exist). A released `*.vercel.app` name can be claimed by anyone, and the relay and the upload route trust the recorded host, so the order matters when a client's Vercel project goes away:
  1. set `site_host` to null **before** deleting the project or removing its alias, and make sure no release of that launchpad runs in between (it would record the host again; `deploys_paused` stops every release while you work);
  2. wait at least 2 minutes: the relay may still trust the host from its directory cache that long;
  3. then delete the project (or remove the alias).
  If a project was already deleted with its host still recorded, clear `site_host` at once. Re-running the deploy step on a new project records its host again.
- **No rollback of `apps/web` below "start again" once migration 0010 is applied**: from then on a launchpad may hold several creation jobs (refunded attempts plus the new one). The `apps/web` versions before "start again" (`POST /api/launchpads/:id/retry`) assume a single creation job per launchpad and can judge a started-again launchpad by its refunded attempt (spec confirmation replay, modification quotas, coin metadata). If a release must be undone, roll forward with a fix, or roll back only to a version that already has the retry route.
- **Signer journal directory** (`SIGNER_JOURNAL_DIR`): back it up and never delete files in it. Besides the job journals it holds `refund-ledger.*` (refunds already sent, append-only), `squads.*` (spending-limit withdrawals), `revenue.state.json` and `revenue-forward.<signature>.json` (one file per revenue forward to the multisig, append-only: the buyback budget reads them, docs/INTERFACES.md "Revenue forwards"), `claim-receipt.<signature>.json` (one file per creator claim the multisig received, append-only: the buyback budget reads them too, docs/INTERFACES.md "Claim receipts"), `watch.expected.log` (every signature the signer announced before sending it, so a restart never raises a false outflow alert) and `signer.lock` (one signer at a time; a lock left by a crash or a reboot is taken over automatically).
- **Revenue wallet** (D34, `apps/signer/src/jobs/revenue.ts`). Setup: `--init-keys` creates the `revenue` keystore wallet; set `FORGE_REVENUE_WALLET` and `FORGE_PLATFORM_FEE_WALLET` to its address everywhere (signer, builder, web), create the Meteora referral account as a standalone WSOL token account owned by it (not its associated account: the Jupiter claims land there and would be booked as Meteora referral) and set `FORGE_METEORA_REFERRAL_ACCOUNT`, create the Jupiter referral account with it as partner, fund it with rent plus the reserve (0.01 SOL by default, `SIGNER_REVENUE_RESERVE_LAMPORTS`: the unwrap advances the rent of an ephemeral token account, about 0.002 SOL, and gets it back in the same transaction). On mainnet-beta the signer refuses to start until the key, the platform fee wallet and the referral account owner agree (devnet: high alert `revenue_wiring`, job off). Running: dry run by default (plans and logs); set `SIGNER_REVENUE_DRY_RUN=false` to unwrap and forward; the swaps follow the conversion settings (`FORGE_CONVERT_LIVE`, `CONVERT_*`, `convert_paused`) and only exist on mainnet. Forwards go to `FORGE_MULTISIG_VAULT` only (the signing policy refuses any other destination), from `SIGNER_REVENUE_MIN_FORWARD_LAMPORTS` (0.01 SOL). Pause: `revenue_paused` (or `SIGNER_REVENUE_PAUSED=true` and a restart). What to check: the wallet keeps about one day of revenue at most (watch `revenue_unexpected_outflow`, the watcher's outflow alerts on it, `revenue_referral_not_owned`); `revenue-forward.*.json` grows by one file per forward (signature, lamports, breakdown); after a crash the next run settles the transaction in flight before anything else, so never delete `revenue.state.json`. A `revenue_unconvertible_balance` alert on devnet is expected for any non-SOL token sent to it (nothing converts there).
- **Buyback budget** (D35, `apps/signer/src/jobs/buyback-budget.ts`). Formula, per UTC day: `budget = min(backlog + SOL already on the bot above its reserve, BUYBACK_DAILY_CAP_LAMPORTS, what the spending limit and the bot can fund)` with `backlog = revenue since BUYBACK_REVENUE_SINCE - buyback withdrawals since BUYBACK_REVENUE_SINCE`, floored at 0. Revenue = the `revenue-forward.*` files finalized at or after the instant (Meteora referral, Jupiter referral, platform fee, other) + the `claim-receipt.*` files settled at or after it whose receiver is the vault (DBC creator share, DAMM v2 position fees), counted once the ledger shows them finalized. Withdrawals = the `funding` of the `buyback.day-*` files at or after the instant (requested, confirmed and unknown ones count; failed and not-needed ones do not). Simulated orders and cashbox sweeps (client payments) count for nothing. **Go-live**: in the same restart that sets `FORGE_BUYBACK_LIVE=true`, set `BUYBACK_REVENUE_SINCE` to the go-live instant (ISO 8601 with its zone, e.g. `2026-11-01T00:00:00Z`, in the past or the restart time: nothing before it is ever bought back; the signer refuses to start without it), `BUYBACK_DAILY_CAP_LAMPORTS=5000000000` (5 SOL), `BUYBACK_ORDERS_PER_DAY=10` and `BUYBACK_MAX_ORDER_LAMPORTS=500000000` (10 orders of at most 0.5 SOL hold the cap; a cap above orders x maximum order is refused at startup), and a Squads spending limit of at least the cap plus the orders' fee allowance. The first live plan is made at the next UTC day start when a plan already exists for the current day. Never move `BUYBACK_REVENUE_SINCE` backwards once live (revenue before it was never bought: moving it back would buy it; moving it forward forgets the backlog before it). **Reading it**: the log line `buyback day planned` (job `buyback`) shows `budget`, `cap`, `backlog`, `botAvailable`, `fundable`, `unplanned` and a `revenue` block (total, by source, claims by kind, `claimsAwaitingFinality`, `spent`, `withdrawals`); the same figures are in `buyback.day-<day>.json` (`revenue`, `botAvailableLamports`, `unplannedLamports`) and in the run report (`budget`). A backlog that keeps growing while `budget` equals the cap means the revenue outpaces 5 SOL a day (expected; raise the cap and the orders together if wanted); `claimsAwaitingFinality` above 0 for more than a few minutes means a claim the ledger does not show finalized: check its signature in `claim-receipt.*`. The alert `buyback_budget_unavailable` names the problem (`JOURNAL_IO` or `JOURNAL_CORRUPT: <journal> entry ...`): fix the directory or restore the file from the backup, never delete it; the next tick plans the day.
- **Payment floors**: the signer refuses a payment below `SIGNER_MIN_CREATION_PAYMENT_LAMPORTS` / `SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS`. The defaults come from the highest SOL price a quote accepts (`SOL_USD_PRICE_MAX`, $5,000 by default) with a 10% margin: 0.00594 SOL for a creation ($33) and 0.00099 SOL for a modification ($5.5). Above $5,000 per SOL the web refuses to quote (retryable 503 `PRICE_UNAVAILABLE`). Change the bound and the floors together: lower the floors before raising `SOL_USD_PRICE_MAX` (a quote below a floor is a legitimate payment the signer would refuse), and raise them only after lowering it.
- **Price reference**: the web keeps the last accepted SOL/USD rate in the `price_references` table, so a new server instance still refuses a rate that moved too far. An anomaly whose transaction later pays another quote is resolved automatically, with a note.
- **Web readiness**: each `apps/web` server instance checks its configuration when it starts (`instrumentation.ts`) and logs `server_ready` or `server_not_ready` (scope `readiness`, the problems named by variable, never by value). It keeps serving: the pages work and each route still refuses to run without its own configuration. `GET /api/health` answers 503 `{ ok: false, code }` (`config_invalid`, `cluster_mismatch` when the browser bundle was built with another `NEXT_PUBLIC_SOLANA_CLUSTER` than the server's `SOLANA_CLUSTER`) until it is fixed: check it after every deployment, and rebuild after changing a `NEXT_PUBLIC_*` value (they are inlined at build time).
- **Builder and signer on the same cluster**: at startup the builder calls the signer's `GET /v1/health` (HMAC-signed) and refuses to start unless the signer reports the builder's `SOLANA_CLUSTER`. A signer on another cluster, an answer without a cluster or a rejected request (HMAC secret, `SIGNER_ALLOWED_IPS`, clock) stops it at once. An unreachable signer (network error, timeout, 5xx) is retried 5 times, 2, 4, 8 then 16 s apart (10 s timeout per request), then the builder exits and its supervisor restarts it: start or fix the signer first.
- **Signer daily cap**: `SIGNER_MAX_LAUNCHPADS_PER_DAY` limits how many launchpads the signer prepares per day; raising it needs a restart.

## Sleep mode

A launchpad with no trade for 30 days goes to `sleeping`: the builder replaces the deployment with a lightweight static page (no Jupiter data, no RPC call until a visitor opens the fee claim). The coin stays tradable on Meteora and Jupiter. Coin creators can still claim their creator fees there (D29): the sleeping page keeps the claim widget, which goes through the FORGE RPC relay. The relay serves a sleeping site's origin the claim's methods only and refuses its server token, so uploads and coin creation stay off. Live sites serve the same claim at `/creator-fees`. The client can reactivate it from their dashboard.

## Support

- Terms of use: FORGE provides the tool, the client operates their launchpad. FORGE may disable a reported site.
- A single channel for incidents (to be defined by the team).
- FAQ: how to claim your fees, why the coin does not appear yet, what to do if creation fails.

## Costs to watch every week

Anthropic API (console), Helius (credits), Vercel (build minutes, bandwidth), Supabase (database size), Jupiter (request limits).
