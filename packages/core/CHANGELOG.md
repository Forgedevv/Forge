# Changelog — @forge/core

All notable changes to `@forge/core`. Versions follow semantic versioning. Consumers (the
launchpad template, the signer, the web app) pin an exact version, never a range.

## 0.1.0 — unreleased

First version meant for publication to GitHub Packages (`pnpm --filter @forge/core
publish:packages`, which runs typecheck, lint, tests and build first). Not published yet.

### Added

- `addresses.ts`: FORGE addresses read from the environment, `requireAddresses([...])`.
- `constants.ts`: business constants from `@forge/shared`, SDK bounds, exact SOL/lamport helpers.
- `validate.ts`: on-chain parameter validation of both configs (SDK and FORGE bounds).
- `config.ts`: `buildLaunchpadConfig(spec)` and `buildLaunchpadCoinConfig(spec)` return the SDK
  `ConfigParameters` plus `feeClaimer`, `leftoverReceiver` (both the client wallet,
  `spec.ownerWallet`) and `quoteMint` (SOL), built with `buildCurve` and validated before they
  are returned (`ValidationError` otherwise). `buildCreateConfigTx` returns the unsigned
  `createConfig` transaction; the config keypair is the caller's.
- `pool.ts`: `buildLaunchCoinTx` builds the launch of the launchpad coin
  (`createPoolWithFirstBuy`): the FORGE creator wallet and the mint sign on the signer side, the
  client is fee payer and buyer and signs last. Optional durable nonce (`nonceAdvance` first,
  nonce value as `recentBlockhash`), compute budget instructions, on-chain checks of the config
  (it must be the client's launchpad coin config), size check, and a summary of every lamport
  the client pays (`toOwnerTransactionSummary` maps it to the shared `OwnerTransactionSummary`).
- `tx.ts`: `confirmSignature` (polling `getSignatureStatuses` with a deadline), base64
  (de)serialization of partially signed transactions, `transactionSignature`, signer and size
  helpers, `computeBudgetInstructions`, `readNonce`, `buildCreateNonceAccountTx` (rent read from
  the cluster), `assertRentExempt`.

### Settings chosen for the configs

Not fixed by the docs; each is a named constant in `config.ts`:

- Curve: `buildCurve`, 1,000,000,000 SPL tokens with 6 decimals, 20% of the supply migrated,
  migration to DAMM v2 at exactly 10 SOL, no migration fee, immutable metadata.
- Anti-sniper (`spec.antiSniper`): linear fee scheduler from 99% to `spec.tradingFeeBps` in
  10 steps over 60 seconds. The first buy of each pool pays the ending fee
  (`enableFirstSwapWithMinFee`).
- Post-graduation liquidity, all permanently locked: the creator gets the same percentage as its
  trading fee share (`spec.coinCreatorSharePct` on the launchpad config, 25% for FORGE on the
  launchpad coin config), the partner (client) the rest.
- Migrated DAMM v2 pool fee: `MigrationFeeOption.FixedBps25` (0.25%).

### Devnet

`scripts/devnet-tests/reports/core-config-pool.md`: both configs, a nonce account and the
durable-nonce launch, end to end (all checks pass; the client's debit equals the summary).
