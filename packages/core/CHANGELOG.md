# Changelog — @forge/core

All notable changes to `@forge/core`. Versions follow semantic versioning. Consumers (the
launchpad template, the signer, the web app) pin an exact version, never a range.

## 0.1.0 — unreleased

First version meant for publication on npm as `@forgedevv/core` (with `@forgedevv/shared`), through
`node scripts/publish-core.mjs --publish`. Not published yet.

- `listCoinsOfCreator` (creator pools through SDK `getPoolsByCreator`), `DBC_POOL_CREATOR_OFFSET`, `DBC_POOL_CONFIG_OFFSET`.

### Changed (security review)

- **On-chain configs compared field by field.** New `onchainConfigMismatches(config, kind,
  { spec?, owner?, poolCreationFeeLamports? })` (config.ts) compares a decoded config with the
  parameters core builds for it: accounts, token, base fee (cliff, periods, period, reduction,
  mode), dynamic fee, creator share, pool creation fee, first swap at the minimum fee, activation,
  liquidity split and vesting, migration option / fee option / threshold, migration fee
  percentages, migrated pool fee, locked vesting, token supply, start price and curve. Without a
  spec, the spec fields are read from the config and must be values a FORGE spec can hold.
  - `assertLaunchCoinConfig(config, owner, spec?)`: runs it (optional `spec`, recommended).
    `BuildLaunchCoinTxParams.spec?` passes it. A coin config with a pool creation fee is now
    `CONFIG_MISMATCH` (the current builder sets none).
  - `assertUserCoinConfig(config, expected?)`: runs it against the launchpad config;
    `BuildUserCoinLaunchTxParams.expectedConfig?` passes the expectation.
- **validate.ts pins every value-moving field to FORGE's settings**: no migration fee
  (`MIGRATION_FEE_NOT_ALLOWED`), no locked vesting (`LOCKED_VESTING_NOT_ALLOWED`), the fixed supply
  of `FORGE_TOKEN_SETTINGS` (`TOKEN_SUPPLY_MISMATCH`), FORGE's curve and start price
  (`CURVE_MISMATCH`, they decide the leftover), SPL token with 6 decimals, timestamp activation,
  and the anti-sniper schedule exactly `ANTI_SNIPER_FEE_SCHEDULE` (a flat linear fee when
  `spec.antiSniper` is off): an exponential schedule, another starting fee or one 300 s period at
  99% are refused.
- The fixed settings moved to `settings.ts` (re-exported by config.ts, unchanged values), with
  `FORGE_TOKEN_SUPPLY_RAW`, `forgeFeeSchedulerParam`, `forgeBaseFee`, `forgeReferenceCurve`.
  `curveParamsFor`, `creatorTradingFeePercentageFor` and `poolCreationFeeSolFor` accept just the
  spec fields they read (`ConfigSpecFields`); a full `LaunchpadSpec` still fits.
- **Platform fee on a user coin's first buy.** `buildUserCoinLaunchTx` adds ONE SystemProgram
  transfer of `platformFeeLamports(firstBuyLamports)` (30 bps, rounded up) to
  `FORGE_PLATFORM_FEE_WALLET` (read from `env`), as the last instruction; `chargePlatformFee:
  false` turns it off. The wallet must be rent-exempt (`PLATFORM_FEE_WALLET_NOT_READY`). The
  summary gains `platformFeeLamports` and `platformFeeWallet`; `LaunchCoinCosts.platformFeeLamports`
  (optional) is set and counted in `ownerTotalLamports`.
