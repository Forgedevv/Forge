# 05 — SIGNER (agent 5)

**You own**: `apps/signer`.
**You read**: `PLANEXECUTE.md`, `docs/INTERFACES.md` (§5, §7, §8), `docs/METEORA.md`, `docs/SECURITY.md` (sections 5 to 8), `docs/OPERATIONS.md`.

You build the only service that holds FORGE keys. It runs alone on VPS 2. Every line of code here can lose money: always prefer refusal to approximation.

## Components

```
apps/signer/src/
├── server.ts          # private API: HMAC + timestamp, builder IP only
├── keystore.ts        # wallets encrypted at rest (creators, payer, cashbox, buyback bot)
├── routes/
│   ├── configs.ts     # POST /v1/configs
│   └── launch.ts      # POST /v1/launch-coin/prepare (durable nonce)
├── jobs/
│   ├── claims.ts      # every 24 h: creator share of each pool → multisig
│   ├── cashbox.ts     # every 24 h: cashbox surplus → multisig; keeps a buffer
│   ├── refunds.ts     # failed jobs, failed_stage = 'build', attempts = 2 → refund → refunded
│   ├── buyback.ts     # small random $FORGE buys, max slippage 1%, tokens → multisig
│   ├── convert.ts     # Jupiter fees received in other currencies → SOL
│   └── watch.ts       # monitoring: creator transfer, unexpected outflows, low balances
└── alerts.ts          # Telegram
```

## To do

- [ ] `keystore.ts`: generate one creator wallet per launchpad, encrypted storage (`SIGNER_KEYSTORE_PASSPHRASE`), only the identifier (`creator_wallet_ref`) goes into Supabase. Never a key in the logs.
- [ ] `server.ts`: HMAC verification + timestamp ≤ 60 s, reject everything else. The signer **re-reads** the job, spec and payment from Supabase; it ignores any address or amount in the request body.
- [ ] `/v1/configs`: refuses if the payment is not `confirmed` or the spec is out of bounds (`validate` from core); creates the 2 configs (`config.ts` from core) with the payer wallet; idempotent (if already created for this job, returns the existing addresses).
- [ ] `/v1/launch-coin/prepare`: creates the dedicated creator wallet, a durable nonce account, builds `buildLaunchCoinTx` from core, signs as creator + mint, returns the partially signed transaction.
- [ ] `claims.ts`: `buildCreatorClaimTx` to `FORGE_MULTISIG_VAULT` for each pool where FORGE is creator, including liquidity fees after graduation (depending on the result of test 2).
- [ ] `refunds.ts`: refunds from the cashbox the exact amount paid, to the payer wallet, only once (idempotent via `payments.refund_signature`).
- [ ] `buyback.ts`: withdraws the day's amount from the multisig via the Squads spending limit to the bot's wallet, buys $FORGE in several small amounts at random times, sends the tokens back to the vault. Respects `buyback_paused`. Before the $FORGE launch: simulation mode that logs without buying.
- [ ] `convert.ts`: converts Jupiter fees received in other currencies to SOL.
- [ ] `watch.ts`: immediate alert on any `transferPoolCreator` touching one of our pools, any unexpected outflow from the vault or the cashbox, low payer balance.
- [ ] The signer **never** calls `transferPoolCreator`.

## Tests

- [ ] HMAC tests: invalid signature, timestamp too old, replay → rejected.
- [ ] Devnet tests: configs, launch preparation with durable nonce, signing by a simulated client wallet, claims to a test vault, refund.
- [ ] Idempotency test: calling each route twice creates nothing in duplicate.
- [ ] Buyback in simulation mode on devnet with the fake $FORGE.

## Dependencies

`@forge/core` (agent 1). Supabase (agent 3): until then, local schema from `INTERFACES.md` §5.

## Report

_To be filled in at the end of the task._
