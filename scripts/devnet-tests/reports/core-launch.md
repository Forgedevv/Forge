# @forge/core — launches without referral, user coin, seeded nonce

_Generated 2026-10-11T19:32:01.614Z — devnet only._

Goal: check on devnet the wave 4 launch changes of `@forge/core`: no referral on the first buy of `buildLaunchCoinTx` (and the finding behind it), the new `buildUserCoinLaunchTx`, and the seeded durable nonce account of `buildCreateNonceAccountWithSeedTx`.

## Finding: no referral on the first buy

Each launch transaction was simulated before sending (sigVerify off, no cost): as built by core, and with a referral token account put in the referral slot of the first buy. With the referral, the DBC program does not apply the first-swap minimum fee: the swap pays the anti-sniper fee and fails with `ExceededSlippage` (6002). Without it, the launch lands exactly at the quote. Core therefore never adds a referral to the first buy and refuses an explicit one.

| Launch | Without referral (as built) | With the referral [6xGTA1UB…](https://solscan.io/account/6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1?cluster=devnet) |
| --- | --- | --- |
| launchpad coin | succeeds | fails: {"InstructionError":[6,{"Custom":6002}]} |
| user coin | succeeds | fails: {"InstructionError":[6,{"Custom":6002}]} |

## Transactions

| Step | Account | Transaction | Notes |
| --- | --- | --- | --- |
| launchpad coin (owner client, creator forgeCreator) | [4q88uJFk3YaZtMipLQytWLFF4ZdAz1JEeNNo7M8eaJc1](https://solscan.io/account/4q88uJFk3YaZtMipLQytWLFF4ZdAz1JEeNNo7M8eaJc1?cluster=devnet) | [tx 3jhANnbY…](https://solscan.io/tx/3jhANnbY1ztGsMjW8N3XU4BGMTEwUAJdkCg6Z1dgecQdoMBfs8X9zJDUvQYpp258ooqraRvduZzBRtqEvB9cD47j?cluster=devnet) | 1085 bytes, config [GkTXTK17…](https://solscan.io/account/GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J?cluster=devnet) |
| user coin (wallet trader) | [DJxhj8WTdVsSUs1qh3gnypVRbwHjbpWCE3sHuUzqda6q](https://solscan.io/account/DJxhj8WTdVsSUs1qh3gnypVRbwHjbpWCE3sHuUzqda6q?cluster=devnet) | [tx 32mihJCt…](https://solscan.io/tx/32mihJCtwUWUeN3HDPj3oFBmZh1ef3AsYjBr3W3VVMFkcUwHHjk3XsBZEztApNGC2yerTfwaBTpEArguucfeVx1M?cluster=devnet) | 991 bytes, config [HKn8Rwgn…](https://solscan.io/account/HKn8RwgnguT8SisxfgnMg8EsPsJY2sq7PjnQ3UHvVjws?cluster=devnet) |
| seeded nonce creation | [BK5uFnZmK2vux8y3tfJVgRQSXnRZqsiT3QmUBvgaanBN](https://solscan.io/account/BK5uFnZmK2vux8y3tfJVgRQSXnRZqsiT3QmUBvgaanBN?cluster=devnet) | [tx 4Saoixv8…](https://solscan.io/tx/4Saoixv8DKRayu5XMn4ZweZj6xiTETfwsSVYUshLL9K9vuoTiR69wdnxuABbUGpCXGdNt5ugCstqGvkLsnwZzuSe?cluster=devnet) | seed `forge-core-launch-check-v1`, base forgeCreator, rent 1056640 lamports (0.00105664 SOL) |
| seeded nonce withdrawal | [BK5uFnZmK2vux8y3tfJVgRQSXnRZqsiT3QmUBvgaanBN](https://solscan.io/account/BK5uFnZmK2vux8y3tfJVgRQSXnRZqsiT3QmUBvgaanBN?cluster=devnet) | [tx H7WkaVwp…](https://solscan.io/tx/H7WkaVwpXq8RqSHrB3NAPjKow6dE5jiXi5zH9c2AzQMVY3pBTmZdSjWbuUxBNuQrDJwW5zYEp9pr8CL8w4R2rRd?cluster=devnet) | all lamports back to forgeCreator |

## Signatures (full)

```
launchpad coin        3jhANnbY1ztGsMjW8N3XU4BGMTEwUAJdkCg6Z1dgecQdoMBfs8X9zJDUvQYpp258ooqraRvduZzBRtqEvB9cD47j
user coin             32mihJCtwUWUeN3HDPj3oFBmZh1ef3AsYjBr3W3VVMFkcUwHHjk3XsBZEztApNGC2yerTfwaBTpEArguucfeVx1M
seeded nonce create   4Saoixv8DKRayu5XMn4ZweZj6xiTETfwsSVYUshLL9K9vuoTiR69wdnxuABbUGpCXGdNt5ugCstqGvkLsnwZzuSe
seeded nonce withdraw H7WkaVwpXq8RqSHrB3NAPjKow6dE5jiXi5zH9c2AzQMVY3pBTmZdSjWbuUxBNuQrDJwW5zYEp9pr8CL8w4R2rRd
```

## Launchpad coin

- Mint [4HBPtv6jonYpgJdrqAqgmwTVuGgBDSix1PAKeNokrzWM](https://solscan.io/account/4HBPtv6jonYpgJdrqAqgmwTVuGgBDSix1PAKeNokrzWM?cluster=devnet); pool creator EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Tokens received: 316705912271 (quoted 316705912271)
- First buy fee (event): 10000 lamports (0.00001 SOL); referral on the swap: false
- Payer SOL 35000000 -> 10914920 (debit 24085080 lamports (0.02408508 SOL))

| Summary shown before signing | Lamports |
| --- | --- |
| firstBuyLamports | 1000000 |
| firstBuyFeeLamports | 10000 |
| poolCreationFeeLamports | 1000000 |
| poolAccountsRentLamports | 10581640 |
| metaplexFeeLamports | 10000000 |
| ownerTokenAccountRentLamports | 1488440 |
| ownerTemporaryLamports | 1488440 |
| networkFeeLamports | 15000 |
| networkFeeSource | cluster |
| ownerTotalLamports | 24085080 |
| ownerRequiredBalanceLamports | 25573520 |
| creatorTotalLamports | 0 |

## User coin

- Mint [HTkXz2wzyVbR4tTLkqs4GEmW9Pai3mXTqsJBZVvEyMKK](https://solscan.io/account/HTkXz2wzyVbR4tTLkqs4GEmW9Pai3mXTqsJBZVvEyMKK?cluster=devnet); pool creator 4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs
- Tokens received: 316705912271 (quoted 316705912271)
- First buy fee (event): 10000 lamports (0.00001 SOL); referral on the swap: false
- Payer SOL 1900314069 -> 1876233989 (debit 24080080 lamports (0.02408008 SOL))

| Summary shown before signing | Lamports |
| --- | --- |
| firstBuyLamports | 1000000 |
| firstBuyFeeLamports | 10000 |
| poolCreationFeeLamports | 1000000 |
| poolAccountsRentLamports | 10581640 |
| metaplexFeeLamports | 10000000 |
| ownerTokenAccountRentLamports | 1488440 |
| ownerTemporaryLamports | 1488440 |
| networkFeeLamports | 10000 |
| networkFeeSource | cluster |
| ownerTotalLamports | 24080080 |
| ownerRequiredBalanceLamports | 25568520 |
| creatorTotalLamports | 0 |

## Checks

- OK — core refuses an explicit referral on the first buy (REFERRAL_UNSUPPORTED)
- OK — launchpad coin: the transaction as built (no referral) succeeds in simulation
- OK — launchpad coin: the same transaction with a referral on the first buy fails with ExceededSlippage
- OK — launchpad coin: the first buy carried no referral
- OK — launchpad coin: received exactly the quoted tokens
- OK — launchpad coin: first buy paid the minimum fee (1%), as summarized
- OK — launchpad coin: payer debit = summary.costs.ownerTotalLamports
- OK — launchpad coin: network fee = summary
- OK — launchpad coin: pool creator is the FORGE creator wallet
- OK — launchpad coin: the creator wallet was not debited
- OK — user coin: the transaction as built (no referral) succeeds in simulation
- OK — user coin: the same transaction with a referral on the first buy fails with ExceededSlippage
- OK — user coin: the first buy carried no referral
- OK — user coin: received exactly the quoted tokens
- OK — user coin: first buy paid the minimum fee (1%), as summarized
- OK — user coin: payer debit = summary.costs.ownerTotalLamports
- OK — user coin: network fee = summary
- OK — user coin: pool creator is the user
- OK — seeded nonce: the address re-derived from base + seed is the created one
- OK — seeded nonce: readNonce accepts it, authority = forgeCreator
- OK — seeded nonce: closed by the withdrawal
- OK — seeded nonce: only the fees were spent (rent came back)

**Result: PASS** — launches without referral land at the quote, the user coin builder works, and the seeded nonce account can be re-derived.

