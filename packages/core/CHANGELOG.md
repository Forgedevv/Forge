# Changelog — @forge/core

All notable changes to `@forge/core`. Versions follow semantic versioning. Consumers (the
launchpad template, the signer, the web app) pin an exact version, never a range.

## 0.1.0 — unreleased

First version meant for publication to GitHub Packages (`pnpm --filter @forge/core
publish:packages`, which runs typecheck, lint, tests and build first). Not published yet.

### Changed (wave 4 review)

- **No referral on the first buy.** `buildLaunchCoinTx` no longer adds the FORGE Meteora referral
  (`FORGE_METEORA_REFERRAL_ACCOUNT`) to the first buy, and refuses an explicit one
  (`LaunchCoinError` `REFERRAL_UNSUPPORTED`) instead of silently dropping it. Why: with a referral
  token account on the swap of `createPoolWithFirstBuy`, the DBC program does not apply the
  first-swap minimum fee (`enableFirstSwapWithMinFee`); on devnet the first buy then paid the
  anti-sniper fee and failed with `ExceededSlippage` even at 10% slippage, while the same launch
  without a referral landed exactly at the quote (`scripts/devnet-tests/reports/signer-routes.md`,
  reproduced in `scripts/devnet-tests/reports/core-launch.md`). The referral would only have
  earned 20% of the protocol share of one minimum-fee swap. There is no opt-in: no devnet run
  showed a referral first buy at the minimum fee. Swaps built by `swap.ts` keep the referral.
  - `BuildLaunchCoinTxParams.referralTokenAccount` and `.env` are deprecated (kept so that callers
    passing `null` / `{}` still compile); `LaunchCoinSummary.referralTokenAccount`,
    `.referralSource` and `.referralOmittedForSize` are now always `null`, `'none'` and `false`.
  - Removed: `defaultLaunchReferral`, `REFERRAL_TX_BYTES` and the `REFERRAL_INVALID` error code.
  - The 32 bytes the referral took are free again: with a nonce held by the creator, a 32-byte
    name, a 10-character symbol and a 106-byte URI fit in 1,232 bytes.

### Added (wave 4 review)

