# Changelog — @forge/shared

All notable changes to `@forge/shared`, published on npm as `@forgedevv/shared` together with
`@forgedevv/core` (same version). Versions follow semantic versioning. Changes before 0.3.0 are
listed in the `@forge/core` changelog.

## 0.3.0 — 2026-10-17

### Changed (Jupiter fixes)

- `FEES.jupiterIntegratorFeeBps` is 50 bps, was 30. It is the Jupiter Plugin `referralFee` after
  graduation; Jupiter Ultra refuses any value outside 50..255 bps (checked by `@forge/core`
  `assertJupiterReferralFeeBps`), and keeps 20% of it. `FEES.platformFeeBps` (30 bps, FORGE's own
  buy button) is unchanged.
