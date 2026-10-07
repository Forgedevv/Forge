# Test 1 — Meteora referral

_Generated 2026-10-07T17:53:50.248Z — devnet only._

Goal: confirm that a swap with `referralTokenAccount` gives 20% of the protocol share (HOST_FEE_PERCENT) to the referral account, without touching the partner share.

## Setup

- Config: [DYUmt6v1WukdYPadER4L5LJgGGuWMkQWqt9QpmJWjiiT](https://solscan.io/account/DYUmt6v1WukdYPadER4L5LJgGGuWMkQWqt9QpmJWjiiT?cluster=devnet) — [tx 5JEMCjMp…](https://solscan.io/tx/5JEMCjMpxVLbGUMMRkoKSnxw8qSmws4MyieiRarY9XiST9zfa9w3x5b9tU58vtf4anncY8RiPHF1dkJ1PKKfezPd?cluster=devnet)
- Trading fee 100 bps, creatorTradingFeePercentage 0, quote SOL, pool creation fee 0 SOL
- poolCreationFee = 0 was ACCEPTED by the SDK and the program (INTERFACES.md `allowZero: true` holds).
- Pool: [BcHSSiHk1yDF8BzWgCTt8Jujkxz2JC6aKStG774hTAh4](https://solscan.io/account/BcHSSiHk1yDF8BzWgCTt8Jujkxz2JC6aKStG774hTAh4?cluster=devnet) — mint [37QBSjz9…](https://solscan.io/account/37QBSjz9BdfiaN6BZt5rmU7a9nkxDSpB7F5BKiY1sCUR?cluster=devnet) — [tx 5r2h7qBb…](https://solscan.io/tx/5r2h7qBbZdvxomVFBQipk8ot4hLgjFkjqD9i326Lr8h5r963NJuZ1tgSwKAw6WjpJ9jmC4SfvFL3skoGNhh49euM?cluster=devnet)
- Pool creator (forgeCreator): [EARQA94F…](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet)
- Partner / feeClaimer: [Gvit1eRK…](https://solscan.io/account/Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa?cluster=devnet)
- Referral WSOL token account: [6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1](https://solscan.io/account/6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1?cluster=devnet) (owner [DD2NhVr6…](https://solscan.io/account/DD2NhVr62mTQihSjFBG8VfejGhQn5BqRxRaZc2At6tfP?cluster=devnet)) — [tx 3hgkSp65…](https://solscan.io/tx/3hgkSp65JZ916iaZRgn9iWcQ2Cysj6pAW44tP7Aq9fDmWhFn7v4b9DsqFykASnUQYNXBRC6YWytyG7wBDrvdmvAA?cluster=devnet)
- Trader: [4C6MAy2P…](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet)
## Swaps

| Swap | Amount in | Tx | Size |
| --- | --- | --- | --- |
| Buy with referral | 100000000 lamports (0.1 SOL) | [tx osE5wEyb…](https://solscan.io/tx/osE5wEybjpXsfCMP8YUzq7wmKovLke28uNDQrFFz9Ru911JE2ehyismuo4nBHr1W5154SGTt85p9bY1TX2K7JGD?cluster=devnet) | 705 bytes |
| Buy without referral | 100000000 lamports (0.1 SOL) | [tx TyG7G88L…](https://solscan.io/tx/TyG7G88Ly9rqrgy4YCx1peLKiiFWkNX5fm98ga5EzqSPrBsUD5YUZUkE52MBDJ5Dw3NYxybiJhwnYZLJ8e7o8cn?cluster=devnet) | 663 bytes |

## Measured fee deltas (lamports)

| Quantity | With referral (measured) | Expected | Without referral (measured) | Expected |
| --- | --- | --- | --- | --- |
| Referral token account | 40000 | 40000 | 0 | 0 |
| partnerQuoteFee | 800000 | 800000 | 800000 | 800000 |
| protocolQuoteFee | 160000 | 160000 | 200000 | 200000 |
| creatorQuoteFee | 0 | 0 | 0 | 0 |
| metrics.totalTradingQuoteFee | 800000 |  | 800000 |  |
| metrics.totalProtocolQuoteFee | 160000 |  | 200000 |  |

## SDK quote vs on-chain swap event

| Swap | Quote tradingFee / protocolFee / referralFee | Event tradingFee / protocolFee / referralFee |
| --- | --- | --- |
| with referral | 800000 / 160000 / 40000 | 800000 / 160000 / 40000 |
| without referral | 800000 / 200000 / 0 | 800000 / 200000 / 0 |

## Checks

- OK — referral receives 20% of the protocol share with referral
- OK — referral receives nothing without referral
- OK — partner share identical with and without referral
- OK — partner share = 80% of the fee
- OK — protocol share reduced by the referral share
- OK — protocol share without referral = 20% of the fee
- OK — creator share stays 0

**Result: PASS** — the referral earns 20% of the protocol share and the partner share is unchanged. Plan A holds.