- `buildUserCoinLaunchTx({ connection, config, wallet, mint, name, symbol, metadataUri,
  firstBuyLamports, slippageBps?, env?, computeUnitLimit?, computeUnitPriceMicroLamports? })`
  returns `{ transaction, summary }` for a coin created by a user on the client's launchpad
  config: the wallet is pool creator, rent payer, fee payer and buyer; the mint is the only other
  signer; recent blockhash (no durable nonce); no referral on the first buy (same reason as
  above); `env` is accepted but not read. Config checks (`assertUserCoinConfig`): SOL quote, SPL
  token program for both tokens, `enableFirstSwapWithMinFee`; no owner or creator-share check.
  `summary.costs` has the same figures as `LaunchCoinCosts` (rent read from the cluster; the
  `owner*` fields are the wallet's, `creatorTotalLamports` is 0). A launch with short metadata is
  950 bytes; the largest metadata (32 / 10 / 200 bytes) fits.
- `SwapQuote.priceImpactBps` (required field, integer bps 0 to 10,000, rounded up), computed by
  the new pure `swapPriceImpactBps` from the pool state: with the spot price
  `P = sqrtPrice^2 / 2^128`, `I` what enters the curve (after input-side fees) and `O` what the
  curve returns (before output-side fees), a buy is `1 - O / (I / P)` and a sell
  `1 - O / (I * P)`: one minus what the trade gets over what it would get at the spot price.
  Pool and platform fees are excluded (they are
  in `fees`). On a single curve segment it equals `1 - sqrtPrice / nextSqrtPrice` (buy) and
  `1 - nextSqrtPrice / sqrtPrice` (sell), checked against the SDK in the tests.
- `CoinOfConfig.poolCreationFee` (required field, `PoolCreationFeeStatus`): the coin's pool
  creation fee (`totalLamports`, the config's `poolCreationFee`), the partner share
  (`partnerShareLamports`, 90% rounded as the program does), whether the partner claimed it
  (`partnerClaimed`, from the pool's `creationFeeBits` & `0b10`) and `partnerUnclaimedLamports`, so
  the dashboard can add it to the claimable total without another read. Pure helper
  `poolCreationFeeStatus(state)`; `PROTOCOL_POOL_CREATION_FEE_CLAIMED_BIT` (`0b01`) added.
  `PARTNER_POOL_CREATION_FEE_CLAIMED_BIT` and `partnerPoolCreationFeeShare` moved to `reads.ts`
  (still exported, same values).

### Added

- `addresses.ts`: FORGE addresses read from the environment, `requireAddresses([...])`.
- `constants.ts`: business constants from `@forge/shared`, SDK bounds, exact SOL/lamport helpers.
- `validate.ts`: on-chain parameter validation of both configs (SDK and FORGE bounds).
- `config.ts`: `buildLaunchpadConfig(spec)` and `buildLaunchpadCoinConfig(spec)` return the SDK
  `ConfigParameters` plus `feeClaimer`, `leftoverReceiver` (both the client wallet,
  `spec.ownerWallet`) and `quoteMint` (SOL), built with `buildCurve` and validated before they
  are returned (`ValidationError` otherwise). `buildCreateConfigTx` returns the unsigned
  `createConfig` transaction; the config keypair is the caller's. `buildLaunchpadCoinConfig`
  also refuses a spec whose `launchpadCoin.firstBuySol` does not fit in the curve (about 10.1
  SOL at a 1% fee), so an un-launchable spec fails before any config is created.
  `quoteFirstBuyOnConfig` is the pure quote of a first buy on a fresh pool.
- `pool.ts`: `buildLaunchCoinTx` builds the launch of the launchpad coin
  (`createPoolWithFirstBuy`): the FORGE creator wallet and the mint sign on the signer side, the
  client is fee payer and buyer and signs last. Optional durable nonce (`nonceAdvance` first,
  nonce value as `recentBlockhash`), compute budget instructions, on-chain checks of the config
  (it must be the client's launchpad coin config), size check, and a summary of every lamport
  the client pays (`toOwnerTransactionSummary` maps it to the shared `OwnerTransactionSummary`).
- `tx.ts`: `confirmSignature` (polling `getSignatureStatuses` with a deadline), base64
  (de)serialization of partially signed transactions, `assertSignedCopyOf` (a returned
  transaction must be the stored one, fully signed), `transactionSignature`, signer and size
  helpers, `computeBudgetInstructions`, `readNonce`, `buildCreateNonceAccountTx` (rent read from
  the cluster), `assertRentExempt`.

### Settings chosen for the configs

Not fixed by the docs; each is a named constant in `config.ts`:

- Curve: `buildCurve`, 1,000,000,000 SPL tokens with 6 decimals, 20% of the supply migrated,
  migration to DAMM v2 at exactly 10 SOL, no migration fee, immutable metadata.
- Anti-sniper (`spec.antiSniper`): linear fee scheduler from 99% to `spec.tradingFeeBps` in
  10 steps over 60 seconds. The first buy of each pool pays the ending fee
  (`enableFirstSwapWithMinFee`).
- Post-graduation liquidity, all permanently locked: the creator gets the same percentage as its
  trading fee share (`spec.coinCreatorSharePct` on the launchpad config, 25% for FORGE on the
  launchpad coin config), the partner (client) the rest.
- Migrated DAMM v2 pool fee: `MigrationFeeOption.FixedBps25` (0.25%).

### Devnet

`scripts/devnet-tests/reports/core-config-pool.md`: both configs, a nonce account and two
durable-nonce launches (the second reuses the nonce account), end to end. All checks pass; the
client's debit equals the summary to the lamport.

### Limits

- The launch is a legacy transaction of at most 1,232 bytes: 1,120 bytes with short metadata, a
  nonce held by the creator and no priority fee, leaving 112 bytes for longer metadata (a 32-byte
  name, a 10-character symbol and a 102-byte URI fit; a priority fee adds 12 bytes, a nonce
  authority other than the creator or the owner 96). `TX_TOO_LARGE` otherwise. (Before the wave 4
  review the first buy also carried a 32-byte referral; see "Changed".)
