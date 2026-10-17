# METEORA — what is verified

Everything below was verified by reading the code of the `@meteora-ag/dynamic-bonding-curve-sdk` SDK **1.5.13**, the fun-launch scaffold from [Meteora Invent](https://github.com/MeteoraAg/meteora-invent), and the official docs. **Pin version 1.5.13**; any version bump goes through the tests in `DEVNET_TESTS.md`.

## SDK functions to use

| Need | Function | Notes |
|---|---|---|
| Create a config | `createConfig(params)` | `feeClaimer` does **not** need to sign; only `config` (new keypair) and `payer` sign |
| Build the curve | `buildCurveWithMarketCap`, `buildCurve`, `buildCurveWithTwoSegments`… | return a complete `ConfigParameters` |
| Create a pool + first buy | `createPoolWithFirstBuy({ createPoolParam, firstBuyParam })` | `createPoolParam.poolCreator` = FORGE creator wallet; `firstBuyParam.buyer` and `receiver` = client wallet |
| Swap | `swap(params)` / `swap2(params)` | `referralTokenAccount` = our referral account |
| Claim the creator share | `claimCreatorTradingFeeToReceiver` / `claimCreatorTradingFee2` | `receiver` = multisig |
| Claim the partner share | `claimPartnerTradingFeeToReceiver` / `claimPartnerTradingFee2` | signed by the client |
| List a config's coins | `getPoolsByConfig(config)` | on-chain fallback of the coin list (core `listPoolStatesOfConfig`, template `/api/coins`), see "The fun-launch template" below |
| Fee metrics | `getPoolFeeMetrics`, `getPoolFeeBreakdown`, `getPoolsFeesByConfig` | for the dashboard |
| Curve progress | `getPoolQuoteTokenCurveProgress` | to know whether a coin has graduated |
| Transfer the creator role | `transferPoolCreator` | **danger**: see SECURITY.md, mandatory alert |

There is **no instruction to modify a config**: a config is final.

## `ConfigParameters` fields

`poolFees`, `collectFeeMode`, `migrationOption`, `activationType`, `tokenType`, `tokenDecimal`, `partnerLiquidityPercentage`, `partnerPermanentLockedLiquidityPercentage`, `creatorLiquidityPercentage`, `creatorPermanentLockedLiquidityPercentage`, `migrationQuoteThreshold`, `sqrtStartPrice`, `lockedVesting`, `migrationFeeOption`, `tokenSupply`, `creatorTradingFeePercentage`, `tokenUpdateAuthority`, `migrationFee`, `migratedPoolFee`, `poolCreationFee`, `partnerLiquidityVestingInfo`, `creatorLiquidityVestingInfo`, `migratedPoolBaseFeeMode`, `migratedPoolMarketCapFeeSchedulerParams`, `enableFirstSwapWithMinFee`, `compoundingFeeBps`, `curve`.

## Bounds (SDK constants)

| Constant | Value | Meaning |
|---|---|---|
| `MIN_FEE_BPS` / `MAX_FEE_BPS` | 25 / 9900 | trading fee between 0.25% and 99% (the high end is used for the anti-sniper) |
| `MIN_MIGRATED_POOL_FEE_BPS` / `MAX_…` | 10 / 1000 | post-graduation pool fee between 0.1% and 10% |
| `MIN_LOCKED_LIQUIDITY_BPS` | 1000 | at least 10% of liquidity locked after migration |
| `MIN_POOL_CREATION_FEE` / `MAX_…` | 1,000,000 / 100,000,000,000 lamports | coin creation fee between 0.001 and 100 SOL |
| `PROTOCOL_FEE_PERCENT` | 20 | Meteora's share |
| `HOST_FEE_PERCENT` | 20 | referral's share, taken from Meteora's share |
| `MAX_PRICE_CHANGE_BPS_DEFAULT` | 1500 | |

Our own (stricter) bounds are in `INTERFACES.md`, section 1.

## Settings for the two configs

### Launchpad config (all of the client's coins)
- `feeClaimer` = client wallet; `leftoverReceiver` = client wallet.
- `creatorTradingFeePercentage` = `spec.coinCreatorSharePct`.
- Trading fee = `spec.tradingFeeBps`, with anti-sniper (decreasing fees at launch) if `spec.antiSniper`.
- `poolCreationFee` = `spec.poolCreationFeeSol` (paid to the client).
- `migrationQuoteThreshold` = 10 SOL.
- `enableFirstSwapWithMinFee` = `true`, so that a coin creator's first buy does not pay the anti-sniper fee.
- `tokenUpdateAuthority`: non-modifiable metadata (check the exact enum value in the SDK).

### Launchpad coin config (e.g. $MOON)
- Same settings, except:
- `creatorTradingFeePercentage` = 25 (FORGE is the creator).
- `creatorLiquidityPercentage` / `creatorPermanentLockedLiquidityPercentage`: a share of the post-graduation liquidity is assigned to the creator, **permanently locked**, so that FORGE keeps earning fees after graduation. The exact split is to be validated in test 2.
- `enableFirstSwapWithMinFee` = `true` (Hugo's first buy).
- `poolCreationFee` = 0: the client would otherwise pay its own creation fee on its own coin and lose the protocol share of it (SDK 1.5.13 accepts 0 as "no fee").

## Transaction sizes and priority fees

- Every transaction must fit in 1,232 bytes. A priority fee costs 12 bytes (`setComputeUnitPrice`) next to the unit limit core always sets: a swap goes from 819 to 831 bytes, a user coin launch fits even with the longest Metaplex metadata.
- The launchpad coin launch (durable nonce, creator wallet, first buy) is the tight one: name + symbol + URI share 148 bytes (`LAUNCH_METADATA_BUDGET_BYTES`). With a priority fee, core keeps the unit limit and the price up to 136 bytes of metadata, the price alone up to 144 (bounded for 1.4M compute units, the most the runtime applies without a limit), and no price beyond: the budget accepted at `/v1/configs` never shrinks.

## The Meteora referral

- The swap accepts a `referralTokenAccount`. The referral fee = 20% of the protocol share, deducted from Meteora's share. The partner share and the creator share do not change.
- The referral account is a token account of the quote currency (WSOL for a SOL pool), held by the FORGE revenue wallet (`FORGE_REVENUE_WALLET`, D34; the signer unwraps it and forwards the SOL to the multisig). It is a standalone token account of that wallet, not its associated account (the Jupiter claims land in the associated account and are booked separately): the signer's `--setup-revenue-referrals` command creates it with core's `buildCreateMeteoraReferralAccountTx` (`meteora-referral.ts`: `createAccountWithSeed` from the payer, then `InitializeAccount3` with the revenue wallet as owner; the payer is the only signer) and refuses an existing account that is not exactly that (docs/MAINNET.md section 5). Core refuses a swap whose referral account is held by anyone else when the environment has the revenue wallet.
- **Only when the swap goes through our own code** (`@forge/core`). When the trade goes through Jupiter, Jupiter collects the referral.

## The platform fee (0.3%; 0.5% through Jupiter after graduation)

- **Before graduation**: a SOL transfer instruction of 0.3% of the amount is added to the swap transaction built by `@forge/core`, to `FORGE_PLATFORM_FEE_WALLET`. On a buy: 0.3% of the SOL spent. On a sell: 0.3% of the quoted SOL out (not of the slippage minimum). The fee is always rounded up to the lamport (FORGE gains less than 1 lamport) and the fee transfer is the **last** instruction, so a sell pays it from the proceeds.
- **After graduation**: a Jupiter transaction cannot be modified. We use the **Jupiter integrator fee** (`referralAccount` + `referralFee` = 50 bps). The plugin passes `referralFee` as is to Ultra `/order`, which only accepts 50 to 255 bps (a 30 bps fee is refused, verified on 2026-10-17); core's `assertJupiterReferralFeeBps` checks the range and the template fails closed outside it. Jupiter keeps 20% of this fee, so FORGE keeps 0.4% of the volume. A Jupiter referral account must be created, along with token accounts for each currency Jupiter may collect in (at minimum SOL and USDC). Its partner is the revenue wallet (D34): the claims land in the revenue wallet's token accounts and the signer converts them to SOL for the multisig.
- The referral account must belong to **Jupiter's Ultra project** (`DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc`, referral program `REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3`) and be **created with a name** (`initialize_referral_account_with_name`, PDA `["referral", project, name]`). The plugin's fees land in the referral account's associated token accounts, which only `claim_v2` empties, and `claim_v2` refuses an unnamed account: an unnamed one could never claim them. Core's claim builder refuses another project and builds a v2 claim only for a named PDA (mainnet only; on devnet it refuses the cluster before any read).
- Creation (program source `program/programs/referral/src/instructions/initialize_referral_account_with_name.rs` and `lib.rs`, SDK 0.3.0 IDL): accounts `payer` (signer, pays the 274-byte account), `partner` (a plain system account, **not a signer**), `project`, `referral_account` (the PDA), the System program; argument `{ name }` with fewer than 20 characters (and at most 32 bytes, a seed); the share is the project's `default_share_bps`. The v2 collection accounts are the referral account's associated token accounts, created idempotently by anyone (the SDK's `initializeReferralTokenAccountV2`). Core builds all of it (`buildJupiterReferralSetupTx`, `jupiter-referral.ts`) and the signer's `--setup-revenue-referrals` command sends it with the payer as the only signer, on mainnet-beta only (docs/MAINNET.md section 5).

## Migration (graduation)

- Meteora's migration bots on mainnet only accept certain thresholds: 10 SOL, 750 USDC, 1,500 JUP, or at least $750 of quote currency. We impose **10 SOL**.
- **No bot on devnet**: use Meteora's manual migration tool (Meteora Invent / Studio) to test graduation.

## The fun-launch template (as found in the code)

- Trading: **Jupiter plugin** (`plugin.jup.ag`), with `referralAccount` / `referralFee` available in its types.
- Data (coin list, price, transactions, holders): `https://datapi.jup.ag` and the `wss://trench-stream.jup.ag/ws` stream, filtered by `NEXT_PUBLIC_POOL_CONFIG_KEY`. **API not publicly documented** (no docs, no SLA, no key).
- **On-chain fallback (FORGE template, `src/forge/data/`)**: Jupiter stays the primary source on mainnet. When the data API fails, times out (6 s) or returns nothing, and always on devnet, the coin lists, coin info and descriptions come from the site's own `GET /api/coins` route, which reads the chain through the FORGE RPC relay with the site's server token:
  - coin list: one `getPoolsByConfig` scan of the users config (core `listPoolStatesOfConfig`; the relay accepts this `getProgramAccounts` shape, discriminator at 0 and config at 72, for server tokens only, 30 units), plus the launchpad coin's own pool read directly (the launchpad coin config is open to anyone and is never scanned). Look-alikes are dropped (`isListedLaunchpadCoin`). Lists: trading coins newest first, trading coins from 10% curve progress, completed curves; 30 coins each;
  - per coin: price from the pool `sqrtPrice` (core `poolSpotPrice`), market cap from the mint supply, USD through the Pyth SOL/USD account (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, mainnet and devnet), curve progress and graduation from core, creation time from the activation point, name and symbol from the Metaplex metadata, image and description from the metadata JSON when it is on the site storage (`R2_PUBLIC_URL`), or, for the launchpad's own coin only, on the FORGE coin-meta route (`https://<FORGE app origin>/api/coin-meta/<slug>`, exact origin, https, no redirect); no other host is fetched, and an image is kept only when it is on `R2_PUBLIC_URL`;
  - caching: lists 15 s, one coin 10 s (CDN `s-maxage` as well), stale for up to 5 min on read errors, single-flight, small read budgets; a 30 s cooldown skips the data API after an outage;
  - not available on-chain: chart candles, holders, transactions, volumes and price changes. The chart, holders and transactions tabs show a "temporarily unavailable" state; trading through the FORGE panel never depends on the data API;
  - live updates: when the trench stream cannot be reached (2 failed connections), and always on devnet, the coin lists and coin info are polled every 15 s while the tab is visible.
  - Limit: the scan answer holds every pool of the config (about 750 bytes each); the relay caps a response at 1 MiB, so a config past roughly 1,300 pools cannot be listed on-chain (the route then answers 503 and the market shows its error state).
- Coin creation: server routes `/api/upload` (image + metadata on Cloudflare R2) and `/api/send-transaction`. The RPC key stays server-side.
- Variables: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `RPC_URL`, `POOL_CONFIG_KEY`.
- **Jupiter does not index devnet**: on devnet the FORGE template reads its coin data on-chain only (see above); charts, holders and transactions can only be tested on mainnet.

## Jupiter

- API key required (Jupiter developer portal). Free tier limited to 1 request per second.
- The Ultra API is replaced by Swap V2: use the current version.
- Jupiter transactions (Ultra `/order`, the plugin) cannot be modified.
- **The signer's swaps** (fee conversion, revenue conversions, $FORGE buyback; `apps/signer/src/jobs/jupiter-v2.ts`) use the Swap API V2 Router path, `GET https://api.jup.ag/swap/v2/build` (Metis routing only, no Jupiter swap fee, key in `x-api-key`). One call returns the quote and the raw instructions for the signing wallet: `inputMint`, `outputMint`, `amount`, `taker` (V2's name for `userPublicKey`), `slippageBps`, `wrapAndUnwrapSol=true`, `transactionVersion=0`. `/build` is ExactIn only (no `swapMode`) and has no `restrictIntermediateTokens` (Metis picks the intermediate tokens; the checks below do not depend on them). No platform fee, fee account, tip or payer is asked. The quote fields (`inAmount`, `outAmount`, `otherAmountThreshold`, `slippageBps`, `priceImpactPct`, `swapMode`) are validated as before. The signer then assembles the v0 transaction itself: every instruction decoded, only the taker signs; Jupiter's `computeBudgetInstructions` (a unit price, no limit) dropped for the signer's own pair (unit limit 1.2x the units a simulation at 1.4M consumes, price from `SIGNER_PRIORITY_FEE_*` capped by `CONVERT_MAX_PRIORITY_FEE_LAMPORTS` / `BUYBACK_MAX_PRIORITY_FEE_LAMPORTS`); each table of `addressesByLookupTableAddress` read through the signer's RPC, which must hold the listed addresses at the same index, the message compiled against the on-chain tables; the blockhash and its last valid height from the signer's RPC (`blockhashWithMetadata` unused). The bytes then pass the same checks as before: one ExactIn route instruction (V2 builds use `route_v2` / `shared_accounts_route_v2`) whose amounts, slippage and fee are bound to the quote, the simulation of every account the wallet holds, the kill switch, the journal before the broadcast.
- The Metis Swap API (`/swap/v1`: `/quote`, then `/swap` returning a transaction Jupiter assembled and priced with `priorityLevelWithMaxLamports`) is no longer maintained and superseded by Swap V2 (no sunset date announced, checked on 2026-10-17). `JUPITER_SWAP_API=v1` keeps it for one release as a rollback (a restart, no deploy); remove it once V2 has run a release on mainnet.
- Integrator fee: 50 to 255 bps (Ultra and the plugin); Jupiter keeps 20%, and chooses the currency it collects in.

## Sources

- SDK: `npm pack @meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, file `dist/index.d.ts`
- https://docs.meteora.ag/overview/products/dbc/what-is-dbc.md
- https://github.com/MeteoraAg/meteora-invent (scaffolds/fun-launch)
- https://developers.jup.ag/docs/ultra/add-fees-to-ultra
- https://developers.jup.ag/docs/swap/fees
- https://developers.jup.ag/docs/swap/build and https://developers.jup.ag/docs/api-reference/swap/build (`/build` request and response)
- https://developers.jup.ag/docs/swap/migration/metis-to-build (Metis to Swap V2)
- https://developers.jup.ag/docs/swap/advanced/compute-units (unit limit by simulation, capping the price)
- https://developers.jup.ag/docs/swap-api (Metis Swap API, no longer maintained)
- https://github.com/TeamRaccoons/referral (Jupiter referral program: `claim.rs`, `claim_v2.rs`)
- https://developers.jup.ag/docs/ultra/get-started
