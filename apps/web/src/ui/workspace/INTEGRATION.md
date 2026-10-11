# Operational interface handoff

Updated on 2026-10-11 (wave 4 review fixes). The screens use the real client (`src/client`) through `WorkspaceProvider`; development previews remain isolated mocks and production always uses the real client.

## Client contract

Screens are typed with `ForgeWebClient` (`src/client/types.ts`): the shared `WebClient` contract with richer, optional results (payment outcome, launch simulation, claim summary, launchpad load errors and on-chain availability) and three extensions (`useBetaAccess`, `getPendingPayment`, `resumePayment`). `withClientExtensions` gives a plain `WebClient` (the mocks) neutral defaults, so mocks only implement what a scenario needs.

## Money flows

- **Payment.** Before the wallet signs, the transaction must be exactly one System transfer of the quoted lamports from the session wallet, exactly one memo `forge:job:<jobId>` and optional bounded compute budget, paid and signed by the session wallet only; the recipient is pinned to `NEXT_PUBLIC_FORGE_CASHBOX_WALLET` when it is set. Right after sending, `{ jobId, paymentId, signature }` is saved in sessionStorage. Confirmation is retried with the same signature (202, 429 with `Retry-After`, 5xx, network errors, timeouts) for about 90 s, then the screen shows "still confirming" with a check that re-confirms. While a sent payment is unresolved no new quote is requested. A 410 after sending explains the manual refund and never offers a second payment.
- **Partner fee claims.** Each claim transaction is checked (fee payer and receivers are the session wallet; only DBC, token, associated token, System for wrapped SOL and compute budget programs), then its summary (amount collected by this transaction, owner cost, pools left) is reviewed before signing. Claims continue pool by pool, each one reviewed and signed separately.
- **Launch.** The prepared transaction must be paid by the session wallet with only its signature missing, and the wallet must return the same message. The screen shows the first buy, the fees and account deposits, and their total; when the server did not simulate the exact transaction successfully, a warning and an explicit confirmation are required. The signed bytes are kept until settled: a pending confirmation or a retry re-submits them without a new signature, and an already signed launch is shown as confirmed.

## Data and access

- Dashboard and detail data come from `GET /api/launchpads` and `GET /api/launchpads/:id` (site URL, coin count, claimable fees and whether the chain could be read). Supabase Realtime only triggers debounced re-reads. A failed read is shown with a retry instead of an empty workshop; unknown on-chain figures are shown as unavailable, not zero.
- Job tracking still reads Supabase directly (`useJob`), with Realtime updates.
- A `BETA_NOT_INVITED` answer from any call clears the local session and shows the private beta notice (session gate and login).
- `useFlags()` keeps an open default on a failed read; paused creation must stay enforced server-side.

## Validation

Client tests run the real client against mocked HTTP and a simulated wallet (no private key, no chain): payment persistence and retries, transaction checks, claim review and loop, launch resubmission, beta handling and API-backed launchpad hooks. Screen tests use the mocks. Local typechecks, lint, tests and builds do not replace deployed-service, database-policy or devnet tests.
