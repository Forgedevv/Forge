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
| 1. Meteora referral | to do | — |
| 2. Creator share | to do | — |
| 3. Client first buy | to do | — |
| 4. Platform fee | to do | — |
