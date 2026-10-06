# 01 — ON-CHAIN (agent 1)

**You own**: `packages/core`, `scripts/devnet-tests`.
**You read**: `PLANEXECUTE.md`, `docs/METEORA.md`, `docs/DEVNET_TESTS.md`, `docs/INTERFACES.md`, `docs/SECURITY.md` (sections 1, 5).

You write the **transaction core** used by all the others: the template (swaps, claims), the web (payments), the signer (configs, pools, claims, buyback). It is the most sensitive code in the project. It must be simple, tested and free of unnecessary dependencies.

## Step A — Devnet tests (first, blocking)

- [ ] `scripts/devnet-tests/`: the 4 tests from `docs/DEVNET_TESTS.md`, with resume, refusal outside devnet, reports.
- [ ] Also create a **fake $FORGE** (SPL mint on devnet) and record it in `.state/`, for the other agents' token-gating tests.
- [ ] `reports/SUMMARY.md` with the 4 results and the proposed plan B if needed.

Until tests 1 to 3 have passed (or their plan B has been chosen), do not write the corresponding step B functions.

## Step B — `@forge/core`

Structure:

```
packages/core/src/
├── addresses.ts      # FORGE addresses read from env, required via requireAddresses()
├── constants.ts      # re-exports packages/shared + SDK bounds
├── validate.ts       # on-chain parameter validation (METEORA.md + INTERFACES.md bounds)
├── config.ts         # building the 2 configs from a LaunchpadSpec
├── pool.ts           # pool creation + first buy (partially signable transaction)
├── swap.ts           # swap with referral + platform fee (buy and sell)
├── claims.ts         # creator claim (to receiver) and partner claim
├── reads.ts          # pools of a config, curve progress, fee metrics
├── payments.ts       # SOL payment transaction to the cashbox, payment verification
├── gating.ts         # a wallet's $FORGE balance
└── index.ts
```

- [ ] `addresses.ts`: `FORGE_MULTISIG_VAULT`, `FORGE_METEORA_REFERRAL_ACCOUNT`, `FORGE_PLATFORM_FEE_WALLET`, `FORGE_JUPITER_REFERRAL_ACCOUNT`, `FORGE_CASHBOX_WALLET`, `FORGE_MINT` read from env. No global requirement at load time: `requireAddresses([...])`, called at each app's startup with its own addresses (`INTERFACES.md` §8), crashes if one is missing or invalid. `FORGE_MINT` is optional (absent before the $FORGE launch).
- [ ] `validate.ts`: one function per config; rejects anything outside the bounds; unit tests for each bound.
- [ ] `config.ts`: `buildLaunchpadConfig(spec)` and `buildLaunchpadCoinConfig(spec)` → `ConfigParameters` + `feeClaimer` + `leftoverReceiver`, per `docs/METEORA.md` (section "Settings for the two configs"). Use the SDK's `buildCurve*` helpers.
- [ ] `pool.ts`: `buildLaunchCoinTx({ config, creator, owner, mintKeypair, metadataUri, firstBuyLamports })` → transaction with `createPoolWithFirstBuy`, ready to be signed by the creator and the mint (signer side) and then by the client. Optional `durableNonce` parameter (nonce account + authority): a regular transaction expires in ~1 minute, too short for the client to sign; with a durable nonce it stays valid until used.
- [ ] `swap.ts`: `buildBuyTx` and `buildSellTx` with `referralTokenAccount` = FORGE referral and the 30 bps transfer; refuses to build a swap on a graduated pool (the template uses Jupiter in that case). Respect the transaction size limit (lookup table if needed).
- [ ] `claims.ts`: `buildCreatorClaimTx(pool, creator, receiver)`, `buildPartnerClaimTx(pool, feeClaimer)`.
- [ ] `reads.ts`: `listCoinsOfConfig`, `isGraduated`, `curveProgress`, `feeMetrics`.
- [ ] `payments.ts`: `buildPaymentTx(payer, lamports)` to the cashbox with a `jobId` memo; `verifyPayment(signature, { payer, lamports, jobId })`.
- [ ] `gating.ts`: `getForgeBalance(wallet)`.
- [ ] Unit tests (vitest) without network for validate and transaction building; devnet integration tests for pool, swap, claims, payments.
- [ ] Publishing: `pnpm --filter @forge/core publish` script to GitHub Packages, semantic versioning. **The version used by the template is pinned exactly** (no `^`).

## Interfaces you depend on

`packages/shared` (written by the lead session). If a type is missing, local mock + `docs/CHANGE_REQUESTS.md`.

## Report

_To be filled in at the end of the task: done / not done / uncertain / dependencies added / devnet test results._
