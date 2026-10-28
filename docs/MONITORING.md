# MONITORING: watching FORGE from the outside

This document is for a monitor that runs on separate infrastructure and holds **no FORGE secret**. It states what such a monitor can observe, what it cannot, which dependencies to watch for security advisories, and where to read the model cost of a client site. FORGE keeps its own Telegram alerts (docs/OPERATIONS.md, "Alerts"); this does not replace them.

Everything below was read in the code at the commit this file was written on (`main`, `4d16393`). References are `path:line`. When the code changes, the references move: the behavior is what to re-check.

## 1. `GET /api/health` (apps/web)

Files: `apps/web/app/api/health/route.ts`, `apps/web/src/server/readiness.ts`.

### Contract

| Item | Value | Where |
|---|---|---|
| Method | `GET` only is exported. Other methods are answered by Next.js itself (405); `HEAD` is derived from `GET` by Next.js. This is framework behavior, not code in this repo | `route.ts:12` |
| Auth | none | `route.ts:12-14` |
| Rate limit | none in the route or in the repo for this route (the only in-app limiters are the design chat's and the RPC relay's). Anything at the platform level (Vercel firewall) is not in the repo | `src/server/chat/rate-limit.ts`, `src/server/rpc/limits.ts` (neither is used by health) |
| Runtime | `nodejs`, `dynamic = 'force-dynamic'`: evaluated at each request, never prerendered | `route.ts:3,5` |
| Caching | `cache-control: no-store` on both 200 and 503 | `readiness.ts:155,170-171` |
| Other headers | the site-wide security headers (HSTS on https, `X-Frame-Options: DENY`, etc.) come from `next.config.ts` and apply to every path | `next.config.ts:8-9`, `security-headers.ts` |
| Content type | JSON (`Response.json`) | `readiness.ts:170-171` |

