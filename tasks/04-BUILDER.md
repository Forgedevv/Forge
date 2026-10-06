# 04 — BUILDER (agent 4)

**You own**: `apps/builder`.
**You read**: `PLANEXECUTE.md`, `docs/ARCHITECTURE.md`, `docs/INTERFACES.md` (§4, §5, §7, §8), `docs/SECURITY.md` (sections 1 to 4), `docs/OPERATIONS.md`.

You build the worker that runs on VPS 1: it picks up jobs, has the AI agent work in a sandbox, scans, pushes to the client's repo, deploys to Vercel and asks the signer to wire up Meteora. It is the most complex component: move forward in small, testable steps.

## Components

```
apps/builder/src/
├── worker.ts          # loop: picks up a job ("for update skip locked" query), processes it, updates the status
├── pipeline/
│   ├── create.ts      # create_launchpad: repo + agent + scan + preview, then (after approved) signer + prod
│   └── modify.ts      # modify_launchpad: agent + scan + preview, then prod
├── github.ts          # GitHub App: repo from the template, repo-scoped token, branches, push
├── sandbox/
│   ├── run.ts         # starts one Docker container per job, mounts only the job's folder
│   ├── Dockerfile     # Node 20 + Claude Code, non-root user
│   └── network.ts     # Docker network with an egress allowlist
├── gateway/           # AI gateway (Anthropic API-compatible proxy) on the host
│   └── server.ts      # real key here; temporary tokens per job; OPS.agentBudgetUsdPerJob budget; cost log
├── prompts/
│   └── builder.md     # the agent's system prompt (rules: only touch src/theme, src/content, pages; never src/forge)
├── scan/
│   └── scan.ts        # rules from SECURITY.md §1, output: ok | list of violations
├── vercel.ts          # one project per client, env variables, preview deployment, promotion to prod, subdomain
├── signer-client.ts   # HMAC calls to apps/signer (/v1/configs, /v1/launch-coin/prepare)
├── sleep.ts           # sleep mode for inactive launchpads (30 days)
└── alerts.ts          # Telegram
```

## To do

- [ ] Worker and status transitions exactly as in `INTERFACES.md` §4, with `job_events` readable by the client ("Creating your repo", "Coding the design", "Preview ready").
- [ ] GitHub: create the client repo from `launchpad-template`, write `forge.config.json` (without `onchain` at first), branch `forge/<jobId>`.
- [ ] Sandbox: one container per job, Claude Code in headless mode (`claude -p`, JSON output, tools limited to file read/write and npm build commands), `ANTHROPIC_BASE_URL` = gateway, `ANTHROPIC_AUTH_TOKEN` = the job's token. Timeout `OPS.agentTimeoutMinutes`. The prompt contains the `LaunchpadSpec` (theme, designNotes) or the modification request.
- [ ] AI gateway: proxy to the Anthropic API, rejects expired tokens or tokens over budget, records the cost per job in `jobs.api_cost_usd`.
- [ ] Blocking scan before any push (SECURITY.md §1). On violation: no push, job `failed` (`failed_stage = 'build'`) with the list of violations, Telegram alert.
- [ ] Local site build in the sandbox before the push (avoids broken deployments).
- [ ] Vercel: one project per client, env variables (FORGE addresses, Jupiter key, R2, RPC relay URL), preview deployment on the branch → `preview_ready` with the URL.
- [ ] Picking up jobs with the two queries of `INTERFACES.md` §5 (build / after approval). Lock reset to `null` as soon as the job leaves an active status.
- [ ] After `approved` (creation) → `onchain_setup`: signer call `/v1/configs` → write the addresses into `forge.config.json#onchain` (committed by the builder, not by the agent) → call `/v1/launch-coin/prepare` → `jobs.owner_tx` → `awaiting_owner_signature`.
- [ ] Job in `owner_signed` (the web sets it when the client's transaction is confirmed), or modification in `approved` → `deploying`: merge the branch into `main`, promotion to production, subdomain `<slug>.<clients-domain>` → `live`.
- [ ] Failure: `failed` with `failed_stage` (`build`, `onchain`, `deploy`). Automatic retry only if `failed_stage = 'build'` and `attempts < 2`. `onchain` or `deploy` failure: Telegram alert, no automatic retry.
- [ ] Crashed jobs: an active job whose lock exceeds `OPS.jobLockStaleMinutes` moves to `failed` (stage depending on its status), with an alert.
- [ ] `deploys_paused` flag respected; daily sleep mode (`sleep.ts`).

## Tests

- [ ] Unit tests of the scan with booby-trapped diffs (added address, external script, modification of `src/forge`, change of `@forge/core` version): all must be blocked.
- [ ] Gateway test: expired token rejected, exceeded budget rejected.
- [ ] End-to-end test on a test repo and a test Vercel project, with a mocked signer.

## Dependencies

Published template (agent 2), signer (agent 5): use mocks that respect `INTERFACES.md` §7 until they are ready.

## Report

_To be filled in at the end of the task._
