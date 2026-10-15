# OPERATIONS — running FORGE day to day

## Alerts (Telegram, team group)

Sent by `apps/signer` and `apps/builder` via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

| Alert | Source | Urgency |
|---|---|---|
| Creator role transfer on one of our pools | signer (on-chain monitoring) | immediate |
| Unexpected outflow from the multisig or the cashbox | signer | immediate |
| Payer wallet or cashbox balance too low | signer | high |
| Job failed twice, refund triggered | signer | normal |
| Deployment blocked by the scan | builder | normal (may be an abuse attempt) |
| Daily API budget exceeded at 80% | builder (gateway) | high |
| Creator fees unclaimed for more than 48 h | signer | normal |
| Repeated RPC errors | signer, builder | high |
| A released site has no verified host (`site_host_missing:<slug>`: no verified subdomain and no `*.vercel.app` alias of its own Vercel project serves the promoted deployment; browsers of that site cannot reach the relay or create coins) | builder | high |

## Kill switches (`flags` table in Supabase)

| Flag | Effect |
|---|---|
| `signups_paused` | `apps/web` refuses new creations (existing clients continue) |
| `deploys_paused` | the builder stops picking up jobs and stops production changes |
| `buyback_paused` | the buyback bot stops |
| `claims_paused` | the signer stops claiming the creator share to the multisig |
| `cashbox_sweep_paused` | the signer stops moving the cashbox surplus to the multisig |
| `refunds_paused` | the signer stops automatic refunds (they wait, nothing is lost) |
| `launchpads.status = 'disabled'` | the builder deploys the maintenance page **and pauses the Vercel project**, so the site and its old previews stop serving |

Each service rereads the flags at least every minute, and the money jobs reread their flag again right before signing.

## Builder feature flags (environment, read at startup)

| Variable | Effect |
|---|---|
| `BUILDER_VISUAL_REVIEW` | `off` (default) or `on`: new sites get a second agent pass on screenshots of the built site (desktop and mobile, measured overflow report), then the same scan and build; any failure of that pass keeps the first one. Costs up to 5 USD more per job (within the job budget) and a few minutes; it is skipped when less than 20 minutes or 1 USD are left. Needs `FORGE_SANDBOX_REVIEW_IMAGE`: when it is missing the review stays off and the startup log says so. |
| `FORGE_SANDBOX_REVIEW_IMAGE` | Pinned ID of the review image (`apps/builder/docker/review.Dockerfile`, printed by `build-images.sh`). Rebuild it regularly: it carries Chromium. |

The builder logs `visual review discarded, first pass kept` with the reason (`capture_failed`, `agent_failed`, `scan_blocked`, `build_failed`, `timeout`, `budget`...) when a review does not apply; a scan block of the second pass also sends a normal alert (`review_scan_blocked`). To test site quality on a laptop: `pnpm --filter @forge/builder site-test` (apps/builder/README.md).

## Automatic tasks

| Task | Frequency | Service |
|---|---|---|
| Claim the creator share of each pool to the multisig | every 24 h | signer |
| Transfer the cashbox surplus to the multisig | every 24 h | signer |
| Automatic refunds (2 failed builds) | continuous | signer |
| $FORGE buyback | several small buys per day, random times (simulation only until the withdrawer is wired) | signer |
| Convert to SOL the Jupiter fees received in other currencies | every 24 h (mainnet, `FORGE_CONVERT_LIVE=true`) | signer |
| Check that disabled launchpads are cut (paused on Vercel) | every 15 min | builder |
| Put launchpads with no trade for 30 days into sleep mode | every 24 h | builder |
| Sweep abandoned uploads in R2 `pending/` | every 15 min: an external scheduler sends `POST /api/internal/uploads/sweep` with `Authorization: Bearer $FORGE_INTERNAL_CRON_SECRET` (Vercel Cron sends GET, so it cannot call this route directly) | web |
| Replay the devnet tests (referral, creator share) | weekly | CI or VPS 1 |

Also set an R2 lifecycle rule that deletes objects under `pending/` after 1 day, as a backstop for the sweep.

## Manual handling

- **Payment anomalies** (late payment, wrong amount, launchpad released, duplicate payment) are recorded in the `payment_anomalies` table, never refunded automatically (D20). Check unresolved rows daily, refund from the cashbox by hand, then set `resolved_at` and a `note`. A payment counts only at the `finalized` commitment; while a job has an open quote with at least 60 s left, the web hands back that same quote instead of a new one. The row's `lamports` can be empty when the transferred amount could not be read: read it from the transaction.
- **Failure after approval** (on-chain or deployment step, D18): the job stays `failed` with an alert. Configs may already exist on-chain; check them before any retry or refund.
- **Revoke a prepared launch** (wrong spec, leaked transaction, client starting over): on the signer machine, `pnpm --filter @forge/signer exec tsx src/index.ts --revoke-launch <jobId>`. The creator wallet advances the launchpad's durable nonce, so the transaction already handed out can never land; the next prepare builds a new one. It works even when `deploys_paused` is set. To rebuild an unsigned launch, clear `jobs.owner_tx` and `jobs.owner_tx_details` in the same update (the database refuses one without the other).
- **Client site host** (`launchpads.site_host`, D30): the builder records it at every release from the Vercel API; never type one by hand from a name (look-alike `*.vercel.app` projects exist). If a client's Vercel project is deleted or loses its alias, set `site_host` to null in the same operation: a released `*.vercel.app` name can be claimed by anyone, and the relay and the upload route trust the recorded host. Re-running the deploy step records it again.
- **Signer daily cap**: `SIGNER_MAX_LAUNCHPADS_PER_DAY` limits how many launchpads the signer prepares per day; raising it needs a restart.

## Sleep mode

A launchpad with no trade for 30 days goes to `sleeping`: the builder replaces the deployment with a lightweight static page (no Jupiter data, no RPC call until a visitor opens the fee claim). The coin stays tradable on Meteora and Jupiter. Coin creators can still claim their creator fees there (D29): the sleeping page keeps the claim widget, which goes through the FORGE RPC relay. The relay serves a sleeping site's origin the claim's methods only and refuses its server token, so uploads and coin creation stay off. Live sites serve the same claim at `/creator-fees`. The client can reactivate it from their dashboard.

## Support

- Terms of use: FORGE provides the tool, the client operates their launchpad. FORGE may disable a reported site.
- A single channel for incidents (to be defined by the team).
- FAQ: how to claim your fees, why the coin does not appear yet, what to do if creation fails.

## Costs to watch every week

Anthropic API (console), Helius (credits), Vercel (build minutes, bandwidth), Supabase (database size), Jupiter (request limits).
