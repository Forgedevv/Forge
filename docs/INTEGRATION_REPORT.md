# Wave 3 integration report

## What works locally

- The builder protects its host firewall policy, scopes GitHub tokens and Vercel settings, pins comparison refs, and keeps worker slots until aborted handlers settle.
- Core validates launch and payment configuration, checks transaction contents, handles payment finality explicitly, and calculates pool and claim outcomes safely.
- The signer validates transaction policy before signing, coordinates shared-wallet outflows, records signatures before broadcast, resumes in-flight jobs, and fails closed on unreadable kill switches or chain state.
- The launchpad template verifies prepared launch and creator-claim transactions in the browser, checks their costs and configured pool, and uses an RPC relay instead of trusting server-provided transactions.
- Web chat and payment flows have stronger request validation, rate limits, durable confirmation and idempotency handling, and tests for recovery and failure cases.
- Workspace links and the lockfile include the new local `@forge/core` dependencies for web and signer.

## Local verification

On the consolidated `w3/integration` worktree:

- `pnpm typecheck` passed for all eight workspace packages.
- `pnpm lint` passed for all eight workspace packages.
- `pnpm turbo run test --concurrency=2` passed: 2,221 tests passed and 35 were skipped. The Supabase database suite skipped its 25 tests because `SUPABASE_DB_URL` was not provided; the builder sandbox integration suite skipped its seven tests because it requires its external sandbox setup; web skipped two live-smoke tests; signer skipped one platform-specific permissions test.
- `pnpm build` passed for all eight workspace packages, including production builds of the web app and launchpad template.

The Supabase database test now skips cleanly when no database URL is supplied and does not load `.env` implicitly. The migration helper only runs migrations when invoked directly, so importing its environment loader has no migration side effect.

## Not verified

The full Hugo journey on devnet has not been run: it requires configured external Supabase, builder, signer, model and RPC services, devnet test wallets, and on-chain transactions. Kill switches against deployed services and the malicious-chat scan scenario also remain unverified end to end. No deployment or push was performed.

Before mainnet, run the full devnet flow from `tasks/06-INTEGRATION.md`, execute the Supabase RLS and job-function tests against the intended test database, run the builder sandbox integration tests on a supported Linux host, test all four kill switches against the deployed services, and record the resulting signatures and recovery behavior. Re-review program IDs, treasury destinations, transaction limits, RPC policy, and Vercel project isolation against production configuration before enabling real funds.
