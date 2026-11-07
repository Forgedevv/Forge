# Continuous integration

The workflow is `.github/workflows/ci.yml`. It has no secrets, no deployment and read-only
permissions (`contents: read`). It runs on every pull request and on every push to `main`. A new
run on the same ref cancels the previous one.

## What it runs

One job, named **`verify`** (this is the name of the status check), on `ubuntu-latest`:

1. Check out, set up pnpm (version taken from `packageManager` in the root `package.json`) and
   Node.js (version taken from `.nvmrc`), with the pnpm store cached.
2. `pnpm install --frozen-lockfile`: fails if `pnpm-lock.yaml` is out of date.
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build`

Each step is the root script, which runs the matching task in every workspace through Turborepo
(`turbo.json`). `typecheck`, `test` and `build` first build `packages/shared` and `packages/core`;
the second and later steps reuse that work from the Turborepo cache of the same run.

The runner has 4 vCPUs and 7 GB of memory, so Turborepo runs two tasks at a time
(`--concurrency=2`) and Vitest uses two workers (`VITEST_MAX_WORKERS=2`; `--env-mode=loose` lets
Turborepo pass that variable to the tests).

### Environment variables

None are needed. `next build` of `apps/web` and `apps/launchpad-template` reads its configuration
lazily (at the first request or at server start), so a build without any `NEXT_PUBLIC_*` value
succeeds. The workflow therefore sets no application variable, only telemetry opt-outs.

`apps/web` loads its fonts through `next/font/google`, so its build needs outbound access to
Google Fonts; GitHub-hosted runners have it.

### Tests that need a network, a secret or Docker

No suite in the default run calls the network, a database or a real key: RPC, Supabase, GitHub,
Vercel and Anthropic calls are mocked, and the servers some tests start only listen on loopback.
The suites below need something external, and skip themselves when it is not set, so they do not
run in CI:

| Suite | Runs only when | Needs |
|---|---|---|
| `apps/web/src/server/chat/__tests__/live-smoke.test.ts` | `RUN_LIVE_CHAT=1` and `ANTHROPIC_API_KEY` | The real Anthropic API |
| `apps/web/src/server/rpc/__tests__/live-smoke.test.ts` | `RPC_RELAY_LIVE=1` and a devnet `RPC_URL` | A devnet RPC endpoint |
| `apps/web/src/server/uploads/__tests__/live-smoke.test.ts` | `FORGE_R2_SMOKE=1` | Real R2 storage credentials |
| `apps/builder/src/sandbox/sandbox.integration.test.ts` | `FORGE_SANDBOX_INTEGRATION=1` | Docker and the sandbox images |
| `supabase/tests/db.test.ts` | `SUPABASE_DB_URL` | A Postgres database with the migrations applied |

Two other groups depend on the platform, not on a secret: some template tests need `git` (present
on the runner; they skip without it) and one signer keystore test is skipped on Windows.

The devnet scripts (`scripts/devnet-tests`, `pnpm test:1` and the like) are not part of CI: they
need funded wallets. Only their pure unit tests (`src/lib/*.test.ts`) run.

## Reproduce locally

From the repository root, with the Node version of `.nvmrc` and the pnpm version of
`packageManager`:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

On a machine with little memory, add `--concurrency=2` to any of these commands, and set
`VITEST_MAX_WORKERS=2` with `--env-mode=loose` for `pnpm test`, as the workflow does.

## Recommended settings for `main`

The owner configures these in the GitHub web interface. Open the repository, then:

### 1. Let the workflow run once

The `verify` check only appears in the list of required checks after it has run once on the
repository. Open a pull request from a branch that contains `ci.yml`, wait for `verify`, then
configure the rule.

### 2. Create the ruleset

Settings > Rules > Rulesets > New ruleset > New branch ruleset.

- Ruleset name: `main`
- Enforcement status: `Active`
- Bypass list: leave it empty (this also applies the rules to administrators; see the note below)
- Target branches: Add target > Include default branch
- Branch rules, tick:
  - Restrict deletions
  - Require linear history
  - Require a pull request before merging
    - Required approvals: `0` (a solo owner cannot approve their own pull request; raise it when
      there is a second reviewer)
    - Dismiss stale pull request approvals when new commits are pushed
    - Require conversation resolution before merging
    - Allowed merge methods: `Squash` and `Rebase` only (a merge commit would break linear history)
  - Require status checks to pass
    - Require branches to be up to date before merging
    - Add checks: `verify`
  - Block force pushes
- Click Create.

Administrators: the recommendation is to include them (empty bypass list), so the owner's own
pushes also go through a pull request and a green `verify`. The cost is that a broken CI blocks
everything, including fixes: in that case fix CI in a pull request (it is the one that has to
pass), or temporarily set the ruleset to `Disabled` and turn it back on afterwards.

### 3. Repository settings

- Settings > General > Pull Requests: untick `Allow merge commits`, keep `Allow squash merging`
  and `Allow rebase merging`, tick `Automatically delete head branches`.
- Settings > Actions > General > Fork pull request workflows: select
  `Require approval for first-time contributors who are new to GitHub` (or stricter).
- Settings > Actions > General > Workflow permissions: `Read repository contents and packages
  permissions` (the workflow also sets this itself).
