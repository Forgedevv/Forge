# FORGE workshop interface

Screens A2 through A11 use the `WebClient` type from `@forge/shared`. Components never build transactions, connect wallet extensions directly, or calculate payment/claim amounts. English copy is grouped by screen in `content/`. Common interface copy and job status labels are shared.

## Routes

- `/new`: session gate, $FORGE check, streamed design chat, validated specification summary, confirmation.
- `/jobs/[id]/pay`: quote, expiry countdown, fresh quote, signing/sending/confirmation, included changes.
- `/jobs/[id]`: creation/change trackers, live event log, preview approval, retry/refund/team intervention, live result.
- `/jobs/[id]/launch`: transaction summary, owner-wallet check, launch phases, retry and return to tracking.
- `/dashboard`: empty/single/multiple launchpads, claims, active jobs, remaining changes, sleeping/disabled states and reactivation.
- `/launchpads/[id]`: read-only specification, on-chain addresses, versions, jobs and an explicit unavailable claim-history state.
- `/launchpads/[id]/modify`: fresh access check and change chat, with immutable on-chain settings explained.
- `/faq` and `/terms`: public information pages. The terms are provisional product information.
- Global login modal: wallet choice, signing, cancellation, errors and connected state. The homepage opens the same modal when the development client is enabled.

## Development mocks and state gallery

Run the Next development server with `NEXT_PUBLIC_USE_MOCKS=1`, then open `/dev/states`. For example, in Git Bash:

```sh
NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @forge/web dev --port 3007
```

This is a process-scoped flag; no environment file or global environment change is needed. Both the mock provider and development routes refuse production activation. `/dev/states` and the local illustrative `/dev/preview` return 404 in production. Without the flag, operational routes show an honest unavailable-service state, and public information remains accessible.

The gallery lists each screen and state with one isolated, interactive preview at a time. Resetting it restores its fixture and timers. It includes all transaction phases, an expiring quote, a failed build that retries once, refunds, on-chain/deployment failures, insufficient access, disabled access checking, wrong wallet, paused signups, chat limits, and live/sleeping/disabled launchpads. The automatic journey advances every three seconds until live; the normal creation journey waits for preview approval and the owner signature.

Mock chat is a scripted demonstration. Four messages fill the blueprint progressively; a modification needs one request. Sample numbers are fixture data, not calculated financial amounts. Wallets and signatures use explicit `demo:` or `demo-` identifiers, not valid chain addresses. No transaction or key exists. Preview/receipt links stay local. In-memory fixtures reset on a full reload; internal Next links preserve the active journey across route changes.

`mocks/client.ts` returns a client checked against every `WebClient` signature. `WorkspaceProvider` is the integration point: replace its unavailable adapter with Agent 3's real client when delivered. The screen imports and financial boundaries do not change. The controller adds development-only scenario lifecycle methods, separate from the shared client contract.

## Components and accessibility

`components.tsx` supplies buttons, cards, loading skeletons, readable errors, empty states, badges, amounts, copyable addresses, transaction phases, the quote countdown, job tracker, and fee claim action. `spec-summary.tsx` presents all specified fields and per-field errors. CSS variables provide a dark-default ink/periwinkle theme and an available light theme. The layout stacks below 800 px and has dedicated 375 px sizing. Controls have visible focus, disabled/busy states, and reduced-motion support. The native login dialog traps focus and restores it on close. Job events use an `aria-live` log.

The required tracker, countdown, specification and claim-button component tests are in `components.test.tsx`. Further tests cover expired/free quotes, wrong wallets, rejected login, access checking, safe links, mock streaming, approval/signature checkpoints, retry timing and gallery isolation. Real browser layout and assistive-technology checks remain outstanding because no browser is connected.

## Open integration items

- Agent 3's real client and wallet provider are absent. The mock wallet choices exercise a simulated connection; actual wallet selection belongs to that provider.
- The contract has no claimed-fee history, official $FORGE acquisition link, token display metadata, or distinct rejected-login/stream-error fields. The requests are recorded in `docs/CHANGE_REQUESTS.md`; missing data is not invented.
- The legacy `apps/web/tests/home.test.tsx` still asserts the deleted placeholder. It is outside the frontend edit zone and remains unchanged.
- Client-template screens B1–B7 are not part of this change; that application still contains only its README.
