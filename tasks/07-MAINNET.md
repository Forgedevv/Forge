# 07 — MAINNET: real tests and launch

**Who**: Ali + lead session. Small amounts only (total budget 0.5 to 1 SOL).

## Before going to mainnet

- [ ] The devnet integration flow (`tasks/06`) passes entirely.
- [ ] Mainnet Squads multisig created, members and threshold validated (Q1).
- [ ] Anthropic spending limit set; per-job budget verified.
- [ ] Helius and Supabase moved to a paid plan; Jupiter key created; Jupiter referral account and SOL + USDC token accounts created, held by the multisig.
- [ ] Meteora referral account (WSOL) held by the multisig.
- [ ] `SOLANA_CLUSTER=mainnet-beta` only on production environments.

## Mainnet tests (small amounts)

- [ ] Create a complete test launchpad (real payment ~$33, or a temporarily reduced price in an env variable for the test).
- [ ] Template interface: coin list via Jupiter, `BuyButton` on a coin on the curve.
- [ ] **Display in Phantom and Backpack**: the 0.3% transfer and the swap show up without a blocking warning.
- [ ] Meteora referral and platform fee received in the multisig's accounts.
- [ ] Graduate a test coin (10 SOL threshold: use a low-threshold test launchpad if possible, otherwise test graduation on devnet only with the manual tool); trade via `JupiterTrade`; integrator fee received (amount, currency).
- [ ] Automatic claims to the multisig; partner claim by the client.
- [ ] Telegram alerts received (simulate a low balance).

## $FORGE launch

- [ ] The agent builds the FORGE launchpad like for a real client.
- [ ] Simulate the curve to know the cost of the team's first buy (3 to 5% of the supply).
- [ ] Team first buy, announced publicly, locked with the chosen tool (Q4).
- [ ] Set `FORGE_MINT` and `FORGE_GATING_AMOUNT` in production → token-gating activates.
- [ ] Take the buyback out of simulation mode.
- [ ] Enable the team's contacts at launch time.

## After the launch

- [ ] Daily follow-up of alerts and costs (OPERATIONS.md).
- [ ] Weekly review of `FORGE_GATING_AMOUNT`.
- [ ] The agent's X account (postponed).
