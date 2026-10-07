# Test 4 — Platform fee in the swap

_Generated 2026-10-07T17:54:01.083Z — devnet only._

Goal: confirm that a 30 bps SOL transfer can be added in the same transaction as the swap (with referral), on both buy and sell, within the Solana transaction size limit.

## Setup

- Config: [6Qdx24AkqEtQYcBNaKqswt4DUYeSZZYMk3qhfMChCKtd](https://solscan.io/account/6Qdx24AkqEtQYcBNaKqswt4DUYeSZZYMk3qhfMChCKtd?cluster=devnet) — [tx 3siVCwgS…](https://solscan.io/tx/3siVCwgSBBjHvDFVm6aWreoNHCPAWDXiVo2R4kdiG2gCEJ9PUqvAvCdXcr2r4oxri3RC12MLC1a4MJdum1NCWvdK?cluster=devnet) (trading fee 100 bps, no creator share)
- Pool: [DeQFNdtJYA4SeY3HgJ55cHT2FpJNBHzc5A1Y3q25VBWV](https://solscan.io/account/DeQFNdtJYA4SeY3HgJ55cHT2FpJNBHzc5A1Y3q25VBWV?cluster=devnet) — mint [64dUXYZU…](https://solscan.io/account/64dUXYZULnHWbBFzs8G8z7JHeVaCAUK1HcALVfcA4Cba?cluster=devnet) — [tx 5aDshNtx…](https://solscan.io/tx/5aDshNtxqewL512efguWmyq3em2arhp7urvjACXhwN3QqgkMnrFXPjgWDRmniLU7CxgLjbUcUXXCX7CPMe65o2Eh?cluster=devnet)
- Referral WSOL token account: [6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1](https://solscan.io/account/6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1?cluster=devnet) (already existed)
- Platform fee wallet: [JCuehMiy…](https://solscan.io/account/JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V?cluster=devnet); trader: [4C6MAy2P…](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet)
## Swaps

| Swap | Amount in | Platform fee (30 bps) | Platform wallet Δ | Referral Δ | Trader SOL Δ | Tx fee | Size | Tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| buy | 100000000 | 300000 | 300000 | 40000 | -101793440 | 5000 | 754 bytes | [tx 2oNYeHDv…](https://solscan.io/tx/2oNYeHDvCGLsyH8oTCSL94kmuE6DUv2sVrDYbyfGGKfDLLSPTpo1Kd476Wqm4TxZicAWrcgJhLxaw5JjBHwcTM6R?cluster=devnet) |
| sell | 30766240111089 | 294029 | 294029 | 39600 | 97710970 | 5000 | 722 bytes | [tx 3zx7p4Qs…](https://solscan.io/tx/3zx7p4QsErtyzGKpoyXpnX5LWivPqjar3c9U5HuvCoYehZBXKbPnPbrdu7dQcj74gbUtyGqE7RbM2E4gwuZDAJ7V?cluster=devnet) |

- Sell: SDK quoted 98009999 lamports out (platform fee computed on the quote), on-chain outputAmount 98009999.
- Instruction layout: [SystemProgram.transfer to platform fee wallet] + SDK swap instructions (ATA creation, wrap SOL, swap, unwrap).

## Checks

- OK — buy: platform fee received in the swap transaction
- OK — buy: referral still credited
- OK — buy: transaction within the size limit
- OK — sell: platform fee received in the swap transaction
- OK — sell: referral still credited
- OK — sell: transaction within the size limit
- OK — sell: trader received the SOL of the sale minus platform fee and tx fee

**Result: PASS** — the platform fee transfer fits in the swap transaction on buy and sell, alongside the referral. Plan A holds.

