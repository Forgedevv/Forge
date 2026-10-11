# Signer routes on devnet (configs, durable-nonce launch)

_Generated 2026-10-11T11:05:18.147Z — devnet only._

In-process run of `POST /v1/configs` and `POST /v1/launch-coin/prepare` (apps/signer/src/routes) on devnet: real keystore (throwaway, generated in `.state`), real @forge/core, in-memory database stand-in. The client wallet signs the prepared transaction last and sends it.

## Accounts

| Role | Address |
| --- | --- |
| Client (owner, fee claimer, fee payer of the launch) | [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet) |
| Signer payer wallet (keystore) | [GK7mapcH…](https://solscan.io/account/GK7mapcHPXNNCQSePmzi3gfYTb92a8PZfqwAfqg1o3Ho?cluster=devnet) |
| Creator wallet (keystore, `creator:<launchpadId>`) | [HPbGhM9E…](https://solscan.io/account/HPbGhM9E1jFvJTzy7XjgA4B9DfGh96fFnsQ5e8h3heJ5?cluster=devnet) |
| Launchpad config | [F88hFvqv…](https://solscan.io/account/F88hFvqvX4qwz8TqEDyiPxaLDkRPLNQLZ3ygaUTz5fSm?cluster=devnet) |
| Launchpad coin config | [BECZRm82…](https://solscan.io/account/BECZRm82D3W7yfgeNbhGrp3oxH4Dk9Uu5FgHFrwGugGx?cluster=devnet) |
| Durable nonce account (authority = creator) | [6M8yoLfH…](https://solscan.io/account/6M8yoLfHRuCaEu2ppDiuTaZDaxp6N76ZVWZxLUtyKG8t?cluster=devnet) |
| Coin mint | [G9uaesSk…](https://solscan.io/account/G9uaesSkUJH8Q4kFSFkCTrmxnkJVr1uNL9U2FCNKSXoW?cluster=devnet) |
| Pool | [VAtGqyn6…](https://solscan.io/account/VAtGqyn644uJ2cGtjpbqvK7f6RoSR9UbEcqZYeLgiyr?cluster=devnet) |

## Transactions

| Step | Signature |
| --- | --- |
| Launchpad config creation | [tx 5J8yNCfV…](https://solscan.io/tx/5J8yNCfVR77C7KD7vwBYE1ZhjZd85DaCbbNA7EwyCkhHeLVbAi71buhw28vsb1AyJJF7yB1WnL7hu8vMurzJT38r?cluster=devnet) |
| Launchpad coin config creation | [tx 2BH5aHiU…](https://solscan.io/tx/2BH5aHiUuJE6GvZthezEYbPZ5u1hom3ZhamvGBaC1Whqh6NZUTiGT5F5CxAhF6wpPp797gUsPbjm51bZ2dsS2Dyo?cluster=devnet) |
| Nonce account creation | [tx vYRzT198…](https://solscan.io/tx/vYRzT198wbKFV8iLTZ5NxYkfjDzq8SP4PJHs6ychC9x8QhCWtfLXDqrtyiTJUXEyHVJ5wcJJYMwacq1vQdPHgz4?cluster=devnet) |
| Launch (pool + first buy, signed by the client last) | [tx 4YShvznR…](https://solscan.io/tx/4YShvznRsqMdtTCJ5nZKvTzMAe31jDY8niVMJGf5Pawr5ndoJzvqwuiZ34tAvzWVYmNaxZMHwRh3DNcqu636Fymr?cluster=devnet) |

## Finding: no referral on the first buy

With a Meteora referral token account on the first buy, the DBC program does not apply the first-swap minimum fee: the swap pays the anti-sniper fee and fails with `ExceededSlippage`, even at 10% slippage. Without a referral it lands exactly at the quote. The route therefore passes no referral on the first buy (core's default would add FORGE_METEORA_REFERRAL_ACCOUNT): change request filed for @forge/core.

| Same launch, simulated (sigVerify off, no cost) | Result |
| --- | --- |
| With the referral [6xGTA1UB…](https://solscan.io/account/6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1?cluster=devnet) | fails: {"InstructionError":[7,{"Custom":6002}]} (ExceededSlippage) |
| Without a referral | succeeds |

Note: a first prepare of this launchpad (mint BCX6LC8zmDvbm18znhN7J6Kn7qU1LdX7wKhVkschY5tC) carried the referral; the client send was refused by the preflight simulation (ExceededSlippage), nothing landed and the nonce did not advance. That prepared transaction was removed from the devnet journal by hand before this run (two transactions on one nonce value are mutually exclusive anyway).

## Checks

| Check | Result |
| --- | --- |
| Configs: fee claimer = client, creator share 25% (coin config) / spec (launchpad) | true |
| Configs retry: same addresses, nothing sent | true |
| Prepare retry: same partially signed transaction | true (fresh run) |
| Launch landed: mint, pool, creator = keystore creator, client holds the coin | true |
| Client coin balance (raw) | 3158618642371 |
| Launch slot | 509880850 |
| Referral on the first buy | none |
| Prepare after the launch refused (409 coin_already_launched) | true |
| Alerts raised | coin_already_launched |

## Spend

| Wallet | Spent |
| --- | --- |
| Payer (two config rents, the nonce rent, fees) | 13034800 lamports (0.0130348 SOL) |
| Client (pool accounts, Metaplex fee, first buy, fees) | 32085080 lamports (0.03208508 SOL) |
| Total (limit 0.1 SOL) | 45119880 lamports (0.04511988 SOL) |

**Result: PASS** — configs, durable-nonce launch and idempotency verified on devnet

