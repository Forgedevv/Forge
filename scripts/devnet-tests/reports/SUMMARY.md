# Devnet tests — summary

_Generated 2026-10-07T15:28:58.090Z — devnet only._

Results of the four on-chain tests of docs/DEVNET_TESTS.md (SDK @meteora-ag/dynamic-bonding-curve-sdk 1.5.13, devnet).

## Results

| Test | Goal | Status | Report | Failed checks |
| --- | --- | --- | --- | --- |
| test1 | Meteora referral | NOT RUN | [test1-referral.md](./test1-referral.md) |  |
| test2 | Creator share on a dedicated config | NOT RUN | [test2-creator-share.md](./test2-creator-share.md) |  |
| test3 | First buy paid by the client | NOT RUN | [test3-first-buy.md](./test3-first-buy.md) |  |
| test4 | Platform fee in the swap | NOT RUN | [test4-platform-fee.md](./test4-platform-fee.md) |  |

## Decisions and plan B

- test1 (Meteora referral): not run yet — plan B if it fails: Keep only the 0.3% platform fee (no Meteora referral). Loss ≈ 0.04% of the volume going through our button.
- test2 (Creator share on a dedicated config): not run yet — plan B if it fails: Swap the roles on the launchpad coin config: FORGE as feeClaimer (partner), the client as creator. To be validated with the team.
- test3 (First buy paid by the client): not run yet — plan B if it fails: FORGE creates the pool; the client buys in a separate transaction right after, with the anti-sniper active (enableFirstSwapWithMinFee is then useless for the client).
- test4 (Platform fee in the swap): not run yet — plan B if it fails: Use an address lookup table if the transaction exceeds the size limit; if a wallet shows a blocking warning (to be tested on mainnet), display the fee before signing or lower the rate.

## Notes for @forge/core

- Test 2 ran with a 1 SOL migration threshold (budget); production keeps 10 SOL (Meteora mainnet bots). The program only requires a threshold > 0.
- Migration on devnet was scripted (migrationDammV2CreateMetadata through the SDK anchor program + SDK migrateToDammV2); on mainnet Meteora bots do it. Post-migration swaps and the creator position fee claim use @meteora-ag/cp-amm-sdk 1.5.1.
- claimCreatorTradingFeeToReceiver closes a temporary WSOL account owned by the creator: the receiver gets the fees plus that account rent (≈ 0.00204 SOL).
- createPoolWithFirstBuy: the pool creator and the base mint must sign (initializeVirtualPoolWithSplToken has `creator` as signer); the client is the fee payer and the buyer.

## Fake $FORGE mint (devnet)

Not created yet (run `pnpm mint:forge`).

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

