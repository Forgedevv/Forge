# Operational interface handoff

Checked on 2026-10-10. The frontend branch connects the real `WebClient` and its configured wallet provider. Development previews remain isolated mocks; production always uses the real client.

## Backend route availability

The paths below come from `WEB_API_ROUTES` in `@forge/shared`. The frontend does not implement them or substitute financial behavior when they are missing.

| Client operation | Frontend branch | Consolidated `w3/integration` branch |
| --- | --- | --- |
| Login nonce, verification, session, logout and Supabase token | Routes present | Routes present |
| Chat and specification confirmation | Routes absent | Routes present |
| Payment quote and confirmation | Routes absent | Routes present |
| `GET /api/flags`, `GET /api/gating` | Routes absent | Routes absent |
| `POST /api/rpc` | Route absent | Route absent |
| Job approval and owner transaction GET/POST | Routes absent | Routes absent |
| Launchpad modification, reactivation and claim transaction | Routes absent | Routes absent |

Job and launchpad data come through the real client's authenticated Supabase reads and subscriptions. Their availability depends on public Supabase configuration, the token endpoint, schema migrations, RLS, and running backend services. None of these is proved merely by rendering the interface.

The lead still needs to assemble the backend routes and services, integrate the backend branch, and run the complete devnet journey. The UI checks below do not establish an operational deployed payment flow.

## Client behavior requiring backend follow-up

- `useFlags()` currently starts with `signupsPaused: false` and silently retains that value on a failed flag read. Its contract has no loading or error state. The backend owner should provide fail-closed behavior and enforce paused creation server-side.
- `useSession().connect()` can return after opening the wallet picker without creating a session. The UI offers a continuation step. The hook cannot distinguish a cancelled picker or declined login from idle; it must not be reported as successful authentication.
- The job and launchpad hooks keep `loading: true` when Supabase is unavailable and suppress data-read errors. A failed list read can appear as an empty list. Their shared result types have no error channel; the backend owner needs to expose these failures so the interface can distinguish unavailable data from an empty workshop.
- The shared contract still lacks claim history, an official token acquisition link and token display metadata. The interface retains its existing unavailable/raw-unit states rather than making these values up.

## Validation

Frontend integration tests use the real client hooks against mocked HTTP responses and a simulated wallet adapter. They cover authenticated session gating, login errors and retry, picker delegation and focus handoff, keyboard focus restoration, failed access checks and retry, logout, signup flags, production rejection of injected mocks, and development isolation from wallet/API access.

No test here uses a private key, creates a transaction, or sends one to a chain. Local typechecking, linting and builds do not replace deployed-service, database-policy, sandbox or devnet tests.
