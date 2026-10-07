# Devnet tests — summary

_Generated 2026-10-07T17:56:18.679Z — devnet only._

Results of the four on-chain tests of docs/DEVNET_TESTS.md (SDK @meteora-ag/dynamic-bonding-curve-sdk 1.5.13, devnet).

## Results

| Test | Goal | Status | Report | Failed checks |
| --- | --- | --- | --- | --- |
| test1 | Meteora referral | PASS | [test1-referral.md](./test1-referral.md) |  |
| test2 | Creator share on a dedicated config | PASS | [test2-creator-share.md](./test2-creator-share.md) |  |
| test3 | First buy paid by the client | PASS | [test3-first-buy.md](./test3-first-buy.md) |  |
| test4 | Platform fee in the swap | PASS | [test4-platform-fee.md](./test4-platform-fee.md) |  |

## Decisions and plan B

- test1 (Meteora referral): PASS — plan A stands, no change to @forge/core.
- test2 (Creator share on a dedicated config): PASS — plan A stands, no change to @forge/core.
- test3 (First buy paid by the client): PASS — plan A stands, no change to @forge/core.
- test4 (Platform fee in the swap): PASS — plan A stands, no change to @forge/core.

## Notes for @forge/core

- poolCreationFee = 0 is accepted by the SDK and the program: CLIENT_BOUNDS.poolCreationFeeSol.allowZero = true holds.
- Test 1: measured exactly the DEVNET_TESTS.md expectation (fee 1,000,000 lamports on 0.1 SOL; with referral protocol 160,000 / referral 40,000; partner 800,000 in both cases; creator 0).
- Test 2: creator = 25.00% of the non-protocol share across 3 buys and 1 sell; claim to receiver works; after migration the creator holds a permanently locked DAMM v2 position that accrues SOL fees, claimable to the multisig address.
- Test 2 ran with a 1 SOL migration threshold (budget); production keeps 10 SOL (Meteora mainnet bots). The program accepted 1 SOL (it only requires a threshold > 0).
- Migration on devnet was scripted (migrationDammV2CreateMetadata through the SDK anchor program object, with systemProgram/eventAuthority/program passed explicitly, then SDK migrateToDammV2); on mainnet Meteora bots do it. Post-migration swaps and the creator position fee claim use @meteora-ag/cp-amm-sdk 1.5.1 (claimPositionFee needs `tempWSolAccount` when a receiver is set and one side is SOL).
- claimCreatorTradingFeeToReceiver closes a temporary WSOL account owned by the creator: the receiver gets the fees plus that account rent (1,488,440 lamports on this devnet, 2,039,280 on mainnet).
- Test 3: createPoolWithFirstBuy in one 1,025-byte transaction; the pool creator and the base mint must sign (initializeVirtualPoolWithSplToken has `creator` as signer); the client is fee payer and buyer. With enableFirstSwapWithMinFee the first buy paid 1% (500,000 on 0.05 SOL) while the next buy paid 99% (49,500,000).
- Test 4: 30 bps transfer + swap with referral = 754 bytes (buy) / 722 bytes (sell), well under 1,232. First attempt failed because the fee wallet held 0 SOL: a transfer must leave the recipient rent-exempt (about 0.0009 SOL), so FORGE_PLATFORM_FEE_WALLET must hold SOL before the first fee (and @forge/core should assert it).
- In the swap event, `tradingFee` is the partner + creator share only; the total fee is tradingFee + protocolFee + referralFee. The DBC program emits events through self-CPI (eventAuthority), not `Program data:` logs: decode the inner instructions.
- RPC: the Helius devnet websocket rate-limited signature subscriptions (HTTP 429), making web3.js report "expired" for a landed transaction. The scripts confirm by polling getSignatureStatuses; @forge/core consumers should do the same or use a dedicated websocket endpoint.

## Fake $FORGE mint (devnet)

- Mint: [ES4otaE7FckJGJEKwpk3noaCZBt4FQZhuhWqUDdhuBEF](https://solscan.io/account/ES4otaE7FckJGJEKwpk3noaCZBt4FQZhuhWqUDdhuBEF?cluster=devnet) — 6 decimals, supply 1000000000000000 raw units
- Mint authority / holder of the whole supply: [EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet) (forgeCreator throwaway wallet)
- Holder token account: [B4vY74Lc…](https://solscan.io/account/B4vY74Lca8TySGMc7YRH9supk2X3HpF4rfp9fYJWEMdG?cluster=devnet)
Other agents: set `FORGE_MINT` to this address for devnet token-gating tests. Ask agent 1 to send test tokens from the holder wallet.

## Throwaway wallets (public keys)

| Wallet | Role | Address |
| --- | --- | --- |
| funder | receives faucet SOL and distributes it | [99swpsuxRVWXt8hdq5LcJYg7eZVQm76F9Y5y1iMmuFTp](https://solscan.io/account/99swpsuxRVWXt8hdq5LcJYg7eZVQm76F9Y5y1iMmuFTp?cluster=devnet) |
| referral | owner of the WSOL referral token account (stand-in for the multisig) | [DD2NhVr62mTQihSjFBG8VfejGhQn5BqRxRaZc2At6tfP](https://solscan.io/account/DD2NhVr62mTQihSjFBG8VfejGhQn5BqRxRaZc2At6tfP?cluster=devnet) |
| partner | feeClaimer / leftoverReceiver of the configs (stand-in for the client) | [Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa](https://solscan.io/account/Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa?cluster=devnet) |
| forgeCreator | pool creator (stand-in for a FORGE creator wallet) | [EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u](https://solscan.io/account/EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u?cluster=devnet) |
| trader | buys and sells | [4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs](https://solscan.io/account/4C6MAy2PshFx9RxyGz7JK3hLFfL1rJSYFhPGyCCjqTSs?cluster=devnet) |
| client | pays and signs the first buy (test 3) | [3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75](https://solscan.io/account/3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75?cluster=devnet) |
| multisigStandIn | receiver of the creator claims (test 2) | [J5hrCnpdoiywcDPn92BoYzuSAa1XHsVVERkcyrbrfBY6](https://solscan.io/account/J5hrCnpdoiywcDPn92BoYzuSAa1XHsVVERkcyrbrfBY6?cluster=devnet) |
| platformFee | receives the 30 bps platform fee (test 4) | [JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V](https://solscan.io/account/JCuehMiyc52WRmCkWRr3y9afrjYatVrDHpf9cHbvKY7V?cluster=devnet) |

Secret keys live only in `scripts/devnet-tests/.state/` (gitignored). Devnet only.

