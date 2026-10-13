# @forgedevv/core

The FORGE transaction core: it builds the Meteora Dynamic Bonding Curve configs, the launchpad coin
launch, buys and sells with the FORGE platform fee and referral, creator fee claims, payment checks
and the read helpers used by FORGE launchpad sites. Every function that builds a transaction
returns it **unsigned**: the user signs in their wallet.

Inside the FORGE monorepo this package is `@forge/core`. It is published on the public npm registry
as `@forgedevv/core` (with its contracts package `@forgedevv/shared`), and client projects install
it through an npm alias pinned to an exact version, so their code keeps importing `@forge/core`:

```json
{
  "dependencies": {
    "@forge/core": "npm:@forgedevv/core@0.1.0",
    "@forge/shared": "npm:@forgedevv/shared@0.1.0"
  }
}
```

No `.npmrc`, registry setting or token is needed to install it.

```ts
import { buildBuyTx, PLATFORM_FEE_BPS } from '@forge/core';
// Browser-light entry point (only @solana/web3.js): checks a launch transaction before signing.
import { verifyLaunchCoinTransaction } from '@forge/core/launch-check';
```

- ESM only, Node 20+, TypeScript declarations included.
- On-chain amounts are `bigint` / `BN` raw units; percentages are basis points.
- FORGE addresses (multisig, referral accounts, platform fee wallet) are read from the environment,
  never hardcoded.

## Releases

Versions follow semantic versioning and every consumer pins an exact version. See `CHANGELOG.md`.

Releases are made from the monorepo with `node scripts/publish-core.mjs`: it builds both packages
without source maps, rewrites the workspace dependency to the exact npm alias, packs them, checks
the tarballs (no tests, sources, source maps, `.env`, `.npmrc` or secrets; name, version, exports,
license) and runs `npm publish --dry-run`. A real publish needs `--publish` and an `NPM_TOKEN`
provided by the operator in the environment.

## License

UNLICENSED. Copyright (c) 2026 FORGE. All rights reserved: the package is published so FORGE
launchpads can install it, and no license is granted to use, copy, modify or distribute it.
