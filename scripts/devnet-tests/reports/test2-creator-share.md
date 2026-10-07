# Test 2 — Creator share on a dedicated config

_Generated 2026-10-07T17:55:32.168Z — devnet only._

Goal: confirm that the creator wallet earns `creatorTradingFeePercentage` and can claim it to another address, and that the creator keeps earning from its permanently locked liquidity after migration.

## Setup

- Config: [8XgjQ1vXgGfhej4ebqSDJiBBeNLST6mN26ZqpudhP71b](https://solscan.io/account/8XgjQ1vXgGfhej4ebqSDJiBBeNLST6mN26ZqpudhP71b?cluster=devnet) — [tx 2yxbpLqP…](https://solscan.io/tx/2yxbpLqPdutUpr5Pjx6gxNRewir6SYGkE5P8kXsTn4Kb2Nd7zXRYfXQ7GiBAkDNjzUwKtxuaNamzTMsDu1HdtUvA?cluster=devnet)
- Trading fee 100 bps, creatorTradingFeePercentage 25, partner locked 50% / creator locked 50% of post-migration liquidity, migration DAMM v2 (fixed 25 bps)
- Migration threshold: **1 SOL** instead of the production 10 SOL, to keep the devnet budget small (the SDK and program only require a threshold > 0; mainnet bots require 10 SOL, which is enforced in @forge/core).
- Pool: [FFmhczktj2CeAoYrEnndurenYZe4Doc57np85JZDHd43](https://solscan.io/account/FFmhczktj2CeAoYrEnndurenYZe4Doc57np85JZDHd43?cluster=devnet) — mint [tzcZtpFf…](https://solscan.io/account/tzcZtpFfGoHVYF9TZBVm2Kaw5wRFzfomyjVABZ7YKH7?cluster=devnet) — [tx 4mJAMDVY…](https://solscan.io/tx/4mJAMDVYb1CveDdpASMv1MuHHiaWPdxfc9tJDCGo2dCH3Qrs99PrmwZU4pAkr2NbbvUnicL8bJG7fLmc2GHyTVdX?cluster=devnet)
- Pool creator (forgeCreator): [EARQA94F…](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet); creator recorded in pool state: EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Partner / feeClaimer: [Gvit1eRK…](https://solscan.io/account/Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa?cluster=devnet); trader: [4C6MAy2P…](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet); receiver (multisigStandIn): [J5hrCnpd…](https://solscan.io/account/J5hrCnpdoiywcDPn92BoYzuSAa1XHsVVERkcyrbrfBY6?cluster=devnet)
## Trades before migration

| # | Kind | Amount in | Tx | Event tradingFee | creatorQuoteFee Δ | partnerQuoteFee Δ | protocolQuoteFee Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | buy | 100000000 | [tx 3Xp6kf6P…](https://solscan.io/tx/3Xp6kf6Pe5kvZme6em5B7w7XXFe983HGbVuv7syTTmSvS3mwZnp5dQ7Re2AQ5iQYmJbZQWBxTwkHRZPsQRzYVZAC?cluster=devnet) | 800000 | 200000 | 600000 | 200000 |
| 2 | buy | 150000000 | [tx kwqTr17p…](https://solscan.io/tx/kwqTr17pwJCS1pA3utFSzbLTh8UuiF3dyoTB42obv2ehg4KGp2hvm2HH6FLgbDBqRAqgZKb2nWrKk9s8vcR5YNj?cluster=devnet) | 1200000 | 300000 | 900000 | 300000 |
| 3 | sell | 227259642007853 | [tx 4vkQ3ASK…](https://solscan.io/tx/4vkQ3ASKg8j8LCDTruuuixL6uZ4s5sbjzNDgqo7WW9afdDiXxhQmKi5ytGo3F8rDMG9D9PpASi3Skh2aHNzwadRc?cluster=devnet) | 1258032 | 314508 | 943524 | 314507 |
| 4 | buy | 50000000 | [tx 4L1Htbe2…](https://solscan.io/tx/4L1Htbe23sFRvWaAYAbhDHwDLpSK9idaNa1Dsg1quQitaM6Qg2n4VVgAt8zTiqkjpDikSs9h1QVi7ELCgk2Z6WQP?cluster=devnet) | 400000 | 100000 | 300000 | 100000 |

- Creator accrued 914508 lamports (0.000914508 SOL), partner accrued 2743524 lamports (0.002743524 SOL) → creator = 25.00% of the non-protocol share (expected 25%).

## Creator claim to receiver

- [tx 2JirhomS…](https://solscan.io/tx/2JirhomSqaUhbGrdVSmu72GzFLByApwQCLzNSpdGwTpjrG1S9qHT5GPduBsX5u4qyRHN8toxQv7UyaznWk2m1wkB?cluster=devnet) — creatorQuoteFee 914508 → 0
- Receiver balance 0 → 2402948 (Δ 2402948 lamports (0.002402948 SOL); includes the 1488440 lamports rent of the closed temporary WSOL account)
- Transaction fee paid by the creator wallet: 5000 lamports
## Curve fill and migration

| Fill swap | Amount in | Tx |
| --- | --- | --- |
| 1 | 500000000 lamports (0.5 SOL) | [tx 5tAkdWHh…](https://solscan.io/tx/5tAkdWHhwzk5TXxpvbb9YtTzmrsopjHRg8PyVMrbC5rf3Tn5W1dfs5ZaUzky5KvsuCwSd7KeRuKSFADfrqhk6SoS?cluster=devnet) |
| 2 | 387390467 lamports (0.387390467 SOL) | [tx 3Tur4gW3…](https://solscan.io/tx/3Tur4gW3fWfX4yG2hMue32ENxR8cuBDTAsv277KkjQFeMjgka7FngUJ6s4HdjG9iMUQXYhtXLdtYKzzMMtf4z7CQ?cluster=devnet) |

- Final quoteReserve 1000000001 lamports (1.000000001 SOL), migrationProgress 2, isMigrated 0
- migrationDammV2CreateMetadata: [tx 2F2pam46…](https://solscan.io/tx/2F2pam46dJfaGYqiiAG1M3cXv1P7Tb4EsaqDZJdpdYpiQXFRGwxrV8oiHifyfEwvAc2cdAWi9hPXBcR1JRzRZyVv?cluster=devnet)
- migrateToDammV2: [tx 5SnkrjN7…](https://solscan.io/tx/5SnkrjN7uBzWcCbx4pamkvCiguC3DgqpdsWwANmhtQjaoZ5TvFv5VxtRfpdFk6JcnoLrprvjwdKHTYPctfs9Gzuj?cluster=devnet) → DAMM v2 pool [4yHo8wu7rGJQ12AMYB7uxBkVA2LJUeSYFqztJLw7aFkZ](https://solscan.io/account/4yHo8wu7rGJQ12AMYB7uxBkVA2LJUeSYFqztJLw7aFkZ?cluster=devnet) (config [7F6dnUcR…](https://solscan.io/account/7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd?cluster=devnet))
- Position NFT mints: [9zhAPTvS…](https://solscan.io/account/9zhAPTvS6ihBEZ4Ej5hzGP6CduVZTcXtJs15FoGtdRUs?cluster=devnet) / [BRKgxB9s…](https://solscan.io/account/BRKgxB9sWaJzKCJQG24jfY5SCq99UUmhmNku2Kr2wdWt?cluster=devnet)
## Post-migration swaps and creator position

| Swap | Amount in | Quoted out | Quoted fee | Tx | Size |
| --- | --- | --- | --- | --- | --- |
| buy (SOL → token) | 50000000 | 9500226695801 | 125000 | [tx 22ZwVW3W…](https://solscan.io/tx/22ZwVW3WcHSs95eTYSZWSpH9EaC8yEgf39gjBboXj39ybWRt3wvjLc68CkppLhJTF74VmLeHJER85V7UrZUwfXcp?cluster=devnet) | 640 bytes |
| sell (token → SOL) | 404750061284664 | 711047044 | 1952225 | [tx 5dVXVTRL…](https://solscan.io/tx/5dVXVTRLg9jHAwxzxAnXWDfkQPCzS9iHnofcDN254zafnpu8g35oqkAQUkFC9oXWtgTSeiXxnPdofMMs6AqkWCsr?cluster=devnet) | 618 bytes |

| Creator position | Permanently locked liquidity | Pending fee SOL (before swaps) | Pending fee SOL (after swaps) | Pending fee token (after) |
| --- | --- | --- | --- | --- |
| [38iaevsp…](https://solscan.io/account/38iaevspKEYUEbUYL5yA1AxSBx3XBtMf9w2o18cbNALF?cluster=devnet) | 4116568165138960358144621872091 | 0 | 830890 | 0 |

- claimPositionFee to receiver: [tx 5MRKxaqE…](https://solscan.io/tx/5MRKxaqEp4Kanfjb9t5xnk42hkkreafSF7ppEGAqJQv1TmXsNTzrvw2UvbMiNWqiobvU4xiy5mC5VBStJg2trF2S?cluster=devnet) — receiver SOL Δ 2319330 lamports (0.00231933 SOL), receiver token Δ 0
## Checks

- OK — creator share ≈ 25% of the non-protocol fees before migration
- OK — claim empties creatorQuoteFee
- OK — claimed amount lands on the receiver (+ rent of the temporary WSOL account)
- OK — curve completed and migrated to DAMM v2
- OK — creator owns a permanently locked position on the DAMM v2 pool
- OK — creator position accrues SOL fees from post-migration swaps
- OK — position fees claimed to the receiver

**Result: PASS** — the creator share and the post-migration creator liquidity fees work as the revenue model assumes. Plan A holds.

