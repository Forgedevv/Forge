# 06 — LEAD: skeleton, contracts, integration

**You own**: root files, `packages/shared`, `docs/`.
**You read**: everything.

You are the session that starts before the others and assembles at the end.

## Phase 0 — before launching the agents (about 1 h)

- [ ] Monorepo: pnpm workspaces, Turborepo, shared strict TypeScript (`tsconfig.base.json`), ESLint + Prettier, vitest, `.gitignore` (`.env*`, `.state/`, `node_modules`).
- [ ] Empty folders with a minimal `package.json`: `packages/shared`, `packages/core`, `apps/web`, `apps/launchpad-template`, `apps/builder`, `apps/signer`, `scripts/devnet-tests`, `supabase`.
- [ ] `packages/shared`: translate `docs/INTERFACES.md` into code (constants §1, `LaunchpadSpec` §2, `forge.config.json` §3, statuses §4, route types §6 and §7, browser client types from `docs/frontend/CONTRACT.md` in `web-client.ts`). zod validation tests.
- [ ] Root scripts: `pnpm typecheck`, `pnpm test`, `pnpm build` (Turborepo).
- [ ] Empty `docs/CHANGE_REQUESTS.md` with an entry template.
- [ ] Commit on `main`, then create the worktrees (see `KICKOFF.md`).

## During the build

- [ ] At least twice a day: read `docs/CHANGE_REQUESTS.md`, rule on the requests, update `packages/shared` and `docs/`, notify the agents concerned.
- [ ] Merge the agents' branches into `main` when their tests pass; resolve conflicts.
- [ ] Record the devnet test results in `docs/DECISIONS.md`.

## Integration phase (devnet)

- [ ] Wire the real components in place of the mocks: web ↔ Supabase ↔ builder ↔ signer ↔ core.
- [ ] Full flow on devnet, with the fake $FORGE:
  1. a "Hugo" wallet holds the fake $FORGE, logs in, chats, confirms the spec;
  2. pays (quote in devnet SOL);
  3. the builder creates the repo, the agent codes, the scan passes, the preview is displayed;
  4. Hugo approves, the signer creates the configs, prepares the launch;
  5. Hugo signs, $MOON is created, Hugo receives his tokens;
  6. trades via `@forge/core` (scripts, since the Jupiter interface doesn't exist on devnet);
  7. the referral and the platform fee arrive in the test accounts; the signer claims the creator share to the test vault;
  8. Hugo claims his partner fees from the dashboard;
  9. a job forced to fail twice is refunded.
- [ ] Test the kill switches (`deploys_paused`, `buyback_paused`, `signups_paused`, `disabled`).
- [ ] Test the scan with a malicious modification request in the chat.
- [ ] Write `docs/INTEGRATION_REPORT.md`: what works, what breaks, what must be fixed before mainnet.

## Report

_To be filled in at the end of the phase._
