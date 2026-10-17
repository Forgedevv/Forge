# DECISIONS

Kept up to date by the lead session. Agents read it, do not modify it.

## Made

| # | Decision | Detail |
|---|---|---|
| D1 | Chain and engine | Solana + Meteora Dynamic Bonding Curve, no smart contract of our own |
| D2 | Creation price | $33 in SOL (~0.3 SOL), price fixed in dollars |
| D3 | Modifications | 2 included, then $5.50 each |
| D4 | Agent failure | 2 attempts, then automatic refund |
| D5 | Agent access | hold a fixed amount of $FORGE (~$100), reviewed weekly, rechecked on each use |
| D6 | FORGE creator share | 25% on each launchpad's coin, FORGE is its creator |
| D7 | Platform fee | 30 bps on our buy button before graduation; 30 bps Jupiter integrator fee after |
| D8 | Trading revenue | 100% $FORGE buyback, no burn, tokens held in the treasury |
| D9 | Fallback rule | if creations no longer cover fixed costs, 10 to 20% of trading revenue goes to the cashbox (manual decision) |
| D10 | Builder agent | codes the design of each launchpad, one repo + one Vercel deployment per client |
| D11 | Client interface | chat on the FORGE site |
| D12 | Infra | Vercel + 2 Hetzner VPS (builder / signer separate) + Supabase + Helius + Squads |
| D13 | $FORGE launch | on the FORGE launchpad built by our agent, after the MVP is validated on mainnet |
| D14 | $FORGE team share | first buy of 3 to 5% of the supply, announced, locked for a period |
| D15 | Currency | SOL only in the MVP |
| D16 | Migration threshold | 10 SOL |
| D17 | Deferred | the agent's X account, custom domains, legal advice, written team agreement |
| D19 | Partner fees | `feeClaimer` = `leftoverReceiver` = the client wallet on both configs; the client claims partner fees from the dashboard. The signer only claims FORGE's creator share (launchpad coin) to the multisig |
| D20 | Payments | the client pays the exact quoted amount with the memo `forge:job:<jobId>`; overpayments and late payments are recorded for manual refund |
| D21 | Client sites | client Vercel projects receive only public values (RPC through the FORGE relay, uploads through FORGE presigned URLs); Git-triggered deployments are disabled, only the builder deploys |
| D22 | First buy | at most 10 SOL (the 10 SOL migration threshold) |
| D18 | Failure after approval | a failure at the on-chain or deployment step is neither retried nor refunded automatically: alert + manual handling (configs may have been created) |
| D23 | Launchpad coin creation fee | the launchpad coin config has `poolCreationFee` = 0; the launchpad config keeps the client's `poolCreationFeeSol` |
| D24 | Disabled launchpads | the builder deploys the maintenance page and also pauses the Vercel project, so neither the site nor its old previews keep serving |
| D25 | Payment anomalies | late, mismatched, duplicate and released-launchpad payments are stored in `payment_anomalies` and refunded by hand (completes D20) |
| D26 | `@forge/core` distribution | published publicly on npm under the `@forgedevv` scope (`@forgedevv/core`), pinned to an exact version in each client repo; no registry token reaches client projects |
| D27 | Migrated pool fee | fixed 0.25% after graduation (`FixedBps25`) |
| D28 | Client previews | public behind an unguessable Vercel URL |
| D29 | Claims while sleeping | coin creators can still claim their creator fees while a launchpad is sleeping: the sleeping page keeps the claim widget |
| D30 | Client site host | until `<slug>.<CLIENTS_DOMAIN>` is verified on Vercel (none in the devnet beta), a client site is served at a production `*.vercel.app` alias of its own Vercel project. The builder records the exact host it reads from the Vercel API for that project and deployment in `launchpads.site_host` (verified subdomain preferred); the relay, the upload route, the dashboard and the coin metadata trust that exact host only, with the launchpad's status rules, and only when it is `<one label>.vercel.app` or exactly `<own slug>.<CLIENTS_DOMAIN>`. Vercel URLs are never trusted by pattern (look-alike project names) |

