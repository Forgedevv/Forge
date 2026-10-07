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
| D18 | Failure after approval | a failure at the on-chain or deployment step is neither retried nor refunded automatically: alert + manual handling (configs may have been created) |

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
