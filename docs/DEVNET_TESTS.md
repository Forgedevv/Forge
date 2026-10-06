# DEVNET_TESTS — to do before anything else

Four on-chain tests on devnet, written by agent 1 in `scripts/devnet-tests/`. They validate the assumptions of the revenue model. Each test has a plan B; no failure blocks the project, but a failure changes the code of `@forge/core`.

A script already exists for test 1 (`dbc-referral-test/test.mjs`, written in a previous session): pick it up and adapt it.

## Rules

- The script refuses to run if `RPC_URL` does not contain `devnet`.
- Disposable wallets are generated and saved in `scripts/devnet-tests/.state/` (in `.gitignore`).
- Devnet SOL comes from https://faucet.solana.com (GitHub login): Ali funds the `funder` wallet displayed by the script, then the script distributes it.
- Each test writes a report `scripts/devnet-tests/reports/<test>.md` with the measured amounts and the Solscan devnet links.
- Resume: rerunning a script does not redo steps already done.

## Test 1 — Meteora referral

**Goal**: confirm that a swap with `referralTokenAccount` gives 20% of the protocol share to the referral account, without touching the partner share.

1. Simple config (quote SOL, 1% fee, `creatorTradingFeePercentage` = 0).
2. Pool.
3. WSOL account of the `referral` wallet.
4. Buy of 0.1 SOL with referral, then the same without referral.
5. Measure: referral account balance, change in `partnerQuoteFee`, `protocolQuoteFee`, `creatorQuoteFee` in the pool state, swap event.

**Expected**: fee ≈ 1,000,000 lamports; with referral: protocol 160,000, referral 40,000; partner 800,000 in both cases.

**Plan B**: keep only the 0.3% platform fee. Loss ≈ 0.04% of the volume going through our button.

## Test 2 — Creator share on a dedicated config

**Goal**: confirm that the creator wallet earns `creatorTradingFeePercentage` and can claim it to another address; measure what happens after migration.

1. Config with `creatorTradingFeePercentage` = 25 and a share of creator liquidity permanently locked.
2. Pool created with `poolCreator` = `forgeCreator` wallet.
3. Several buys and sells from `trader`.
4. `claimCreatorTradingFeeToReceiver` to the `multisigStandIn` wallet.
5. Fill the curve up to the threshold, migrate with the manual tool, do swaps on the migrated pool, claim the fees from the creator liquidity.

**Expected**: creator ≈ 25% of the non-protocol share before migration; creator liquidity fees after migration.

**Plan B**: swap the roles on the launchpad coin config: FORGE `feeClaimer` (partner), the client as creator. To be validated with the team if this case arises.

## Test 3 — First buy paid by the client

**Goal**: confirm that a single transaction can create the pool (signed by `forgeCreator`) and make the first buy paid and signed by `client`, with tokens received by `client`.

1. The script builds `createPoolWithFirstBuy` with `poolCreator` = `forgeCreator`, `buyer` = `receiver` = `client`.
2. Partial signature by `forgeCreator` (and the mint keypair), serialization, then signature by `client`, send.
3. Verify: pool created, creator = `forgeCreator`, tokens at `client`, SOL debited from `client`.
4. With `enableFirstSwapWithMinFee` = true and anti-sniper active: verify that the first buy pays the minimum fee.

**Plan B**: FORGE creates the pool, the client buys in a separate transaction right after, with the anti-sniper active.

## Test 4 — Platform fee in the swap

**Goal**: confirm that a 0.3% transfer can be added in the same transaction as the swap, on both buy and sell.

1. Transaction: SOL transfer of 30 bps to `platformFee` + swap (with referral).
2. Buy then sell.
3. Verify the balances and the transaction size (Solana size limit).

**Plan B**: if the transaction exceeds the size limit, use an address lookup table; if a wallet shows a blocking warning (tested later on mainnet), display the fee before signing or lower the rate.

## After the tests

Agent 1 writes a summary of the 4 results in `scripts/devnet-tests/reports/SUMMARY.md` (and the proposed plan B if a test fails). The lead session records these results in `docs/DECISIONS.md` and validates the plan B with Ali. The rest of `@forge/core` is written according to these results.