- **Swaps.** `MAX_SWAP_SLIPPAGE_BPS` is 2,500 (25%, was 50%). `buildBuyTx`, `buildSellTx`,
  `quoteSwap`, `fetchSwapContext` and `fetchSwapPoolState` take an optional `allowedConfigs`: a
  pool whose on-chain config is not listed is refused (`POOL_NOT_ALLOWED`) before its config is
  read. The builders now require the platform fee wallet to be exactly `FORGE_PLATFORM_FEE_WALLET`
  and a system account (`PLATFORM_FEE_WALLET_MISMATCH`), and, when the environment has
  `FORGE_MULTISIG_VAULT`, the Meteora referral token account to be held by it
  (`REFERRAL_ACCOUNT_INVALID`). `buildSwapTransaction(ctx, request, expected?)`,
  `assertPlatformFeeWalletReady(..., expectedWallet?)`, `assertReferralAccountReady(...,
  expectedOwner?)`, new `assertPoolConfigAllowed`, `readOptionalAddress` (addresses.ts);
  `swapFeeAddresses` also returns `multisigVault`.
- `checkPaymentTransaction` / `verifyPayment`: `transferLamports` on `amount_mismatch` when the transfer amount differs.
- Jupiter referral fee claim (`jupiter-referral.ts`, mainnet-beta only): `buildJupiterReferralClaimTx`
  reads the referral account, its project and the two collection accounts of a mint (classic
  `referral_ata` PDA and the referral account's associated token account) and builds the
  permissionless `claim` / `claim_v2` instructions to the referral account's partner (the FORGE
  multisig vault, asserted with `expectedPartner`). Raw instructions from the referral program IDL
  (no Anchor dependency), with the pure pieces exported (`decodeJupiterReferralAccount`,
  `decodeJupiterProject`, `deriveJupiterReferralTokenAccount[V2]`, `buildJupiterReferralClaimIx`,
  `buildJupiterCreateAdminTokenAccountIx`). Any cluster but mainnet-beta is refused
  (`JupiterReferralError` `wrong_cluster`). The summary also carries the project's `admin` and
  `projectAuthority`, so a caller can pin every account of the built claim.
- Squads accounts of the buyback read in addresses.ts (PLANEXECUTE rule 7): `FORGE_SQUADS_MULTISIG`
  and `FORGE_SQUADS_SPENDING_LIMIT` join `FORGE_ADDRESS_NAMES` as optional names;
  `readSquadsAddresses(env)` returns them with `FORGE_SQUADS_VAULT_INDEX` (default 0) or `null`
  when both are absent, and refuses half a configuration, an index without them, an index outside
  0..255 or a spending limit equal to the multisig (`ForgeSquadsConfigError`). Deriving the vault
  needs the Squads program id: the signer keeps that check.

### Added (DAMM v2 position fee claims)

- `position-claims.ts`: after a launchpad coin migrates, the FORGE creator wallet keeps a
  permanently locked DAMM v2 position that earns the migrated pool's trading fees.
  `buildCreatorPositionFeeClaimTx` builds the unsigned `claim_position_fee` of the creator's
  position(s) to a receiver (`buildForgeCreatorPositionFeeClaimTx`: the multisig vault), creator
  signing, optional fee payer: coin fees to the receiver's associated account, SOL fees to the
  creator's temporary WSOL account closed to the receiver (fees plus rent as lamports). The
  transaction never removes liquidity nor closes, locks or transfers the position or its NFT.
  Summary, costs (`PositionClaimCosts`), skip reasons (`no_position`, `nothing_to_claim`,
  `not_worthwhile`), `isPositionClaimWorthwhile`. Pure helpers: `migratedDammV2Pool` (the DAMM v2
  pool of a migrated DBC pool, derived like the SDK migration), `positionPendingFees`,
  `summarizePosition`, `sumPendingFees`; reads: `findCreatorDammV2Positions` (the creator's
  positions, NFT ownership re-checked), `getDammV2PoolState`. Constants for policies:
  `DAMM_V2_PROGRAM_ID`, `CLAIM_POSITION_FEE_DISCRIMINATOR`, `CLAIM_POSITION_FEE_ACCOUNTS`.
  New `ClaimError` codes: `not_migrated`, `damm_pool_not_found`, `damm_pool_mismatch`,
  `position_not_found`, `position_mismatch`, `position_not_owned`.
