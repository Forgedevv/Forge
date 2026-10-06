# KICKOFF — starting development

## Step 1 — Manual setup (Ali)

Follow `tasks/00-SETUP.md`. At a minimum to get started: GitHub organization + monorepo, Supabase, Helius (devnet), Squads devnet multisig, 2 VPS (the builder and the signer can start locally and be deployed later).

## Step 2 — Lead session (about 1 h)

Open Claude Code at the repo root and paste:

```
You are the FORGE lead session. Read PLANEXECUTE.md, README.md, docs/INTERFACES.md and tasks/06-INTEGRATION.md.
Do only "Phase 0" of tasks/06-INTEGRATION.md: the monorepo skeleton and packages/shared translated from docs/INTERFACES.md, with tests.
When it is done and pnpm typecheck and pnpm test pass, make a commit on main and stop.
```

## Step 3 — Worktrees

One folder per agent, each on its own branch, so they don't step on each other:

```bash
git worktree add ../forge-onchain  -b agent/onchain
git worktree add ../forge-template -b agent/template
git worktree add ../forge-web      -b agent/web
git worktree add ../forge-builder  -b agent/builder
git worktree add ../forge-signer   -b agent/signer
```

## Step 4 — Launch the agents

Open one terminal per worktree, run `claude`, and paste the matching prompt.

**With a subscription, 5 agents in parallel may hit usage limits.** In that case, launch in waves:
- **Wave 1**: agent 1 (on-chain), agent 4 (builder), agent 3 (web).
- **Wave 2**: agent 2 (template), agent 5 (signer).

Agent 1 starts with the devnet tests: they determine part of the other agents' code. The others move forward with mocks in the meantime.

### Agent 1 — On-chain

```
You are FORGE agent 1 (on-chain). Read PLANEXECUTE.md, then tasks/01-ONCHAIN.md, then the docs it cites.
Start with step A (devnet tests). When a script needs devnet SOL, print the address to fund and wait until I tell you it is done.
Only modify packages/core and scripts/devnet-tests. Fill in the Report section of your task sheet at the end.
```

### Agent 2 — Template

```
You are FORGE agent 2 (template). Read PLANEXECUTE.md, then tasks/02-TEMPLATE.md, then the docs it cites.
Only modify apps/launchpad-template. Use @forge/core through the workspace and mocks for whatever doesn't exist yet.
Fill in the Report section of your task sheet at the end.
```

### Agent 3 — Web

```
You are FORGE agent 3 (web). Read PLANEXECUTE.md, then tasks/03-WEB.md, then the docs it cites.
Only modify apps/web and supabase. Mock the builder and the signer: you communicate with them only through Supabase.
Fill in the Report section of your task sheet at the end.
```

### Agent 4 — Builder

```
You are FORGE agent 4 (builder). Read PLANEXECUTE.md, then tasks/04-BUILDER.md, then the docs it cites.
Only modify apps/builder. Start with the scan and the AI gateway with their tests, then the worker, then GitHub and Vercel. Mock the signer.
Fill in the Report section of your task sheet at the end.
```

### Agent 5 — Signer

```
You are FORGE agent 5 (signer). Read PLANEXECUTE.md, then tasks/05-SIGNER.md, then the docs it cites.
Only modify apps/signer. Start with the keystore and the HMAC API with their tests. Everything is tested on devnet.
Fill in the Report section of your task sheet at the end.
```

## Step 5 — During the build

- Re-run the lead session twice a day with: `Read docs/CHANGE_REQUESTS.md and the reports in tasks/, rule on the requests, update packages/shared and docs, then merge into main the branches whose tests pass.`
- After a merge, in each worktree: `git merge main`.

## Step 6 — Integration, then mainnet

- Lead session: integration phase of `tasks/06-INTEGRATION.md`.
- Then `tasks/07-MAINNET.md`.

## Realistic schedule

| Step | Duration |
|---|---|
| Setup + phase 0 | half a day |
| Devnet tests + parallel build | 1.5 to 2 days |
| Devnet integration | 0.5 to 1 day |
| Mainnet tests | 2 to 4 days (lots of waiting) |
| $FORGE launch | half a day |
