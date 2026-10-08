# @forge/core swap — buy and sell with referral and platform fee

_Generated 2026-10-08T23:29:07.465Z — devnet only._

Goal: run `buildBuyTx` / `buildSellTx` from `packages/core/src/swap.ts` end to end on devnet: DBC swap with the FORGE referral account plus a 30 bps SOL transfer to the platform fee wallet, signed by the trader only, confirmed by polling `getSignatureStatuses`.

## Setup

- Pool: [5Esvo4oihF3wbv9smAqBN34vEmF4AR3LqaiR7PePnZMr](https://solscan.io/account/5Esvo4oihF3wbv9smAqBN34vEmF4AR3LqaiR7PePnZMr?cluster=devnet) (test 3 config: 1% fee after a 99% anti-sniper schedule, `enableFirstSwapWithMinFee`, 25% creator share) — coin [Ha7iJz7R…](https://solscan.io/account/Ha7iJz7RiqiQUhpSSQfxWeTTCG35fbfSmv5s67GBVkT6?cluster=devnet)
- FORGE_METEORA_REFERRAL_ACCOUNT (devnet stand-in, WSOL ATA of the referral wallet): [6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1](https://solscan.io/account/6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1?cluster=devnet)
- FORGE_PLATFORM_FEE_WALLET (devnet stand-in): [JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V](https://solscan.io/account/JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V?cluster=devnet)
- Trader (signer and fee payer): [4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet)
- Slippage 100 bps; buy 10000000 lamports; sell = half of the coins bought.

## Swaps

| Swap | Amount in | Quoted out | evtSwap out | Platform fee | Platform wallet Δ | Referral Δ | evtSwap referralFee | Trader SOL Δ | Tx fee | Size | CU used / limit | Tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| buy | 10000000 | 3066084476598 | 3066084476598 | 30000 | 30000 | 4000 | 4000 | -10035000 | 5000 | 819 bytes | 50913 / 150000 | [tx 3CgtCWsu…](https://solscan.io/tx/3CgtCWsuYTZZ4eznxVntV2wffjwRoFUpfoEBE42ZHTpuZPHBeBSnU94dZwjPNcgG4LStc8GWdsNcuWRP3z7xfigF?cluster=devnet) |
| sell | 1533042238299 | 4907658 | 4907658 | 14723 | 14723 | 1982 | 1982 | 4887935 | 5000 | 797 bytes | 48754 / 150000 | [tx 4gTmozsZ…](https://solscan.io/tx/4gTmozsZ6xKfUFMLi8ZC4v3E2igWXrXqs2n5QLEU2yqDwMUTvZS3WNZn1oXs8AEGAM6ppSfJ7beeNTKLVrSRUCbp?cluster=devnet) |

- Instruction layout: setComputeUnitLimit, create WSOL ATA (idempotent), [buy: create coin ATA, wrap SOL + SyncNative], DBC swap (referral + instructions sysvar), close WSOL ATA, platform fee transfer.
- Deltas are read from each transaction’s own meta (pre/post balances), so other activity on the shared devnet wallets cannot affect them.

## Signatures

- buy: `3CgtCWsuYTZZ4eznxVntV2wffjwRoFUpfoEBE42ZHTpuZPHBeBSnU94dZwjPNcgG4LStc8GWdsNcuWRP3z7xfigF`
- sell: `4gTmozsZ6xKfUFMLi8ZC4v3E2igWXrXqs2n5QLEU2yqDwMUTvZS3WNZn1oXs8AEGAM6ppSfJ7beeNTKLVrSRUCbp`

## Checks

- OK — buy: evtSwap decoded, with referral
- OK — buy: platform fee wallet received exactly the quoted platform fee (30 bps, rounded up)
- OK — buy: platform fee = ceil(30 bps x SOL spent)
- OK — buy: referral account received exactly evtSwap.referralFee (> 0)
- OK — buy: referral = 20% of the protocol share
- OK — buy: output >= minAmountOut
- OK — buy: transaction within 1232 bytes
- OK — buy: compute units within the limit
- OK — sell: evtSwap decoded, with referral
- OK — sell: platform fee wallet received exactly the quoted platform fee (30 bps, rounded up)
- OK — sell: platform fee = ceil(30 bps x quoted SOL out)
- OK — sell: referral account received exactly evtSwap.referralFee (> 0)
- OK — sell: referral = 20% of the protocol share
- OK — sell: output >= minAmountOut
- OK — sell: transaction within 1232 bytes
- OK — sell: compute units within the limit
- OK — buy: trader SOL delta = -(amount + platform fee + tx fee + new coin ATA rent)
- OK — buy: trader received the coins of evtSwap
- OK — sell: trader SOL delta = evtSwap output - platform fee - tx fee
- OK — sell: trader sent the coins sold
- OK — refusal: buy on a migrated pool (test 2) -> POOL_GRADUATED
- OK — refusal: buy with a platform fee wallet that does not exist (not rent-exempt) -> PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT

**Result: PASS** — the core builders produce swaps that pay the referral and exactly the platform fee, within the size limit, and refuse graduated pools and a non rent-exempt fee wallet.