| D31 | Referral accounts | superseded by D34: the Meteora referral WSOL account and the Jupiter referral account belong to the revenue wallet, and client sites receive `NEXT_PUBLIC_FORGE_REVENUE_WALLET` instead of the vault |
| D32 | Fees after graduation | the signer claims the fees of the FORGE creator's permanently locked DAMM v2 position to the multisig, like the DBC creator share before graduation; the position itself is never moved or unlocked |
| D33 | Buyback funding | the buyback bot is a multisig member with no permission and a daily SOL spending limit whose only destination is itself; the team sets the amount (D8) |
| D34 | Revenue wallet | the vault can only move native SOL without a multisig signature (D33's spending limit), so the non-native trading revenue goes to a signer-held **revenue wallet** (keystore role `revenue`, `FORGE_REVENUE_WALLET`): it is the platform fee wallet (`FORGE_PLATFORM_FEE_WALLET` must be it), holds the Meteora referral WSOL account and is the partner of the Jupiter referral account. A signer job (`revenue`) unwraps the WSOL, converts the other balances to SOL through Jupiter (mainnet) and forwards the native SOL above a small reserve to the vault every day, journaled per forward with a breakdown by source (`meteora_referral`, `jupiter_referral`, `platform_fee`, `other`); the buyback budget (D8) reads that journal. The hot key holds about one day of revenue; the forward destination is pinned to the vault by the signing policy; `revenue_paused` stops it. Client sites receive `NEXT_PUBLIC_FORGE_REVENUE_WALLET` and refuse a swap whose referral account is held by anyone else or whose platform fee wallet is not it. Client payments (cashbox sweeps) are not trading revenue and never go through it. Supersedes D31 |

## Open (to be decided by the team)

| # | Question | Blocks |
|---|---|---|
| Q1 | Multisig members and number of signatures (proposal: 2 of 3) | multisig creation (setup) |
| Q2 | Who advances the startup costs (~$150 then ~$110/month) | account opening |
| Q3 | Final FORGE name and domains (FORGE + a domain separate from client sites) | Vercel setup |
| Q4 | Tool to lock the client's first buy (Streamflow, Jupiter Lock...) and duration | end of the MVP (not blocking to start) |
| Q5 | First test clients | mainnet tests |
| Q6 | Who handles support | public launch |
| Q7 | Public launch date | planning |

## Devnet test results

| Test | Result | Plan B applied |
|---|---|---|
| 1. Meteora referral | PASS — the referral gets exactly 20% of the protocol share (40,000 / 160,000 lamports on a 1,000,000 fee); partner share unchanged. `poolCreationFee = 0` accepted on-chain | none |
| 2. Creator share | PASS — the creator gets 25.00% of the non-protocol fees and can claim them to another address; after migration to DAMM v2 the creator's permanently locked position keeps earning fees (claimed to the multisig stand-in) | none |
| 3. Client first buy | PASS — one transaction: FORGE creator + mint partially sign, the client signs last and pays; the first buy pays the minimum fee under a 99% anti-sniper schedule | none |
| 4. Platform fee | PASS — 30 bps SOL transfer + referral swap in one transaction (buy 754 bytes, sell 722 bytes, limit 1,232) | none |

Run on devnet on 2026-10-07; reports with Solscan links are in `scripts/devnet-tests/reports/`. Fake $FORGE (devnet): `ES4otaE7FckJGJEKwpk3noaCZBt4FQZhuhWqUDdhuBEF` (6 decimals).

Findings to apply in `@forge/core`:
- `FORGE_PLATFORM_FEE_WALLET` (and any fresh fee recipient) must already be rent-exempt, otherwise the whole swap transaction fails: check it at startup.
- `createPoolWithFirstBuy`: the pool creator **and** the mint sign; the client is the fee payer and the buyer.
- DBC events come through self-CPI (event authority), not log lines; in `evtSwap`, `tradingFee` is partner + creator only.
- Migration is scriptable (`migrationDammV2CreateMetadata` through the SDK's program object, then `migrateToDammV2`); the production threshold stays 10 SOL.
- Confirm transactions by polling `getSignatureStatuses` (websocket subscriptions get rate-limited).
- Never hard-code rent: read `getMinimumBalanceForRentExemption`.
