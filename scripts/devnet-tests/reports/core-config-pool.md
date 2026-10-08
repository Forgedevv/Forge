# @forge/core — configs and launch coin with durable nonce

_Generated 2026-10-08T23:47:40.890Z — devnet only._

Goal: run the production path of `@forge/core` on devnet: both configs built from a LaunchpadSpec, a durable nonce account, and launch transactions (pool creation + first buy) built by `buildLaunchCoinTx`, partially signed by the creator wallet and the mint, serialized to base64, decoded, signed last by the client, checked with `assertSignedCopyOf`, sent and confirmed by polling `getSignatureStatuses`. The second launch reuses the nonce account.

## Wallets

- forgeCreator (pool creator, nonce authority, payer of the configs and the nonce account): [EARQA94F…](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet)
- client (owner: fee claimer + leftover receiver of both configs, fee payer, buyer): [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet)
## Transactions

| Step | Account | Transaction | Notes |
| --- | --- | --- | --- |
| createConfig (launchpad) | [HKn8RwgnguT8SisxfgnMg8EsPsJY2sq7PjnQ3UHvVjws](https://solscan.io/account/HKn8RwgnguT8SisxfgnMg8EsPsJY2sq7PjnQ3UHvVjws?cluster=devnet) | [tx iVHbj8LU…](https://solscan.io/tx/iVHbj8LUR68Q9x8KYJcfS2bREyG2m4eYCGUsrNt5JP5fki8yUN7cXXrqV2vCCSUeGChxs69orHRAuQ3TNH2U8Ls?cluster=devnet) | rent 5974080 lamports (0.00597408 SOL) |
| createConfig (launchpad coin) | [GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J](https://solscan.io/account/GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J?cluster=devnet) | [tx 62AL8GyP…](https://solscan.io/tx/62AL8GyPgHS8jgr7z3YUPETEEsttWQjJ9av8V1LkM3nxFpLCeNhxPmmqSQDUFoMQvbk6TxwTdosFjFyYsQHhQMLN?cluster=devnet) | rent 5974080 lamports (0.00597408 SOL) |
| createNonceAccount | [EjZBuz1PxVzhiyWLNxLzB5WqaXAE8XEUmUTs9Aijn7hs](https://solscan.io/account/EjZBuz1PxVzhiyWLNxLzB5WqaXAE8XEUmUTs9Aijn7hs?cluster=devnet) | [tx 2gSucgqx…](https://solscan.io/tx/2gSucgqxLo5vbr4pJdG1ErhD9QbL35F4k5zW123TmYiaX7hKuKiacyx5ZB9EwMPpY1QW9TwrkWXJN3GUb1DF2tiC?cluster=devnet) | rent 1056640 lamports (0.00105664 SOL), authority forgeCreator |
| createPoolWithFirstBuy, launch 1 (durable nonce) | [EFFfhc2MkK54xqLuwqfZwmzhYpkr3m2v6hot9ytkkHGe](https://solscan.io/account/EFFfhc2MkK54xqLuwqfZwmzhYpkr3m2v6hot9ytkkHGe?cluster=devnet) | [tx 3REBYu66…](https://solscan.io/tx/3REBYu669v1haBke8FhjGJokUyDHLMxXAgEPAvYYhR87Xu63LBaSpAX42YccP5wc4t4JUtFYjq89ihviHqkraLKq?cluster=devnet) | 1166 bytes, mint [GzH29ZXzPiKLZbYVJ7XnWC7inCbiiCUqcAp2Y97yhEHu](https://solscan.io/account/GzH29ZXzPiKLZbYVJ7XnWC7inCbiiCUqcAp2Y97yhEHu?cluster=devnet) |
| createPoolWithFirstBuy, launch 2 (durable nonce) | [EhbrgyW7mRS5QQr31HTMEQ4N5uc4SCD66ZUzP9cHiogn](https://solscan.io/account/EhbrgyW7mRS5QQr31HTMEQ4N5uc4SCD66ZUzP9cHiogn?cluster=devnet) | [tx WvYbCdNk…](https://solscan.io/tx/WvYbCdNk11PET5cven1XBEYFw83m3FdhuCaRF5bCPDgstcLrz1gU2CQGAYWjAg1tLB73k2mBJ5HPhTRJj58XAzt?cluster=devnet) | 1171 bytes, mint [CeLNzgZKHqJKRp9ZJAzt4xxBD7CCaAu6KcnNtnHCjTii](https://solscan.io/account/CeLNzgZKHqJKRp9ZJAzt4xxBD7CCaAu6KcnNtnHCjTii?cluster=devnet) |

## Signatures (full)

```
createConfig launchpad      iVHbj8LUR68Q9x8KYJcfS2bREyG2m4eYCGUsrNt5JP5fki8yUN7cXXrqV2vCCSUeGChxs69orHRAuQ3TNH2U8Ls
createConfig launchpad coin 62AL8GyPgHS8jgr7z3YUPETEEsttWQjJ9av8V1LkM3nxFpLCeNhxPmmqSQDUFoMQvbk6TxwTdosFjFyYsQHhQMLN
createNonceAccount          2gSucgqxLo5vbr4pJdG1ErhD9QbL35F4k5zW123TmYiaX7hKuKiacyx5ZB9EwMPpY1QW9TwrkWXJN3GUb1DF2tiC
launch 1 (durable nonce)    3REBYu669v1haBke8FhjGJokUyDHLMxXAgEPAvYYhR87Xu63LBaSpAX42YccP5wc4t4JUtFYjq89ihviHqkraLKq
launch 2 (durable nonce)    WvYbCdNk11PET5cven1XBEYFw83m3FdhuCaRF5bCPDgstcLrz1gU2CQGAYWjAg1tLB73k2mBJ5HPhTRJj58XAzt
```

## Launch 1

- First instruction: AdvanceNonceAccount; recentBlockhash 4kC6K5xuifhMtjHEbvLZMgpwjF3dLEXkHyYDtxLNWZdN = nonce before (4kC6K5xuifhMtjHEbvLZMgpwjF3dLEXkHyYDtxLNWZdN); nonce after CgGkb4C7ZyCCW3Kn5eZC8nyHeomkwV6AAqBxme11E5ef
- Signatures after the signer side: GzH29ZXzPiKLZbYVJ7XnWC7inCbiiCUqcAp2Y97yhEHu, EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Signatures after the client: 3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75, GzH29ZXzPiKLZbYVJ7XnWC7inCbiiCUqcAp2Y97yhEHu, EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Returned transaction checked with assertSignedCopyOf: not recorded (first run of this script, before the check was added)
- Pool creator: EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u; client tokens: 3158618642371 (quoted 3158618642371)
- Client SOL 117990000 -> 84904920 (debit 33085080 lamports (0.03308508 SOL))
- forgeCreator SOL 286965200 -> 286965200
- Network fee paid: 15000 lamports (0.000015 SOL); metadata account size 607 bytes


| Summary shown before signing | Lamports |
| --- | --- |
| firstBuyLamports | 10000000 |
| firstBuyFeeLamports | 100000 |
| poolCreationFeeLamports | 1000000 |
| poolAccountsRentLamports | 10581640 |
| metaplexFeeLamports | 10000000 |
| ownerTokenAccountRentLamports | 1488440 |
| ownerTemporaryLamports | 1488440 |
| networkFeeLamports | 15000 |
| networkFeeSource | cluster |
| ownerTotalLamports | 33085080 |
| ownerRequiredBalanceLamports | 34573520 |
| creatorTotalLamports | 0 |

## Launch 2

- First instruction: AdvanceNonceAccount; recentBlockhash CgGkb4C7ZyCCW3Kn5eZC8nyHeomkwV6AAqBxme11E5ef = nonce before (CgGkb4C7ZyCCW3Kn5eZC8nyHeomkwV6AAqBxme11E5ef); nonce after 2CweiskTUjp5Rr2pDDu9c45bx8qRsFnJgWrvz7MqMq2X
- Signatures after the signer side: CeLNzgZKHqJKRp9ZJAzt4xxBD7CCaAu6KcnNtnHCjTii, EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Signatures after the client: 3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75, CeLNzgZKHqJKRp9ZJAzt4xxBD7CCaAu6KcnNtnHCjTii, EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Returned transaction checked with assertSignedCopyOf: true
- Pool creator: EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u; client tokens: 3158618642371 (quoted 3158618642371)
- Client SOL 84899920 -> 51814840 (debit 33085080 lamports (0.03308508 SOL))
- forgeCreator SOL 286965200 -> 286965200
- Network fee paid: 15000 lamports (0.000015 SOL); metadata account size 607 bytes


| Summary shown before signing | Lamports |
| --- | --- |
| firstBuyLamports | 10000000 |
| firstBuyFeeLamports | 100000 |
| poolCreationFeeLamports | 1000000 |
| poolAccountsRentLamports | 10581640 |
| metaplexFeeLamports | 10000000 |
| ownerTokenAccountRentLamports | 1488440 |
| ownerTemporaryLamports | 1488440 |
| networkFeeLamports | 15000 |
| networkFeeSource | cluster |
| ownerTotalLamports | 33085080 |
| ownerRequiredBalanceLamports | 34573520 |
| creatorTotalLamports | 0 |

## Checks

- OK — launchpad config on-chain: fee claimer = leftover receiver = client, creator share 20%, 0.001 SOL creation fee, 10 SOL threshold, anti-sniper 99% -> 1% in 10 x 6 s, immutable metadata, first swap at minimum fee
- OK — launchpad coin config on-chain: same, creator share 25% (FORGE)
- OK — the launchpad config is refused as a launch coin config
- OK — fee recipient stand-ins are rent-exempt
- OK — launch 1: first instruction is nonceAdvance
- OK — launch 1: recentBlockhash = nonce value read before the launch
- OK — launch 1: the nonce advanced
- OK — launch 1: creator + mint signed on the signer side, the client signed last
- OK — launch 1: transaction fits the size limit
- OK — launch 1: pool creator is the FORGE creator wallet
- OK — launch 1: client received exactly the quoted tokens
- OK — launch 1: first buy paid the minimum fee (1%), as summarized
- OK — launch 1: client debit = summary.costs.ownerTotalLamports
- OK — launch 1: network fee = summary
- OK — launch 1: creator wallet not debited by the launch (needs no SOL)
- OK — launch 1: metadata account size = METADATA_ACCOUNT_SIZE
- OK — launch 2: first instruction is nonceAdvance
- OK — launch 2: recentBlockhash = nonce value read before the launch
- OK — launch 2: the nonce advanced
- OK — launch 2: creator + mint signed on the signer side, the client signed last
- OK — launch 2: transaction fits the size limit
- OK — launch 2: pool creator is the FORGE creator wallet
- OK — launch 2: client received exactly the quoted tokens
- OK — launch 2: first buy paid the minimum fee (1%), as summarized
- OK — launch 2: client debit = summary.costs.ownerTotalLamports
- OK — launch 2: network fee = summary
- OK — launch 2: creator wallet not debited by the launch (needs no SOL)
- OK — launch 2: metadata account size = METADATA_ACCOUNT_SIZE
- OK — launch 2: the returned transaction passed assertSignedCopyOf before sending
- OK — launch 2 used the nonce value left by launch 1 (nonce account reused)

**Result: PASS** — the configs and the durable-nonce launches built by @forge/core work end to end on devnet.