### Answers

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true}` | Every configuration reader succeeded and the browser bundle's cluster equals the server's | `readiness.ts:170` |
| 503 | `{"ok":false,"code":"config_invalid"}` | At least one configuration reader refused its environment (payments, jobs and launchpads, RPC relay, sign-in secrets and app URL, design chat key, public flags route keys), or a closed beta has no valid allowlist, or an unexpected exception was thrown while reading | `readiness.ts:92-108,162-171` |
| 503 | `{"ok":false,"code":"cluster_mismatch"}` | The configuration is valid but `NEXT_PUBLIC_SOLANA_CLUSTER` (inlined at build time) is unset in production or differs from the run-time `SOLANA_CLUSTER`. Checked only after the configuration passed, so `config_invalid` wins when both apply | `readiness.ts:57-72,109-111` |

There are exactly two codes (`ReadinessCode`, `readiness.ts:31`). The offending variable names go to the server log only (`server_not_ready`, scope `readiness`), never to the response (`readiness.ts:27-28,135-139`). A monitor cannot tell which variable is wrong from the response.

### What it checks

Only **this instance's environment configuration**, read synchronously from `process.env`: `healthResponse()` returns a `Response`, not a promise (`readiness.ts:162`), so the handler cannot perform I/O. It does not call the database, the RPC provider, R2, the signer, the builder, or any third party. The list of areas read is in `readiness.ts:11-22` and `92-105`.

### What it does NOT detect

| Failure | Detected by `/api/health`? |
|---|---|
| Supabase (database) down or unreachable | No |
| Solana RPC provider (Helius) down, rate limited, or key revoked | No (only that `RPC_URL` is set and valid) |
| Builder down or stuck | No |
| Signer down or stuck | No |
| Anthropic API down or out of budget | No (only that the chat key is set) |
| R2 uploads misconfigured | No, explicitly excluded: they answer 503 `NOT_CONFIGURED` while health stays 200 (`readiness.ts:24-25`, docs/MAINNET.md:85) |
| The `$FORGE` gate | No (read at request time) |
| Wrong values that are well formed (a valid but wrong RPC URL or secret) | No |
| Vercel platform outage, DNS, TLS | Not by the route: the monitor sees a timeout, a 5xx from the platform, or a non-JSON body |

A 200 therefore means "this deployment is configured and serving", nothing more. The result is also deterministic per deployment: all instances of one deployment share the same environment.

One more property: the startup check (`instrumentation.ts`) never throws, so a misconfigured instance keeps serving pages and answers 503 on health (`instrumentation.ts:1-17`). The log lines are deduplicated per process (`readiness.ts:115-130`), so polling does not flood the log.

## 2. Builder and signer: is anything public and secret-free?

**No.** Neither service exposes an HTTP endpoint that answers a caller without a secret. The complete list:

### Signer (`apps/signer`)

One HTTP server (`apps/signer/src/server.ts`), default port 8787 (`server.ts:78`), bound to `SIGNER_HOST` (default `0.0.0.0`, `runtime/env.ts:354`, `runtime/runtime.ts:436`). Routes (`packages/shared/src/api.ts:361-365`, wired in `server.ts:146-172`):

| Route | Auth |
|---|---|
| `GET /v1/health` | IP allowlist + HMAC |
| `POST /v1/configs` | IP allowlist + HMAC |
| `POST /v1/launch-coin/prepare` | IP allowlist + HMAC |

Every request goes through the same chain, in order, before routing (`server.ts:23-42,239-299`): 1) peer IP in `SIGNER_ALLOWED_IPS` (exact addresses, no CIDR; an empty list denies everything in production; `http/ip.ts:9-12`), answer 403 `{"error":"forbidden"}`; 2) body size; 3) `X-Forge-Timestamp` within 60 s (401); 4) `X-Forge-Nonce` (401); 5) HMAC-SHA256 signature with `SIGNER_HMAC_SECRET` (401); 6) replay cache (401). Unknown routes answer 404 only after the signature passed. There is no unauthenticated route, no metrics route, no readiness route.

Indirect signal, not an endpoint: from a host that is not in `SIGNER_ALLOWED_IPS`, any request gets `403 {"error":"forbidden"}` and the connection is closed (`server.ts:241-243`). From an allowed host without a signature it gets 401. docs/MAINNET.md:530 requires that from any other host the port must **time out or answer 403**. If the signer's firewall drops outside traffic (the expected setup), the monitor sees a timeout, which is indistinguishable from a dead machine. Do not treat a 403 or a timeout from the monitor's host as a health result.

### Builder (`apps/builder`)

The builder is a worker with no public server and no health endpoint. It has two listeners, neither public:

| Listener | Binding | Endpoints and auth |
|---|---|---|
| Model gateway (`apps/builder/src/gateway/server.ts`) | `FORGE_GATEWAY_HOST` (default `127.0.0.1`; on Linux the docker0 address, never `0.0.0.0`: `index.ts:74-78`, docs/MAINNET.md:132,532), port `FORGE_GATEWAY_PORT` (default 8787) | Only `POST /v1/messages` and `POST /v1/messages/count_tokens` (`server.ts:84-85,465-470`). Anything else is 404 or 405. Both require a per-job opaque token issued in memory, else 401 (`server.ts:280-290,472`). No health route |
| Sandbox egress proxy (`sandbox/egress-proxy.ts`) | Inside its own container on an internal per-run Docker network (`sandbox/network.ts:1-15`); binds `0.0.0.0` inside that container only (`egress-proxy.ts:664,686`) | Plain HTTP requests get 403; only `CONNECT` to allow-listed HTTPS hosts (`egress-proxy.ts:593-607`). Not reachable from outside the host |

The builder's reachability from the outside is nil. Its startup health call goes the other way: the builder calls the signer's `/v1/health` (HMAC-signed) and exits if the cluster does not match (docs/OPERATIONS.md, "Builder and signer on the same cluster").

### Indirect public signals of builder or signer liveness

**None exist.** What was checked:

| Candidate | Public and secret-free? | Reflects builder or signer liveness? |
|---|---|---|
| `GET /api/health` | yes | No (section 1) |
| `GET /api/flags` (`apps/web/app/api/flags/route.ts`) | yes | No. It reads the `flags` table with the anon key and returns `{"signupsPaused":bool}` only (`flags/flags.ts:1-12,58-62`). It does show that the web can read Supabase (see below), nothing about the workers |
| `GET /api/coin-meta/:slug` | yes | No. Public metadata of a launchpad coin from the database (service role key on the server) |
| `POST /api/rpc` | Callers need a FORGE origin or a server token. Anonymous callers are refused in strict mode (production or mainnet) unless `RPC_RELAY_ANONYMOUS=on`, and allowed by default otherwise, narrowed to the creator fee claim's methods (`rpc/handler.ts:42-45,319`, `rpc/config.ts:249-255`) | No, and each call spends provider credits. Not a probe |
| Builder heartbeat (`jobs.locked_at`, `builder/src/db.ts:207-213`) | No: `jobs` is readable only by the owning wallet's JWT (`supabase/migrations/0002_rls.sql`), not by anon | Only while a job is running; no idle heartbeat exists |
| Client sites (`<slug>.<CLIENTS_DOMAIN>` or `*.vercel.app`) | yes | No: they are served by Vercel, independent of the builder |

`/api/flags` is the one public route that does exercise the database. Its behavior (`flags/flags.ts`): 200 `{"signupsPaused":false|true}` with `cache-control: public, max-age=5, s-maxage=10, stale-while-revalidate=20` (line 21); in-memory cache of 10 s (line 18); when the read fails it serves the last good value for up to 5 minutes (line 20), then 503 `{"code":"NETWORK","message":"Service status is temporarily unavailable."}` with `no-store` (lines 105-106). A database outage therefore shows with a lag of up to about 5 minutes on a warm instance, immediately on a cold one. It is a Supabase read-path probe for the web only.

Everything about the money and build workers (signer jobs, builder queue, stuck jobs) has to come from FORGE's own Telegram alerts or from a monitor that is given access to the database (not part of this setup).

### What is therefore externally observable

| Observable without a secret | Source |
|---|---|
| The FORGE site is up and configured | `GET /api/health` 200 `{"ok":true}` |
| The site's configuration regressed (missing variable, wrong cluster build) | `GET /api/health` 503 with `config_invalid` or `cluster_mismatch` |
| Web can read Supabase (with lag) | `GET /api/flags` 200 vs 503 `NETWORK` |
| Whether signups are paused | `GET /api/flags` body |
| Client sites reachable | HTTP check on a known site |
| Signer, builder, RPC provider, Anthropic API, R2 | **not observable** |

## 3. Dependencies to watch for security advisories

Exact versions are the ones pinned in each `package.json` (all pinned exactly, no ranges) and resolved in `pnpm-lock.yaml` at the commit above. Package managers: `pnpm@10.17.1` (root `packageManager`), Node `>=20` (`engines`).

**Root `pnpm.overrides`** (`package.json`): `rpc-websockets: 9.3.10`. It forces every consumer of `rpc-websockets` (reached through `@solana/web3.js` 1.99.0) to that version. The lockfile header repeats it (`overrides:`).

### Production code

| Package | Version | Where | Why it matters |
|---|---|---|---|
| `next` | `16.3.8` | apps/web | The FORGE site and the RPC relay, internet-facing, on Vercel |
| `next` | `15.5.27` | apps/launchpad-template | Client sites (Pages Router), each served publicly. **A different major from the web app: watch both lines** |
| `react`, `react-dom` | `19.3.0` | apps/web, template | Rendering, server components in the web app |
| `@solana/web3.js` | `1.99.0` | web, signer, core, template, devnet-tests | Builds and parses every transaction; signer keys use it |
| `@solana/spl-token` | `0.4.15` | signer, core, template, devnet-tests | Token instructions in money paths |
| `@meteora-ag/dynamic-bonding-curve-sdk` | `1.5.13` | signer, core, template, devnet-tests | Pool and config transactions; pinned deliberately (docs/METEORA.md) |
| `@meteora-ag/cp-amm-sdk` | `1.5.1` | core, devnet-tests | DAMM v2 position fee claims after graduation |
| `@sqds/multisig` | `2.1.4` | signer, devnet-tests | The multisig that receives claims and the buyback spending limit |
| `@coral-xyz/anchor` | `0.31.1` | template | Anchor client in client sites |
| `@jup-ag/wallet-adapter` | `0.2.6` | template | Wallet connection on every client site |
| `@solana/wallet-adapter-base` | `0.9.28` | web | Wallet signing flow |
| `@solana/wallet-adapter-react` | `0.15.40` | web | Same |
| `@solana/wallet-adapter-react-ui` | `0.9.40` | web | Same |
| `@solana/wallet-adapter-wallets` | `0.19.39` | web | Pulls in many wallet adapters and WalletConnect 2.19.x as transitive dependencies |
| `@solana/wallet-adapter-phantom` | `0.9.30` | template | Wallet connection |
| `@solana/wallet-adapter-solflare` | `0.6.34` | template | Wallet connection |
| `@supabase/supabase-js` | `2.117.2` | web | Database client (service role on the server, anon on the public flags route) |
| `zod` | `4.6.5` | web, builder, signer, shared | Validation of every API input and of the gateway/signer contracts |
| `zod` | `3.25.76` | template | A different major in client sites |
| `bs58` | `6.0.0` | template (direct only) | Base58 decoding. Transitive copies in the lockfile: `4.0.1`, `5.0.0`, `6.0.0` |
| `bn.js` | `5.2.5` | signer, core, template, devnet-tests | Amounts. Transitive `4.12.5` also present |
| `@noble/hashes` | `1.8.0` | core | Hashing. Other `@noble/curves` and `@noble/hashes` versions are transitive |
| `pino` | `10.4.0` | builder, signer | Logging with redaction of secrets. Transitive `7.11.0` also present |
| `pg` | `8.23.1` | supabase (tests and scripts) | Database driver for the schema tests only |
| `tsx` | `4.23.15` | builder, signer, devnet-tests | The signer's `start` script is `tsx src/index.ts` (`apps/signer/package.json:7`), so it is in the production path |
| `typescript` | `6.0.3` | root, builder | Builder lists it as a runtime dependency |
| `@tanstack/react-query` | `4.44.0` | template | Data layer in client sites |
| `ky` | `1.14.3` | template | HTTP client in client sites |
| `superstruct` | `2.0.2` | template | Input validation in client sites |
| `jotai`, `radix-ui`, `motion`, `embla-carousel-react`, `sonner` and the other UI packages | see `apps/launchpad-template/package.json` | template | Client-side only; lower priority |

Transitive packages of the Solana tree worth tracking, with the versions in the lockfile: `rpc-websockets` 9.3.10 (override), `ws` 7.5.13, 8.18.0, 8.21.0, 8.21.3, 8.22.0, `jayson` 4.3.0, `elliptic` 6.6.1, `axios` 1.20.0, `node-fetch` 2.7.0, `cross-fetch` 3.2.0 and 4.1.0, `borsh` 0.7.0, `undici` 8.11.2, `@solana/kit` 2.3.0 and 7.1.1, `@walletconnect/*` 2.19.0 and 2.19.1.

### Absent on purpose (do not look for them)

| Name | Status |
|---|---|
| `tweetnacl` | Not in `pnpm-lock.yaml` at all |
| AWS or S3 SDK | Not used. R2 uploads are signed by an in-repo SigV4 implementation on `node:crypto` (`apps/web/src/server/uploads/sigv4.ts`): advisories for the AWS SDK do not apply, the code itself is the surface |
| Wallet signature verification | `node:crypto` ed25519 (`apps/web/src/server/auth/ed25519.ts:4`), no third-party library |
| Anthropic SDK | Not a dependency. The web chat and the gateway call the HTTP API directly |
| Jupiter Plugin | Not an npm package. Client sites load the plugin script at run time from `plugin.jup.ag`, and call `ultra-api.jup.ag`, `datapi.jup.ag`, `worker.jup.ag` (`apps/launchpad-template/src/forge/security-headers.ts:12-18`). Follow Jupiter's own advisories for it |

### Template versions, separately

Client sites are built from `apps/launchpad-template`, so the versions to watch for them are the "template" rows above: `next` 15.5.27, `react` and `react-dom` 19.3.0, `@solana/web3.js` 1.99.0, `@solana/spl-token` 0.4.15, `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13, `@coral-xyz/anchor` 0.31.1, `@jup-ag/wallet-adapter` 0.2.6, `@solana/wallet-adapter-phantom` 0.9.30, `@solana/wallet-adapter-solflare` 0.6.34, `bs58` 6.0.0, `bn.js` 5.2.5, `zod` 3.25.76, `@tanstack/react-query` 4.44.0, `ky` 1.14.3, `superstruct` 2.0.2. In a client repository `@forge/core` and `@forge/shared` are the published npm packages `@forgedevv/core` and `@forgedevv/shared`, pinned to an exact version (decision D26 in docs/DECISIONS.md; `apps/builder/src/sandbox/config.ts:70`). The workspace version of `@forge/core` is `0.3.1`. Builds of client sites install with `pnpm install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts` (`apps/builder/src/sandbox/build.ts:140-153`) and refuse to install without a lockfile (`build.ts:224`).

An advisory on any template dependency affects every deployed client site, and a fix reaches a site only through a new build of that site.

### Tooling of the build sandbox

| Item | Version | Where |
|---|---|---|
| Base image `node:22-bookworm-slim` | pinned by digest `sha256:c3de60bf...` | `apps/builder/docker/{sandbox,review,egress-proxy}.Dockerfile` |
| `pnpm` | `10.17.1` | `sandbox.Dockerfile:11` |
| Agent CLI `@anthropic-ai/claude-code` | `2.1.295` | `sandbox.Dockerfile:12` |
| Chromium (Debian package, not pinned) | whatever the image build pulled | `review.Dockerfile:23` |

Rebuild the images regularly (docs/OPERATIONS.md notes it for the review image).

### Dev-only (lower priority)

`eslint` 10.12.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.71.1, `prettier` 3.9.9, `turbo` 2.11.7, `vitest` 5.0.3, `globals` 17.13.0, `jsdom` 30.1.2, `vite` 8.3.2 (transitive), `postcss` 8.5.29, `tailwindcss` 4.3.3 (web) and 3.4.19 (template), `@types/*`. They run on developer machines and CI, not in production.

## 4. Model cost of a client site

Cost is what the builder's gateway computes from Anthropic's `usage` field and writes into the database. No source file or doc in the repo gives a measured or estimated per-site model cost (the closest figures are in the "Documented figures" list below).

### Limits as coded

| Limit | Value | Where |
|---|---|---|
| Job budget (per `jobs` row, all attempts and passes) | **15 USD** (`OPS.agentBudgetUsdPerJob`). Not configurable by environment: it is wired from the constant | `packages/shared/src/constants.ts:43`, `apps/builder/src/index.ts:401`, `pipeline/agent.ts:49,165-168` |
| What it is | A soft cap checked **before** each request: a request is refused with 402 `budget_exceeded_error` once recorded cost plus in-flight reservations reach the budget. The last admitted request can overshoot by its own cost (at most `max_tokens` x output price) | `gateway/server.ts:292-306` |
| Per-request output cap | `max_tokens` at most 64,000 | `gateway/config.ts:49` |
| Build attempts | 2 per job (the cost stays in the same row) | `worker.ts:119`, `pipeline/cost-store.ts:20` |
| Visual review (second agent pass, off by default: `BUILDER_VISUAL_REVIEW`) | Within the same job budget: pass 2 gets `min(15, spent + 5)` USD; skipped when less than 1 USD is left | `pipeline/review/config.ts:40-41`, `review/run-review.ts:235-245` |
| Daily budget | `FORGE_GATEWAY_DAILY_BUDGET_USD`, default **200 USD**, per UTC day. Alert at 80 % once a day (high, Telegram); 402 `daily_budget_exceeded_error` once reached | `builder/src/index.ts:80`, `gateway/config.ts:51`, `gateway/server.ts:301-305,436-454` |
| Token lifetime | `OPS.agentTimeoutMinutes` (30) + 1 minute | `shared/constants.ts:44`, `pipeline/agent.ts:165-169` |

A new creation job (for example after "start again", migration 0010) and each modification job is a separate `jobs` row with its own 15 USD budget. The worst case per launchpad is therefore 15 USD times the number of its jobs, plus overshoot. At the 200 USD daily budget, that is about 13 jobs at full budget per day.

### Model and prices as coded

Default model: `claude-sonnet-5-5` (`BUILDER_AGENT_MODEL`, `builder/src/index.ts:81-83`; must be a key of the pricing table). USD per million tokens (`gateway/config.ts:13-35`; the file itself warns to check them against the provider's pricing page before each deployment):

| Model | Input | Output | Cache read | Cache write 5 min | Cache write 1 h |
|---|---|---|---|---|---|
| `claude-sonnet-5-5` (default) | 2 | 10 | 0.2 | 2.5 | 4 |
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 | 8 |
| `claude-haiku-4-5` | 1 | 5 | 0.1 | 1.25 | 2 |

The keys of this table are also the gateway's model allowlist; any other model gets 403.

### How the cost is computed and stored

1. The gateway takes the `usage` of each upstream answer, streamed or not (`gateway/pricing.ts:96-110`, `gateway/sse.ts`), and computes `(input x in + output x out + cacheRead x r + cacheWrite5m x w5 + cacheWrite1h x w1h) / 1,000,000` (`pricing.ts:131-141`, called at `server.ts:426`).
2. When the usage is unknown (stream cut, timeout, unparsable answer) it charges an estimate: request bytes / 4 as input tokens plus the request's `max_tokens` as output (`server.ts:479-483,560-563`; the log line shows `estimated: true`). When the upstream reports a model the table does not price, the most expensive priced model's rates apply (`server.ts:242-253`).
3. The job total is held in memory per job and written to **`jobs.api_cost_usd`** (`numeric not null default 0`, `supabase/migrations/0001_init.sql:45`) as a read-modify-write `PATCH jobs?id=eq.<id>` with the total rounded to 6 decimals (`pipeline/cost-store.ts:110-125`, `pipeline/store.ts:360-366`). The write is serialized per job in the builder process, not an atomic SQL increment (`cost-store.ts:32-34`). A failed write logs `could not record the job API cost` and the column catches up on the next successful add.
4. There is no table of daily totals. The daily total lives in the builder's memory and is seeded at startup from the sum of `jobs.api_cost_usd` over jobs updated since 00:00 UTC (`cost-store.ts:22-30`, `store.ts:371-396`, `index.ts:329-331`); this seed is an upper approximation. The gateway refuses requests until the seed loads.
5. The web app does not expose `api_cost_usd` on any route.

### SQL to read it (read-only)

```sql
-- Cost per job, newest first.
select j.id, j.launchpad_id, j.type, j.status, j.attempts, j.api_cost_usd, j.created_at, j.updated_at
from jobs j
order by j.created_at desc
limit 100;

-- Cost per launchpad (all its creation and modification jobs).
select l.id, l.slug, l.status,
       count(j.id)                                           as jobs,
       sum(j.api_cost_usd)                                   as api_cost_usd,
       sum(j.api_cost_usd) filter (where j.type = 'create_launchpad') as creation_cost_usd
from launchpads l
join jobs j on j.launchpad_id = l.id
group by l.id, l.slug, l.status
order by api_cost_usd desc;

-- Average creation cost of finished sites.
select count(*) as sites, avg(j.api_cost_usd) as avg_usd, max(j.api_cost_usd) as max_usd
from jobs j
where j.type = 'create_launchpad' and j.status = 'live' and j.api_cost_usd > 0;

-- Approximate cost per UTC day (jobs are dated by their last update, so a job that spans
-- midnight counts in full on its last day; same approximation as the builder's daily seed).
select (j.updated_at at time zone 'utc')::date as day, sum(j.api_cost_usd) as api_cost_usd
from jobs j
where j.api_cost_usd > 0
group by 1
order by 1 desc;
```

### Log lines that print it

The builder logs JSON with pino. The per-request line is `gateway request` (`gateway/server.ts:639`), with `jobId`, `model`, `status`, `stream`, `inputTokens`, `outputTokens`, `estimated`, `costUsd` (this request), `jobCostUsd` (job total so far) and `durationMs`. Related lines:

| Message | Level | Meaning |
|---|---|---|
| `gateway request` | info | One line per upstream call, with `costUsd` and `jobCostUsd` |
| `daily API budget threshold reached` | warn | 80 % of the daily budget, with `dailyTotalUsd` (`server.ts:445`); also a Telegram alert `gateway_daily_budget:<day>` |
| `failed to record API cost` / `could not record the job API cost` | error / warn | The cost could not be written to the database (`server.ts:621`, `cost-store.ts:118`) |
| `could not read the API cost already spent today; the gateway refuses requests until it can` | warn | Daily seed failed at startup (`index.ts:333-340`) |
| `review agent finished` | info | Pass 2 of the visual review, with `reportedCostUsd` (the agent CLI's own figure) and `budgetUsd` (`run-review.ts:293-294`) |

The `agent finished` line of pass 1 does not carry a cost; use `gateway request` or the column.

### Documented figures

The only documented numbers are the budget and prices above, plus: `docs/OPERATIONS.md:45` (visual review "costs up to 5 USD more per job, within the job budget"), `docs/MAINNET.md:135` (daily budget), `docs/OPERATIONS.md:113` (watch the Anthropic console weekly), `docs/SECURITY.md:24` (monthly spending limit set in the provider console too), and the product economics in `docs/PRODUCT.md:78-88`: creation price about 33 USD, "margin per creation ~15 USD". None states the actual model cost of a site.

## 5. Suggested external checks

These follow from the sections above; they are suggestions, not repo behavior.

| Check | Expect | Notes |
|---|---|---|
| `GET https://<web host>/api/health` every 1 to 5 minutes | 200 and exactly `{"ok":true}` | 503 with a `code` means a configuration problem to fix on the server; no response or a platform 5xx means the site is down. Do not follow redirects blindly |
| `GET https://<web host>/api/flags` (optional) | 200 JSON with `signupsPaused` | 503 `NETWORK` means the web cannot read Supabase (with the lag described in section 2) |
| Client site spot check | 200 on the home page of one known site | Reflects Vercel and the site, not the workers |
| Advisories | The tables in section 3 | Re-read this list after each dependency update, since pins move |

Not available without a secret, and covered by FORGE's own alerts instead: builder and signer liveness, queue and job state, RPC provider health, model API health, wallet balances.