- Dependency: `@meteora-ag/cp-amm-sdk` 1.5.1 (exact pin, like the DBC SDK).
- Fixtures: `__fixtures__/cp-amm-devnet-accounts.json`, the devnet test 2 migration captured
  read-only (`scripts/devnet-tests` `fixtures:cp-amm`).

### Changed (wave 5 review)

- **Launch metadata budget.** `LAUNCH_METADATA_BUDGET_BYTES` (148): name + symbol + metadata URI
  share 148 UTF-8 bytes in the launchpad coin launch (durable nonce held by the creator, first
  buy); a 32-byte name, 10-byte symbol and 106-byte URI land at exactly 1,232 bytes, one byte more
  is `TX_TOO_LARGE`. New pure `assertSpecLaunchable(spec, metadataUri)` (metadata rules, budget,
  first buy; `LaunchCoinError` `INVALID_INPUT` / `TX_TOO_LARGE`) and `launchMetadataBytes`.
  `buildConfigParams(spec, kind, { metadataUri? })` and `buildCreateConfigTx({ metadataUri? })`
  run it first (`ValidationError`, new code `LAUNCH_METADATA_TOO_LONG`), so no config is created
  for a coin that cannot be launched. `METADATA_LIMITS.uri` (200) stays the Metaplex limit (the user
  coin launch fits it); it is not the launchpad coin limit. The metadata checks moved to
  `launch-metadata.ts` and are still exported from `pool.ts`.
- **No pool creation fee on the launchpad coin config** (`LAUNCHPAD_COIN_POOL_CREATION_FEE_SOL`,
  `poolCreationFeeSolFor`): the client only paid its own coin's fee to itself minus the protocol
  share. `validateLaunchpadCoinConfigParams` now requires 0; the launchpad config keeps
  `spec.poolCreationFeeSol`. The config parameters hash of a launchpad coin config changes.
- `toOwnerTransactionSummary` fills the new optional `ownerRequiredBalanceLamports`.
- `verifyPayment` requires `finalized` by default (pass `commitment: 'confirmed'` explicitly for
  the old behaviour); `checkPaymentTransaction` refuses a transaction whose first signature is not
  the signature looked up (`signature_mismatch`).

### Added (wave 5 review)

- `verifyLaunchCoinTransaction(tx, expected)` (`launch-check.ts`, also `@forge/core/launch-check`
  for browsers: only depends on `@solana/web3.js`): accepts nothing but the launchpad coin launch
  core builds, for the owner and the exact first buy, with valid creator and mint signatures
  (`LaunchTransactionCheckError`). Used by the web client before the wallet signs and by the web
  server before it hands the stored launch out.

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
- `package.json`: `"sideEffects": false`, so bundlers can drop the modules a site does not use.
  Verified: no module has a side effect when loaded (only constant definitions, a WeakMap cache
  and a guard on the SDK IDL in `swap.ts`); `src/side-effects.test.ts` loads every module and
  checks that no global is added and `process.env` is neither read nor written.
- Deterministic durable nonce accounts: `buildCreateNonceAccountWithSeedTx({ connection, base,
  seed, authority, payer?, computeUnitPriceMicroLamports? })` creates and initializes the nonce
  account at `createWithSeed(base, seed, SystemProgram)` (`createAccountWithSeed` +
  `nonceInitialize`, rent read from the cluster). No nonce keypair to store: after a lost journal
  the signer re-derives the address with `deriveSeededNonceAccount(base, seed)` and reads it with
  `readNonce`. Signers: the payer (default: the base) and the base when distinct. Seeds are 1 to
  32 UTF-8 bytes (`assertNonceSeed`, `MAX_NONCE_SEED_BYTES`); a launchpad UUID without its dashes
  is exactly 32 characters. Like `buildCreateNonceAccountTx`, it does not check that the account
  is free.

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
