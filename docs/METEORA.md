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
| List a config's coins | `getPoolsByConfig(config)` | plan B if the Jupiter data goes down |
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

## The Meteora referral

- The swap accepts a `referralTokenAccount`. The referral fee = 20% of the protocol share, deducted from Meteora's share. The partner share and the creator share do not change.
- The referral account is a token account of the quote currency (WSOL for a SOL pool), held by the multisig.
- **Only when the swap goes through our own code** (`@forge/core`). When the trade goes through Jupiter, Jupiter collects the referral.

## The platform fee (0.3%)

- **Before graduation**: a SOL transfer instruction of 0.3% of the amount is added to the swap transaction built by `@forge/core`, to `FORGE_PLATFORM_FEE_WALLET`. On a buy: 0.3% of the SOL spent. On a sell: 0.3% of the expected SOL (computed from the quote, with the same tolerance as the slippage).
- **After graduation**: a Jupiter transaction cannot be modified. We use the **Jupiter integrator fee** (`referralAccount` + `referralFee` = 30 bps). Jupiter keeps 20% of this fee. A Jupiter referral account must be created, along with token accounts for each currency Jupiter may collect in (at minimum SOL and USDC).

## Migration (graduation)

- Meteora's migration bots on mainnet only accept certain thresholds: 10 SOL, 750 USDC, 1,500 JUP, or at least $750 of quote currency. We impose **10 SOL**.
- **No bot on devnet**: use Meteora's manual migration tool (Meteora Invent / Studio) to test graduation.

## The fun-launch template (as found in the code)

- Trading: **Jupiter plugin** (`plugin.jup.ag`), with `referralAccount` / `referralFee` available in its types.
- Data (coin list, price, transactions, holders): `https://datapi.jup.ag` and the `wss://trench-stream.jup.ag/ws` stream, filtered by `NEXT_PUBLIC_POOL_CONFIG_KEY`. **API not publicly documented**: plan an on-chain plan B with `getPoolsByConfig`.
- Coin creation: server routes `/api/upload` (image + metadata on Cloudflare R2) and `/api/send-transaction`. The RPC key stays server-side.
- Variables: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `RPC_URL`, `POOL_CONFIG_KEY`.
- **Jupiter does not index devnet**: the interface can only be tested on mainnet.

## Jupiter

- API key required (Jupiter developer portal). Free tier limited to 1 request per second.
- The Ultra API is replaced by Swap V2: use the current version.
- Jupiter transactions cannot be modified.
- Integrator fee: Jupiter keeps 20%, and chooses the currency it collects in.

## Sources

- SDK: `npm pack @meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, file `dist/index.d.ts`
- https://docs.meteora.ag/overview/products/dbc/what-is-dbc.md
- https://github.com/MeteoraAg/meteora-invent (scaffolds/fun-launch)
- https://developers.jup.ag/docs/ultra/add-fees-to-ultra
- https://developers.jup.ag/docs/ultra/get-started
