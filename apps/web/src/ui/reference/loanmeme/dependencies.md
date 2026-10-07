# Rendering dependency review

Reviewed on 2026-10-07. The user explicitly authorized checking and installing the rendering dependencies, including the necessary `apps/web/package.json` and workspace lockfile changes.

## Decision

Install these exact versions for the future FORGE renderer:

| Package | Version | Use | License |
| --- | --- | --- | --- |
| `three` | `0.186.1` | Scene rendering, character animation, loaders, postprocessing | MIT |
| `cannon-es` | `0.20.0` | Visual scene physics | MIT |
| `lethargy` | `1.0.9` | Wheel inertia filtering | MIT |
| `@types/three` | `0.186.0` | Development-only TypeScript declarations | MIT |

The three runtime packages have no runtime dependencies. The following six packages are dependencies of `@types/three`; each was checked separately. They introduce no further dependencies.

| Package | Version | License |
| --- | --- | --- |
| `@dimforge/rapier3d-compat` | `0.12.0` | Apache-2.0 |
| `@tweenjs/tween.js` | `23.1.3` | MIT |
| `@types/stats.js` | `0.17.4` | MIT |
| `@types/webxr` | `0.5.24` | MIT |
| `fflate` | `0.8.3` | MIT |
| `meshoptimizer` | `1.1.1` | MIT |

Rapier and Tween are present through development declarations; the application does not import them as additional runtime engines.

## Security evidence and limits

- Queried Google Open Source Insights for each exact version on 2026-10-07. All ten responses contained an empty `advisoryKeys` list. The [API documentation](https://docs.deps.dev/api/v3/#getversion) explains why transitive dependencies must be queried separately.
- Direct-package responses: [Three](https://api.deps.dev/v3/systems/npm/packages/three/versions/0.186.1), [Cannon ES](https://api.deps.dev/v3/systems/npm/packages/cannon-es/versions/0.20.0), [Lethargy](https://api.deps.dev/v3/systems/npm/packages/lethargy/versions/1.0.9), [Three declarations](https://api.deps.dev/v3/systems/npm/packages/%40types%2Fthree/versions/0.186.0).
- Transitive-package responses: [Rapier](https://api.deps.dev/v3/systems/npm/packages/%40dimforge%2Frapier3d-compat/versions/0.12.0), [Tween](https://api.deps.dev/v3/systems/npm/packages/%40tweenjs%2Ftween.js/versions/23.1.3), [Stats declarations](https://api.deps.dev/v3/systems/npm/packages/%40types%2Fstats.js/versions/0.17.4), [WebXR declarations](https://api.deps.dev/v3/systems/npm/packages/%40types%2Fwebxr/versions/0.5.24), [fflate](https://api.deps.dev/v3/systems/npm/packages/fflate/versions/0.8.3), [meshoptimizer](https://api.deps.dev/v3/systems/npm/packages/meshoptimizer/versions/1.1.1).
- Downloaded the published archives from the npm registry and verified every archive's SHA-512 against its exact-version registry metadata. Those integrity values are retained in `pnpm-lock.yaml`. This verifies archive consistency; it is not an independent publisher-signature audit.
- Checked package manifests, licenses, and lifecycle scripts. None of the ten packages declares `preinstall`, `install`, or `postinstall`. Installation used `--ignore-scripts` throughout.
- Read Lethargy's complete small runtime and scanned Cannon ES and Three source for dynamic execution, network access, and browser-storage access. Lethargy operates on wheel deltas and timestamps. Three's asset loaders contain expected network requests for assets supplied by the application. This was a targeted review, not an exhaustive source audit of every dependency.
- No known advisory was found for the added versions at review time. This does not guarantee absence of undisclosed defects or future advisories.
- The workspace-wide `pnpm audit` request failed with `EACCES` when reaching the registry audit endpoint. GitHub's unauthenticated advisory API was rate-limited. No clean security result is claimed for the pre-existing workspace dependency tree.

## Maintenance and compatibility

- [Cannon ES](https://github.com/pmndrs/cannon-es) replaces the original `cannon@0.6.2`. It provides ESM and TypeScript support, but its selected release dates to August 2022. Migration must account for its convex-polyhedron constructor, cylinder orientation, and impulse conventions.
- [Lethargy](https://github.com/d4nyll/lethargy) has an October 2019 release date. Its bounded wheel-filtering implementation was retained for reference behavior, with the maintenance age recorded explicitly. Browser gesture testing remains necessary.
- Lethargy is CommonJS and does not ship declarations. Use `import lethargy from "lethargy"` and `new lethargy.Lethargy()`. A bare Node ESM named import fails. The declaration in `src/ui/types/lethargy.d.ts` covers the checked public methods.
- The modern Three release is not a drop-in replacement for the reference's `three@0.145.0`. Shader chunks, lighting, render targets, and color management need migration and visual verification.
- Do not add the old `cannon` package or `ore-three@5.0.0-beta3`. The latter is an older beta helper package, not a finding of malicious code. Any future bounded adaptation of MIT helper code must preserve its notices.
- No production development panel, remote script, third-party scene artwork, or model asset was added.

## Installation and validation

Native pnpm registry requests failed in this environment, while direct public archive downloads succeeded. Official pnpm `10.17.1` generated an isolated lockfile and installed the ten verified packages offline into a temporary store, with scripts disabled. Verified local archive indexes were associated with their corresponding registry identities in that temporary store.

The four importer entries and ten package/snapshot entries from that generated lockfile were merged into the existing workspace lockfile. The installed package directories were copied into the worktree's existing virtual store, with local dependency junctions recreated. Existing dependency versions, the global pnpm store, Git settings, credentials, and remote configuration were not changed. No committed path points into the temporary directory.

Checks passed:

- Workspace frozen-lockfile validation: `pnpm install --offline --lockfile-only --frozen-lockfile --ignore-scripts`, using the temporary cache and store.
- `pnpm --filter @forge/web run typecheck`.
- `pnpm --filter @forge/web run lint`.
- `pnpm --filter @forge/web run test`: the existing homepage test passes.
- `pnpm --filter @forge/web run build`: production build and static generation pass.
- Runtime smoke checks from `apps/web`: Three animation interpolation, minimal GLTF parsing, postprocessing imports, Cannon gravity simulation, and both Lethargy wheel directions.
- Strict TypeScript consumption of Three, its addons, Cannon ES, and the local Lethargy declaration.

The smoke checks were temporary verification commands, not new persistent tests of third-party implementation details. At the time of this dependency review no WebGL canvas was mounted. The subsequent [homepage implementation](../../home/IMPLEMENTATION.md) now mounts the renderer; its own validation and remaining visual checks are recorded separately.
