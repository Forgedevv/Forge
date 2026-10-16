# @forge/core — DAMM v2 position fee claim

_Generated 2026-10-16T08:48:50.860Z — devnet only._

Goal: after a launchpad coin migrates, the fees of the FORGE creator wallet's permanently locked DAMM v2 position are claimed to the multisig (stand-in) by the core builder and by the signer's claims job.

## Setup

- Config: [6z5ZyP1RPKkkTSZDX4LZW788FfXJmK8B3iShnuSq3CSV](https://solscan.io/account/6z5ZyP1RPKkkTSZDX4LZW788FfXJmK8B3iShnuSq3CSV?cluster=devnet) — [tx 5zomUmhn…](https://solscan.io/tx/5zomUmhnNpcqhyEFwJnToKySoJ4HkfSysxHwWTBE6g3fXGU6kVp7RQ8CBCruugCVCkQkMufWstxqGS9WZdhQnTkk?cluster=devnet)
- Trading fee 100 bps, creatorTradingFeePercentage 25, LP 100% permanently locked (partner 75% / creator 25%), DAMM v2 FixedBps25; migration threshold **0.2 SOL** (test only; production 10 SOL).
- Pool: [HTC1NekHYMPwCBYvwqC8FrLCJtHYyu9okrPyw9ARL4fg](https://solscan.io/account/HTC1NekHYMPwCBYvwqC8FrLCJtHYyu9okrPyw9ARL4fg?cluster=devnet) — mint [AZDQ3S9B…](https://solscan.io/account/AZDQ3S9BC4d1qgwTjpiE4pEP6Vdvjrpwn2js1yu42iaG?cluster=devnet) — [tx 5e7RLKk1…](https://solscan.io/tx/5e7RLKk1gH9yetA1BbBwNREw3AC8aZYcGsME3xbJsLK4uDmq9qCTMCEQ1ekeUSSTuomjfkY66pMTZMCoaAwNLJuL?cluster=devnet)
- Creator (forgeCreator): [J4JyKSBK…](https://solscan.io/account/J4JyKSBKWq5gpD95uyB5fEsnK4GLe1WjbQsdKymyvmgU?cluster=devnet); payer (funder): [GiX5qvL6…](https://solscan.io/account/GiX5qvL6MA64MFSuSTiAfr2kCYohdbcYp4jdwLbuKQzG?cluster=devnet); receiver (multisigStandIn): [9LhDFvzS…](https://solscan.io/account/9LhDFvzScQYUinLx91EHzUts16jQ9ibLc31ongPpUSP6?cluster=devnet); trader: [EDATuep2…](https://solscan.io/account/EDATuep2MkJSVbqmyb1QNuYY3sJu6LLLTBD43r9HXx3d?cluster=devnet)
## Fill and migration

| Fill swap | Amount in | Tx |
| --- | --- | --- |
| 1 | 150000000 lamports (0.15 SOL) | [tx 3rZwtMRL…](https://solscan.io/tx/3rZwtMRL8wchPTe678wNA3bPKTVsYHvLimTCQmFgRhBvFkgkB7kKvtojYomjzsRBJ8UxmjF61MbKYns3gN3mmTR?cluster=devnet) |
| 2 | 54621212 lamports (0.054621212 SOL) | [tx 4kg71Ugq…](https://solscan.io/tx/4kg71UgqBaCNPzu9KiJoabbqgNmXCMDAbbYhDGxCjpFMCjTfCVbPnzXV3bpUBBGuSuFMVqyXMTdh2U8DtNMqinJs?cluster=devnet) |

- migrationDammV2CreateMetadata: [tx 37k1HhY5…](https://solscan.io/tx/37k1HhY54DukXhBjsAL4gwa9MgiqBCUKPXhR7xtkshWpbDXQ7svtj8ENLzPoL9ut264o97ByfkbqY44QLreP7imQ?cluster=devnet)
- migrateToDammV2: [tx vVcKiuYH…](https://solscan.io/tx/vVcKiuYH9eranx1FUENErB7Bm8yrWGHmPEB8Rgst6ALxj6st7Xf1qroo5wjyDLHr2DkC6YnX8fwTgBS3KR2qDdc?cluster=devnet) → DAMM v2 pool [4QQ1BqgL4NfcPTCCeuQLokdBJyxPb8G7T7c5hVKcyX2J](https://solscan.io/account/4QQ1BqgL4NfcPTCCeuQLokdBJyxPb8G7T7c5hVKcyX2J?cluster=devnet)
## Swaps on the migrated pool

| Swap | Amount in | Quoted fee | Tx |
| --- | --- | --- | --- |
| buy | 50000000 | 125000 | [tx 2G1pDW2r…](https://solscan.io/tx/2G1pDW2rtP3Kqxyqq8aEsbrHdmBGUANkhXBXXaXYC4vThYSCwDrk8iqDbSVvihx6D8Hf6fHjE8kG4KLFyEpezMLM?cluster=devnet) |
| sell | 419951883709653 | 542182 | [tx 5T2jDSSi…](https://solscan.io/tx/5T2jDSSiUPMjBsesndDwtPgH7j6teFRVdTGAVCqjRemLhL9UzzV8TXFhQv7c2onkwiCsvXerBGMSj5MQdAxPHUfV?cluster=devnet) |

## Core builder: buildCreatorPositionFeeClaimTx

- Positions: [D2Ar8sqoxJ7NjQfe3JKU9BvMX9UwuZKMhFyBV7xfemzx](https://solscan.io/account/D2Ar8sqoxJ7NjQfe3JKU9BvMX9UwuZKMhFyBV7xfemzx?cluster=devnet)
- [tx 37Ep1FCo…](https://solscan.io/tx/37Ep1FCovsTEfg8Bdscf5vjJ6fkrbbr3L1W3jnJWKTR7r4gvaNPkoRLAp9zDjWDuDjzww2NKibNogUcj9pjAhPU6?cluster=devnet) (795 bytes), fee 10000 lamports
- Pending SOL fees at build time: 133436 lamports (0.000133436 SOL); summary receiverQuoteLamports 1621876 lamports (0.001621876 SOL)
- Receiver 2000000 → 3621876 (Δ 1621876 lamports (0.001621876 SOL), includes the 1488440 lamports rent of the closed temporary WSOL account)
- Creator 155664760 → 155664760; payer Δ 2986880 lamports (0.00298688 SOL) (summary payerTotalLamports 2986880)
- Permanently locked liquidity 920492743601052556664100984086 → 920492743601052556664100984086; pending after 0
## Signer claims job (apps/signer/src/jobs/claims.ts)

| Swap | Amount in | Quoted fee | Tx |
| --- | --- | --- | --- |
| buy | 50000000 | 149987 | [tx 3sQ9tFTN…](https://solscan.io/tx/3sQ9tFTNmAnFzMjRv7a1yfmcfBHz3NiMRSdqbVri34zAHZbw8bfRVpT3QBraZnh9S82Bkpjdb1E3YKJFp5ZxoxhT?cluster=devnet) |
| sell | 331813702187347 | 176749 | [tx 5FeWgi6G…](https://solscan.io/tx/5FeWgi6GWHYNDM4tf9PYDybkmodGjz56U7nubSYDmzPxcyrDB9fSFAUgWxDfRTjkMsSvPvkXbWqLnDdYVgGaqjZu?cluster=devnet) |

- run 1: dbc claimed [tx 4dLAbP2P…](https://solscan.io/tx/4dLAbP2PKuEBkHGUEeKyU9NW2Xi198XLBiSpjFWe3QbxY8wmH7pBaeU8HMwAN1NemyRBpjrjY4uizCCeD6jk7njQ?cluster=devnet) (404040 lamports (0.00040404 SOL)) — receiver 3621876 → 4025916; alerts: pool_graduated
- run 2: dbc below_threshold; position claimed [tx 4wuZkqTY…](https://solscan.io/tx/4wuZkqTYigHtwqNqk2McS3y5q3bc7WwHkRR7b2YjGgh4iPhpZKK3pG3PJ67W7Wc52qdwHzVwEREE6PVvai2cdyga?cluster=devnet) (65347 lamports (0.000065347 SOL)) — receiver 4025916 → 5579703; alerts: none
- run 3: dbc below_threshold; position below_threshold — receiver 5579703 → 5579703; alerts: none
## Checks

- OK — core derives the DAMM v2 pool the migration created
- OK — core finds exactly one creator position, permanently locked
- OK — the position accrued SOL fees from the swaps
- OK — the stand-in vault received at least the pending fees plus the temporary WSOL rent
- OK — the creator wallet balance did not change (read-only signer)
- OK — the payer paid the fee and the rents of the summary (first claim: coin account + WSOL account)
- OK — nothing is pending after the claim
- OK — the position stays permanently locked with the same liquidity
- OK — signer run 1 claims the DBC creator share accrued during the fill
- OK — signer run 2 claims the position fees through the position claim policy
- OK — the stand-in vault received the position fees of run 2
- OK — signer run 3 sends nothing (below threshold, journaled)
- OK — no unexpected alert

**Result: PASS** — the creator position fees of a migrated pool reach the vault through the core builder and the signer job.

