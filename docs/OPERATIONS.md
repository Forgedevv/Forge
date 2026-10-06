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

## Kill switches (`flags` table in Supabase)

| Flag | Effect |
|---|---|
| `signups_paused` | `apps/web` refuses new creations (existing clients continue) |
| `deploys_paused` | the builder stops picking up jobs |
| `buyback_paused` | the buyback bot stops |
| `launchpads.status = 'disabled'` | the launchpad site shows a maintenance page |

Each service rereads the flags at least every minute.

## Automatic tasks

| Task | Frequency | Service |
|---|---|---|
| Claim the creator share of each pool to the multisig | every 24 h | signer |
| Transfer the cashbox surplus to the multisig | every 24 h | signer |
| $FORGE buyback | several small buys per day, random times | signer |
| Convert to SOL the Jupiter fees received in other currencies | every 24 h | signer |
| Put launchpads with no trade for 30 days into sleep mode | every 24 h | builder |
| Replay the devnet tests (referral, creator share) | weekly | CI or VPS 1 |

## Sleep mode

A launchpad with no trade for 30 days goes to `sleeping`: the builder replaces the deployment with a lightweight static page (no RPC, no Jupiter data). The coin stays tradable on Meteora and Jupiter. The client can reactivate it from their dashboard.

## Support

- Terms of use: FORGE provides the tool, the client operates their launchpad. FORGE may disable a reported site.
- A single channel for incidents (to be defined by the team).
- FAQ: how to claim your fees, why the coin does not appear yet, what to do if creation fails.

## Costs to watch every week

Anthropic API (console), Helius (credits), Vercel (build minutes, bandwidth), Supabase (database size), Jupiter (request limits).
