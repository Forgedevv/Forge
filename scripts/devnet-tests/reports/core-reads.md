# @forge/core — claims, reads, payments, gating

_Generated 2026-10-08T23:18:59.731Z — devnet only._

Devnet integration of `packages/core/src/{reads,claims,payments,gating}.ts` against the wave-1 test pools (`pnpm --filter @forge/devnet-tests core:reads`).

## Reads (`listCoinsOfConfig`, `curveProgress`, `feeMetrics`, `isGraduated`)

| Config | Pool | Graduation | Progress | Quote reserve / threshold | Partner claimable | Creator claimable | Lifetime trading fees |
| --- | --- | --- | --- | --- | --- | --- | --- |
| test1.config [DYUmt6v1…](https://solscan.io/account/DYUmt6v1WukdYPadER4L5LJgGGuWMkQWqt9QpmJWjiiT?cluster=devnet) | [BcHSSiHk…](https://solscan.io/account/BcHSSiHk1yDF8BzWgCTt8Jujkxz2JC6aKStG774hTAh4?cluster=devnet) | trading | 198 bps | 198000000 / 10000000000 | 0 | 0 | 1600000 |
| test2.config [8XgjQ1vX…](https://solscan.io/account/8XgjQ1vXgGfhej4ebqSDJiBBeNLST6mN26ZqpudhP71b?cluster=devnet) | [FFmhczkt…](https://solscan.io/account/FFmhczktj2CeAoYrEnndurenYZe4Doc57np85JZDHd43?cluster=devnet) | migrated | 10000 bps | 1000000001 / 1000000000 | 7957185 | 1737887 | 10609580 |
| test3.config [BETHKRLQ…](https://solscan.io/account/BETHKRLQc6wRHsTG8Kd3SwbRu26zWrgme8NXWVUwXdWU?cluster=devnet) | [5Esvo4oi…](https://solscan.io/account/5Esvo4oihF3wbv9smAqBN34vEmF4AR3LqaiR7PePnZMr?cluster=devnet) | trading | 50 bps | 50000000 / 10000000000 | 30000000 | 10000000 | 40000000 |
| test3.config [BETHKRLQ…](https://solscan.io/account/BETHKRLQc6wRHsTG8Kd3SwbRu26zWrgme8NXWVUwXdWU?cluster=devnet) | [DSy99hNh…](https://solscan.io/account/DSy99hNhKKNYsUTmdEPt1N3TZDzmw5aWwvDmt3pXvKje?cluster=devnet) | trading | 49 bps | 49500000 / 10000000000 | 300000 | 100000 | 400000 |
| test4.config [6Qdx24Ak…](https://solscan.io/account/6Qdx24AkqEtQYcBNaKqswt4DUYeSZZYMk3qhfMChCKtd?cluster=devnet) | [DeQFNdtJ…](https://solscan.io/account/DeQFNdtJYA4SeY3HgJ55cHT2FpJNBHzc5A1Y3q25VBWV?cluster=devnet) | trading | 0 bps | 1 / 10000000000 | 1592000 | 0 | 1592000 |

Amounts in lamports. Progress = floor(quoteReserve × 10,000 / threshold), 10,000 once graduated.

## Gating (`getForgeBalance`)

- Fake $FORGE mint [ES4otaE7…](https://solscan.io/account/ES4otaE7FckJGJEKwpk3noaCZBt4FQZhuhWqUDdhuBEF?cluster=devnet)
- Holder [EARQA94F…](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet): 1000000000000000 raw units (6 decimals)
- Client [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet): 0 raw units
- Without FORGE_MINT: `{ enabled: false }`

## Payment (`buildPaymentTx` + `verifyPayment`)

- Cashbox stand-in: the `platformFee` throwaway wallet [JCuehMiy…](https://solscan.io/account/JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V?cluster=devnet) (passed as FORGE_CASHBOX_WALLET through the `env` option; no real cashbox on devnet).
- Payer: client [3zmm4YTr…](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet) — 1000000 lamports (0.001 SOL)
- Memo: `forge:job:4b534d56-6476-4a16-a916-a63e7bec6fdc` — [tx 5JByWwQc…](https://solscan.io/tx/5JByWwQceheghCN23C1ZWmJDRN7LnC2WVwm2oGvquN4Cd4NSG2DayMXZu182piZLNQDorxXWPGzmMPL1AM39Hmci?cluster=devnet)
- Cashbox balance when this run started: 11594029 lamports (0.011594029 SOL)
- verifyPayment (confirmed): confirmed (slot 508980070, finalized)
- verifyPayment (finalized required): confirmed (slot 508980070, finalized)
- verifyPayment, wrongAmount: invalid: amount_mismatch — Transfer of 1000000 lamports, expected 1000001
- verifyPayment, otherJob: invalid: memo_mismatch — Memo does not match forge:job:497fafb2-0a21-4067-9ecc-07ae43b1ddce
- verifyPayment, otherPayer: invalid: payer_not_signer — 4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs did not sign the transaction
- verifyPayment, otherRecipient: invalid: recipient_mismatch — No transfer to the cashbox J5hrCnpdoiywcDPn92BoYzuSAa1XHsVVERkcyrbrfBY6

## Partner claim (`buildPartnerClaimTx`)

- Pool [BcHSSiHk…](https://solscan.io/account/BcHSSiHk1yDF8BzWgCTt8Jujkxz2JC6aKStG774hTAh4?cluster=devnet) — [tx YJUcj9mn…](https://solscan.io/tx/YJUcj9mnbqUsntHDiGoprnUB6pvitJtJjtrXsHTV2oLjjo7Mnt9o48xJ8XqHj8srf5D8Z4jcdkFPMfaH94N28Md?cluster=devnet) (signed by the partner = feeClaimer)
- Claimable at build time: 1600000 lamports (0.0016 SOL); partnerQuoteFee after: 0
- Partner balance 60000000 → 60106560 lamports (claimed fees minus network fee and the base-token ATA rent created for the receiver; the temporary WSOL account rent is refunded on close).

## Checks

- OK — every wave-1 config lists its pool(s)
- OK — the migrated test 2 pool reads as migrated with 10,000 bps progress
- OK — readCoin agrees with listCoinsOfConfig
- OK — gating: the fake $FORGE holder has a positive balance, disabled without FORGE_MINT
- OK — payment verified (confirmed)
- OK — wrong amount / other job / other payer / other recipient are rejected
- OK — partner claim empties the partner fees of the pool

**Result: PASS** — reads, payments, gating and the partner claim behave as specified on devnet.

