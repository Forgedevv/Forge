# Test 3 — First buy paid by the client

_Generated 2026-10-07T17:53:59.879Z — devnet only._

Goal: confirm that a single transaction can create the pool (signed by forgeCreator) and make the first buy paid and signed by client, with tokens received by client; and that with `enableFirstSwapWithMinFee` the first buy pays the minimum fee under the anti-sniper schedule.

## Setup

- Config: [BETHKRLQc6wRHsTG8Kd3SwbRu26zWrgme8NXWVUwXdWU](https://solscan.io/account/BETHKRLQc6wRHsTG8Kd3SwbRu26zWrgme8NXWVUwXdWU?cluster=devnet) — [tx 4zCM9WWp…](https://solscan.io/tx/4zCM9WWp8YSgzXCaQ8ZHV5DG5gtR6BcwfSH18oFsgz2JQxVBxiBMvLUsJQKp9an6fP54cnNoe6zCpThP8F6e68kR?cluster=devnet)
- Fee scheduler: 9900 bps → 100 bps over 600 s (10 periods, linear), enableFirstSwapWithMinFee = true, creator share 25%
- forgeCreator: [EARQA94F…](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet); client: [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet); trader: [4C6MAy2P…](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet)
## Launch transaction

- Earlier attempt: pool [DSy99hNhKKNYsUTmdEPt1N3TZDzmw5aWwvDmt3pXvKje](https://solscan.io/account/DSy99hNhKKNYsUTmdEPt1N3TZDzmw5aWwvDmt3pXvKje?cluster=devnet) was created on-chain ([tx 2pSS1aMu…](https://solscan.io/tx/2pSS1aMu7VoyneAbaWEgbCPnZEwpV5kbJoYwHpdwzVWCBf2ZP85gNRfXXEFbu7csNaJX25zWR25BonJFqbkc3EwQ?cluster=devnet)) but the script lost the confirmation (RPC websocket rate limit, HTTP 429); the measurements below come from a fresh pool.
- [tx 66dwv2US…](https://solscan.io/tx/66dwv2US6nA4nm2jWQEAm6x9uvwuWkHYGt37KgC7iwLmLeRwq5dwMFkUTDDHFRaBcTBGKj7RpFvVJyC6JWG1GF3Y?cluster=devnet) — 1025 bytes (limit 1232)
- Pool [5Esvo4oihF3wbv9smAqBN34vEmF4AR3LqaiR7PePnZMr](https://solscan.io/account/5Esvo4oihF3wbv9smAqBN34vEmF4AR3LqaiR7PePnZMr?cluster=devnet), mint [Ha7iJz7RiqiQUhpSSQfxWeTTCG35fbfSmv5s67GBVkT6](https://solscan.io/account/Ha7iJz7RiqiQUhpSSQfxWeTTCG35fbfSmv5s67GBVkT6?cluster=devnet), creator in pool state: EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u
- Signatures after the signer side: EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u, Ha7iJz7RiqiQUhpSSQfxWeTTCG35fbfSmv5s67GBVkT6
- Signatures after the client side: 3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75, EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u, Ha7iJz7RiqiQUhpSSQfxWeTTCG35fbfSmv5s67GBVkT6
- Client SOL 120000000 → 68496560 (debit 51503440 lamports (0.05150344 SOL); buy 50000000 lamports (0.05 SOL))
- forgeCreator SOL 276256400 → 254674760 (pays the pool rent and the pool creation fee, not the buy)
- Client token balance: 15608216690980 (event outputAmount 15608216690980, SDK quote 15608216690980)
## Fees

| Swap | Amount in | On-chain total fee (tradingFee + protocolFee + referralFee) | Expected | Tx |
| --- | --- | --- | --- | --- |
| First buy (client, inside creation tx) | 50000000 | 500000 | 500000 (min fee 100 bps) | [tx 66dwv2US…](https://solscan.io/tx/66dwv2US6nA4nm2jWQEAm6x9uvwuWkHYGt37KgC7iwLmLeRwq5dwMFkUTDDHFRaBcTBGKj7RpFvVJyC6JWG1GF3Y?cluster=devnet) |
| Second buy (trader, right after) | 50000000 | 49500000 | ≈ 9900 bps (anti-sniper) | [tx 2BhFSR3q…](https://solscan.io/tx/2BhFSR3qp3tWzPrPCrjmVTaJAxh62JBrZ7MU75JdX9CGM4SmEaJNmgqnqM7as8RaNWcAVdTkWvAvts38VCTn4iqU?cluster=devnet) |

## Checks

- OK — one transaction creates the pool and performs the first buy
- OK — transaction fits the size limit
- OK — forgeCreator and the mint signed first, client signed last
- OK — pool creator is forgeCreator
- OK — tokens received by client
- OK — SOL debited from client (buy + tx fee + token account rents)
- OK — first buy pays the minimum fee (1%) despite the 99% anti-sniper fee
- OK — second buy pays the anti-sniper fee (> 50%)
- OK — SDK quote matches the on-chain output

**Result: PASS** — the client pays and signs the first buy inside the pool creation transaction, with the minimum fee. Plan A holds.

