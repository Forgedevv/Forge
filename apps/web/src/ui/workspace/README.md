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
- Global login modal: wallet choice, signing, cancellation, errors and connected state. The homepage opens the same modal with the real client or development mocks.

## Real client integration

Without a development mock flag, `WorkspaceProvider` loads `live-provider.tsx`, wraps the interface in the backend-owned `ForgeClientProvider`, and supplies `realClient` from `src/client`. Wallet selection, login messages, Supabase authentication, the RPC relay, and transaction operations remain owned by that client. Screens keep the shared contract and do not construct or sign transactions themselves.

Choosing a wallet may return before authentication: the login panel then offers "Continue with my wallet" to finish the message-signing step. A successful session unlocks protected screens; failed authentication keeps them locked. HTTP errors do not activate a mock or fabricate a session.

The live wallet stack is loaded separately from preview mocks. The provider ignores both `NEXT_PUBLIC_USE_MOCKS=1` and injected mock controllers in production. A development preview mounts neither the live wallet provider nor the live API hooks. Its simulated-data notice remains visible.

This connects the interface to the client implementation, not to a completed deployed backend. See [INTEGRATION.md](./INTEGRATION.md) for the route handoff and remaining service checks.

## Development mocks and state gallery

Run the Next development server with `NEXT_PUBLIC_USE_MOCKS=1`, then open `/dev/states`. For example, in Git Bash:

```sh
NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @forge/web dev --port 3007
```

This is a process-scoped flag; no environment file or global environment change is needed. Both the mock provider and development routes refuse production activation. `/dev/states`, `/dev/workshop`, and the local illustrative `/dev/preview` invoke `notFound()` in production and expose no preview content. A streamed Next response can carry HTTP 200 with the not-found result and `noindex`; the response status alone is not the guard check. Without the flag, screens use the real client and show its session, data and errors.

The gallery lists each screen and state with one isolated, interactive preview at a time. Resetting it restores its fixture and timers. It includes all transaction phases, an expiring quote, a failed build that retries once, refunds, on-chain/deployment failures, insufficient access, disabled access checking, wrong wallet, paused signups, chat limits, and live/sleeping/disabled launchpads. The automatic journey advances every three seconds until live; the normal creation journey waits for preview approval and the owner signature.

Mock chat is a scripted demonstration. Four messages fill the blueprint progressively; a modification needs one request. Sample numbers are fixture data, not calculated financial amounts. Wallets and signatures use explicit `demo:` or `demo-` identifiers, not valid chain addresses. No transaction or key exists. Preview/receipt links stay local. In-memory fixtures reset on a full reload; internal Next links preserve the active journey across route changes.

`mocks/client.ts` returns a client checked against every `WebClient` signature. `WorkspaceProvider` selects the real client or an isolated development controller. The controller adds development-only scenario lifecycle methods, separate from the shared client contract.

## Components and accessibility

`components.tsx` supplies buttons, cards, loading skeletons, readable errors, empty states, badges, amounts, copyable addresses, transaction phases, the quote countdown, job tracker, and fee claim action. `spec-summary.tsx` presents all specified fields and per-field errors. CSS variables provide a dark-default ink/periwinkle theme and an available light theme. The layout stacks below 800 px and has dedicated 375 px sizing. Controls have visible focus, disabled/busy states, and reduced-motion support. The login dialog traps focus and restores it on close, yielding focus to the wallet adapter's body portal while that picker is open. Its overlay stays below the picker instead of blocking it in the native dialog top layer. Job events use an `aria-live` log.

The required tracker, countdown, specification and claim-button component tests are in `components.test.tsx`. Further tests cover expired/free quotes, wrong wallets, rejected login, access checking, safe links, mock streaming, approval/signature checkpoints, retry timing and gallery isolation. `provider.test.tsx` exercises the real hooks with simulated HTTP and wallet adapters, including authentication gating, failed access checks, picker focus handoff, logout, and production mock isolation. Real browser layout and assistive-technology checks remain outstanding because no browser is connected.

## The Muse

The FORGE Muse (`../muse/`) appears across the workshop: the chat avatar (listening while you type, thinking while a reply streams), the job stage (building, waiting for approval, live, error), the launch confirmation, toasts, empty states and the login panel. Each launchpad card shows that launchpad's own Muse in its theme colors, read from `useLaunchpad(id).launchpad.spec.theme`, because `LaunchpadSummary` carries no theme; this costs one detail subscription per card.

The dashboard opens with `muse-hero.tsx`: the full-body Muse in a small Three.js scene (`../muse/three/hero-scene.ts`, loaded on demand) with the user's launchpad Muses hovering around it. It points to the create button when there is no launchpad yet, crafts a floating spark while a job builds, and hops with a spark burst when a launchpad is live. It pauses offscreen and in hidden tabs, holds a static pose under reduced motion, and falls back to the 2D Muse without WebGL. The gallery's "A8 · Dashboard Muse" group shows each state, and "The Muse" shows every mood, size and theme.

## Open integration items

- The real client and wallet provider are present and connected. The remaining service routes and end-to-end checks are listed in [INTEGRATION.md](./INTEGRATION.md).
- The contract has no claimed-fee history, official $FORGE acquisition link, token display metadata, or distinct rejected-login/stream-error fields. The requests are recorded in `docs/CHANGE_REQUESTS.md`; missing data is not invented.
- Client-template changes are separate from this web-client integration.
