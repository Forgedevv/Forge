# Signer routes on devnet (configs, durable-nonce launch)

_Generated 2026-10-11T19:47:22.954Z — devnet only._

In-process run of `POST /v1/configs` and `POST /v1/launch-coin/prepare` (apps/signer/src/routes) on devnet: real keystore (throwaway, generated in `.state`), real @forge/core, in-memory database stand-in. The client wallet signs the prepared transaction last and sends it.

## Accounts

| Role | Address |
| --- | --- |
| Client (owner, fee claimer, fee payer of the launch) | [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet) |
| Signer payer wallet (keystore) | [8EpWmygF…](https://solscan.io/account/8EpWmygFWmSitmJTXMhsHRGxZmTCSQK3Vq7FvvsvQhnB?cluster=devnet) |
| Creator wallet (keystore, `creator:<launchpadId>`) | [FBuDCHuY…](https://solscan.io/account/FBuDCHuYPLEoeQGWjtdHtjqQunibJytWZQHGADBbJxBP?cluster=devnet) |
| Launchpad config | [HX3zNVze…](https://solscan.io/account/HX3zNVzeiPjy3DyW3Jc7PWWgv4ZTUfjgEc7JW9C8JTAs?cluster=devnet) |
| Launchpad coin config | [3jTbghAd…](https://solscan.io/account/3jTbghAdpEWAibc6bNPgZfoD8JJHL2afVHwfGTz95A1u?cluster=devnet) |
| Durable nonce account (authority = creator) | [4tomWXk1…](https://solscan.io/account/4tomWXk1yPE6TZsJxwydTb6f7v8qD2z5BgKdzuDbCShk?cluster=devnet) |
| Coin mint | [A86AWpzR…](https://solscan.io/account/A86AWpzRcWUP18DFsedgLqNsVp4ypg8UhyzA1koGq4NJ?cluster=devnet) |
| Pool | [B8BDaKMi…](https://solscan.io/account/B8BDaKMi9VUaNq93Wm34EgkDQk4DWMAaZV5Dr8Quapjt?cluster=devnet) |

## Transactions

| Step | Signature |
| --- | --- |
| Creation payment (client -> stand-in cashbox, memo forge:job:<jobId>) | [tx 47QRfkg2…](https://solscan.io/tx/47QRfkg2T4Tf64w9KnfeBLRWyCZyWiR49KC952eBfTxNgrERBix4Jiu86HvUTc684b2Kg2tCSSUWgj2aG8sVuYFU?cluster=devnet) |
| Launchpad config creation | [tx 65eQBCgG…](https://solscan.io/tx/65eQBCgGwGkKJXFeaGGs3ZcimS1Hgdf4w2biz7xwtHSYBPQ2B2QYezeTHgiiWSnVrGBPo4i4yDGwDdtR1HpA2jJh?cluster=devnet) |
| Launchpad coin config creation | [tx yjTCnHg7…](https://solscan.io/tx/yjTCnHg7PHsLH2oY1Q16P5X7cDa6AM13JsQgXaMk8Be9hgWVhQrJLy6daz4byuset4TjkX5dvLkU2zCbFWsMLij?cluster=devnet) |
| Nonce account creation | [tx isF8zoGh…](https://solscan.io/tx/isF8zoGhz6gL1P4L3vqpYuawRy2aH3KVdLgHBYH28Kk5GdnXAFyZSaYD7KZgxrD7nD2TKVC3WZgCL2kLG2C3RMz?cluster=devnet) |
| Launch revocation (nonce advance by the creator wallet) | [tx 2vwzXq9i…](https://solscan.io/tx/2vwzXq9i5u1fYhwjGW2Lwr8KuiE1uzHeHvUmjHkcGyaySK7uKghQRWqTumXQuQ8CiDMJdibYLX29C6sGH7rVWEfh?cluster=devnet) |
| Launch (pool + first buy, signed by the client last) | [tx 2B9ZEs75…](https://solscan.io/tx/2B9ZEs75USabziHY5hD3RHPRvg2d2zUeCaBc4qdCBgMPoQJXM7D8tNzjFWK1gc61yfmMWcZg5txptHBgKNpfqDps?cluster=devnet) |

## Checks

| Check | Result |
| --- | --- |
| Creation payment proven on-chain (finalized) and journaled before the first payer spend | true |
| Same payment claimed for another amount refused (409 payment_not_verified, nothing sent) | true |
| Configs: fee claimer = client, creator share 25% (coin config) / spec (launchpad) | true |
| Configs retry: same addresses, nothing sent | true |
| Prepare retry: same partially signed transaction | true |
| Launch landed: mint, pool, creator = keystore creator, client holds the coin | true |
| Client coin balance (raw) | 3158618642371 |
| Launch slot | 510012613 |
| Referral on the first buy | none |
| Revocation: the cluster refuses the revoked transaction, prepare rebuilds a new mint | true |
| Prepare after the launch refused (409 coin_already_launched) | true |
| Alerts raised | launch_revoked, coin_already_launched |

## Spend

| Wallet | Spent |
| --- | --- |
| Payer (two config rents, the nonce rent, fees, the revocation fee) | 13044800 lamports (0.0130448 SOL) |
| Client (payment, pool accounts, Metaplex fee, first buy, fees) | 33090080 lamports (0.03309008 SOL) |
| Total (limit 0.1 SOL) | 46134880 lamports (0.04613488 SOL) |

**Result: PASS** — payment proof, configs, durable-nonce launch, revocation and idempotency verified on devnet

