# MAINNET — configuration reference

One place to fill every mainnet environment file. Built from the code (zod schemas and env readers) at `main` e9c27d9; each section names the files it was read from. If a row disagrees with the code, the code wins: fix this file. Values are never written here: only fixed public ids that already live in the repo.

Related: `docs/OPERATIONS.md` (alerts, kill switches, day-to-day), `docs/INTERFACES.md` §8 (which service reads what), `docs/DECISIONS.md` (D7, D33, D34, D35), `docs/METEORA.md` (fees and referral accounts), `tasks/07-MAINNET.md` (launch plan).

## 0. How to read

- **Req.**: `yes` = the service refuses to start, answers 503 or breaks its main flow without it; `no` = optional or has a safe default; `cond` = required under the condition in the row.
- **Secret** `S` = never in git, logs, chat, a client project or a ticket. Blank = public or non-secret (addresses, URLs without key, tuning numbers).
- `NEXT_PUBLIC_*` values are inlined at build time: change one, then rebuild and redeploy.
- Empty lines count as unset (the builder and the signer drop empty values; the web trims them).
- Errors and logs name variables, never values. `SOLANA_CLUSTER` defaults to `devnet` everywhere (PLANEXECUTE.md rule 4): on mainnet it must be set explicitly, on every service.
- Booleans: signer `*_PAUSED` and `*_DRY_RUN` accept `true`/`false`/`1`/`0`; `FORGE_CONVERT_LIVE` is live only when exactly `true` (`jobs/convert.ts`); `FORGE_BUYBACK_LIVE` accepts exactly `true` or `false` (`jobs/buyback.ts`).

## 1. Fixed public values (in the repo, not environment)

| Value | Where | Note |
|---|---|---|
| Jupiter Ultra referral project `DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc` | `packages/core/src/jupiter-referral.ts:78` | the Jupiter referral account must belong to it; core refuses any other project (`project_mismatch`) |
| Jupiter referral program `REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3` | `packages/core/src/jupiter-referral.ts:70` | owner of the referral account on-chain |
| Squads v4 program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | `@sqds/multisig` `PROGRAM_ID`, `apps/signer/src/jobs/squads.ts:78` | vault PDA seeds `["multisig", multisig, "vault", index]` |
| Mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `packages/core/src/payments.ts:67` | the signer and the web check the RPC against it |
| Jupiter plugin referral fee: 50 bps | `FEES.jupiterIntegratorFeeBps`, `packages/shared/src/constants.ts:21` | D7; accepted range 50 to 255 bps (`packages/core/src/constants.ts:109`); Jupiter keeps 20 %, FORGE keeps 0.4 % |
| Platform fee on our own swaps (before graduation): 30 bps | `FEES.platformFeeBps`, `packages/shared/src/constants.ts:16` | D7; paid to `FORGE_PLATFORM_FEE_WALLET` |
| Migration threshold 10 SOL, creation $33, modification $5.5 | `packages/shared` | not environment |

## 2. apps/web (Vercel project of the FORGE site)

Set in the Vercel project (Production). Read at start-up by `instrumentation.ts` -> `src/server/readiness.ts`: every problem is logged by variable name (`server_not_ready`) and `GET /api/health` answers 503 `{ ok: false, code }` (`config_invalid` or `cluster_mismatch`) until fixed. Check it after every deployment.

### 2.1 Cluster and RPC

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SOLANA_CLUSTER` | yes | `mainnet-beta` | `devnet` | the whole server runs on devnet; a mismatch with `NEXT_PUBLIC_SOLANA_CLUSTER` makes health answer 503 `cluster_mismatch` (`readiness.ts`) | |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | yes (production) | `mainnet-beta`, same as `SOLANA_CLUSTER`; rebuild after a change | unset | unset in production or different: health 503 `cluster_mismatch`; explorer links follow it | |
| `RPC_URL` | yes | Helius mainnet URL, key A. Host must not contain `devnet` or `testnet` (`payments/config.ts`, `jobs/config.ts`) | none | payments, launch checks, gating and the upload mint check fail; health 503 `config_invalid` | S |
| `RPC_RELAY_UPSTREAM_URL` | yes (production or mainnet) | a second Helius mainnet URL, key B, https only (`rpc/config.ts`) | none (no fallback to `RPC_URL` in strict mode) | relay answers 503: client sites cannot read the chain or trade. Same key as `RPC_URL`: relay traffic spends the payment quota (startup warning) | S |
| `RPC_RELAY_ANONYMOUS` | no | leave unset or `off` | `off` on mainnet or production, `on` otherwise | `on`: callers with no Origin and no token get the creator-claim methods and their own ceiling | |
| `RPC_RELAY_TOKEN_SECRET` | cond | yes on mainnet: at least 32 bytes, the same value as the builder's | unset (server-token tier off) | too short: health 503; different from the builder's: tokens of client sites are refused (uploads and `/api/coins` of the sites break) | S |

### 2.2 Supabase and sign-in

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SUPABASE_URL` | yes | project URL (same project as builder and signer) | none | payments, routes, chat, flags fail; health 503 | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service role key of that project | none | same | S |
| `SUPABASE_ANON_KEY` | cond | anon key; may be left out when `NEXT_PUBLIC_SUPABASE_ANON_KEY` is set (`flags/flags.ts` reads either) | none | `GET /api/flags` fails, health 503 | |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | same as `SUPABASE_URL` | none | no Realtime or RLS reads in the browser; CSP `connect-src` lacks the host | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | same as `SUPABASE_ANON_KEY` | none | same | |
| `SUPABASE_JWT_SECRET` | yes | JWT signing secret of the Supabase project (HS256), at least 32 bytes | none | tokens minted by the site are not accepted by Supabase; health 503 if absent or short | S |
| `NEXT_PUBLIC_APP_URL` | yes | `https://<FORGE domain>`; its host is the sign-in domain and its origin the only one allowed for state-changing requests | none | wallet sign-in and POSTs refused; relay refuses the FORGE site origin | |
| `SESSION_SECRET` | yes | at least 32 random bytes (`openssl rand -base64 48`) | none | health 503; rotating it signs everybody out | S |
| `FORGE_BETA_MODE` | cond | `on` (closed beta, wallet allowlist) or `off` (public). | `on` in production, `off` otherwise | `on` with no valid allowlist: nobody can sign in and health answers 503 (`beta/config.ts`); any other value: closed | |
| `FORGE_BETA_ALLOWLIST` | cond | comma-separated base58 wallets, required while the beta is on (max 10,000); re-read on every request | none | one invalid entry or an empty list closes sign-in for everybody | |
| `NEXT_PUBLIC_USE_MOCKS` | no | unset or `0`. `.env.example` has the line commented out: never enable it in production | unset | no effect in a production build, but the dev pages and mocks assume it is off | |

### 2.3 Payments, price guard, $FORGE gate

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `FORGE_CASHBOX_WALLET` | yes | public key of the signer keystore role `cashbox` (printed by `--init-keys`) | none | payments verified against the wrong recipient; health 503 if invalid | |
| `NEXT_PUBLIC_FORGE_CASHBOX_WALLET` | yes (production build) | same value; inlined at build | none | unset or invalid: the browser refuses every payment (fail closed, `client/verify.ts`); different: it refuses the quote | |
| `JUPITER_API_KEY` | no (recommended) | Jupiter developer portal key; only used for the SOL/USD rate (`payments/price-source.ts`) | none (keyless lite endpoint) | without it quotes may fail with 503 `PRICE_UNAVAILABLE` under the keyless rate limit | S |
| `SOL_USD_PRICE_MIN` | no | keep the default | 10 | a rate below it is refused (503 `PRICE_UNAVAILABLE`) | |
| `SOL_USD_PRICE_MAX` | no | keep the default; lower the signer floors first if you ever raise it | 5000 | the signer's payment floors are derived from it (section 6, rule 13) | |
| `SOL_USD_PRICE_MAX_DEVIATION_PCT` | no | keep the default | 25 | a move larger than this from the last accepted rate is refused | |
| `FORGE_MINT` | no | absent until the $FORGE launch (D13); then the $FORGE mint, same as the signer's | unset (gate off) | set but invalid: gate errors; set without `FORGE_GATING_AMOUNT`: gate errors | |
| `FORGE_GATING_AMOUNT` | cond | required when `FORGE_MINT` is set: raw units (digits only), owner decision, reviewed weekly | none | gate raises `FORGE_GATING_AMOUNT is not configured`; `0` lets everybody in | |

### 2.4 Design chat

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | key of the chat workspace; set a monthly spend limit in the provider console | none | chat unavailable; health 503 (`chat/config.ts`) | S |
| `CHAT_CONVERSATION_COST_CAP_USD` | no | keep | 1 | chat stops at this model spend per conversation | |
| `CHAT_WALLET_DAILY_COST_CAP_USD` | no | keep | 5 | per wallet, rolling 24 h | |
| `CHAT_WALLET_MESSAGES_PER_10_MIN` | no | keep | 15 | rate limit per wallet | |
| `CHAT_WALLET_MESSAGES_PER_DAY` | no | keep | 150 | rate limit per wallet | |
| `CHAT_IP_MESSAGES_PER_10_MIN` | no | keep | 40 | rate limit per IP | |

### 2.5 Uploads, R2, client sites, cron

Coin uploads are not part of readiness: with a bad R2 block they answer 503 `NOT_CONFIGURED` and health stays 200. Check them by hand.

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `R2_ACCOUNT_ID` | yes | Cloudflare account id, 32 hex characters | none | uploads 503 | |
| `R2_ACCESS_KEY_ID` | yes | R2 API token (write access to the bucket only) | none | uploads 503 | S |
| `R2_SECRET_ACCESS_KEY` | yes | secret of that token (16 characters or more, no whitespace) | none | uploads 503 | S |
| `R2_BUCKET` | yes | bucket name; add a lifecycle rule deleting `pending/` after 1 day (OPERATIONS.md) | none | uploads 503 | |
| `R2_PUBLIC_URL` | yes | public https base of the bucket, no query; same value as the builder's | none | uploads 503; CSP `img-src` lacks the host; images not rendered | |
| `R2_ENDPOINT` | no | S3 endpoint override. | `https://<account>.r2.cloudflarestorage.com` | uploads 503 if invalid | |
| `CLIENTS_DOMAIN` | cond | yes on mainnet: the clients domain, same as the builder's (a domain separate from FORGE's) | none | no `<slug>.<domain>` origin in the relay, uploads, coin metadata `external_url` or CSP `frame-src`; only recorded `site_host` values work | |
| `FORGE_INTERNAL_CRON_SECRET` | cond | yes if the upload sweep runs (it should): at least 32 bytes, sent as `Authorization: Bearer` by an external scheduler. | unset (route answers 503) | wrong: 401; unset: abandoned uploads in `pending/` are never swept | S |

### 2.6 Relay rate-limit overrides (tuning, all optional, `src/server/rpc/config.ts`)

`RPC_RELAY_GLOBAL_UNITS_PER_MINUTE` (default 60000, split 25 % FORGE site, 50 % client sites, 15 % server tokens, 10 % anonymous), `RPC_RELAY_GLOBAL_FORGE_UNITS_PER_MINUTE`, `RPC_RELAY_GLOBAL_SITES_UNITS_PER_MINUTE`, `RPC_RELAY_GLOBAL_SERVER_UNITS_PER_MINUTE`, `RPC_RELAY_GLOBAL_ANONYMOUS_UNITS_PER_MINUTE`, `RPC_RELAY_IP_UNITS_PER_MINUTE`, `RPC_RELAY_ORIGIN_UNITS_PER_MINUTE` (alert threshold only), `RPC_RELAY_SERVER_UNITS_PER_MINUTE`, `RPC_RELAY_ANONYMOUS_UNITS_PER_MINUTE` (alert threshold only), `RPC_RELAY_SENDS_PER_MINUTE`, `RPC_RELAY_SERVER_SENDS_PER_MINUTE`. Positive numbers; anything else is a startup error. Leave unset at first boot; size them against the Helius plan behind `RPC_RELAY_UPSTREAM_URL`. `RPC_RELAY_ANONYMOUS_IP_UNITS_PER_MINUTE` is no longer read.

## 3. apps/builder (VPS 1)

Validated at start-up (`src/index.ts`, `worker/config.ts`, `sandbox/config.ts`, `github.ts`, `vercel.ts`): the process refuses to start and names the variables. Order: environment, FORGE addresses, public variables of client projects, sandbox timeouts, sandbox config, signer cluster check (retried 2, 4, 8, 16 s, then exit), cleanup, gateway, worker.

### 3.1 Cluster, database, worker

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SOLANA_CLUSTER` | yes | `mainnet-beta`; also copied into every client project | `devnet` | start-up fails if the signer reports another cluster | |
| `SUPABASE_URL` | yes | same project as web and signer | none | start-up fails | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service role key | none | start-up fails | S |
| `BUILDER_WORKER_ID` | no | leave unset | `builder-<host>-<pid>-<random>` | duplicate ids confuse job locks | |
| `BUILDER_CONCURRENCY` | no | 1 to 8; size to the VPS (agent defaults: 2 GB and 2 CPUs per job, plus 4 GB for install and build steps) | 1 | jobs queue, or the host swaps | |
| `BUILDER_POLL_INTERVAL_MS` | no | 500 to 300000 | 5000 | latency | |
| `BUILDER_LOG_LEVEL` | no | `info` | `info` | | |
| `TELEGRAM_BOT_TOKEN` | yes on mainnet | operator alert bot | none | start-up fails on mainnet-beta | S |
| `TELEGRAM_CHAT_ID` | yes on mainnet | team group id | none | start-up fails on mainnet-beta | |

### 3.2 Model gateway and agent

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | key of the builder workspace (20 characters or more); only the gateway holds it, never a sandbox | none | start-up fails | S |
| `FORGE_GATEWAY_HOST` | cond | Linux: the docker0 address (usually `172.17.0.1`), never `0.0.0.0` | `127.0.0.1` | sandboxes cannot reach the gateway, or it listens on a public interface | |
| `FORGE_GATEWAY_PORT` | no | free port | 8787 | bind error | |
| `FORGE_GATEWAY_UPSTREAM_URL` | no | leave unset | `https://api.anthropic.com` | requests fail | |
| `FORGE_GATEWAY_DAILY_BUDGET_USD` | no | owner decision; alert at 80 % | 200 | the gateway refuses requests once the UTC-day total is reached | |
| `BUILDER_AGENT_MODEL` | no | a model priced in `src/gateway/config.ts` | `claude-sonnet-5-5` | start-up error if unpriced | |
| `BUILDER_AGENT_BIN` | no | leave unset | `claude` | agent cannot start | |
| `BUILDER_AGENT_MAX_TURNS` | no | 5 to 500 | 80 | | |
| `BUILDER_AGENT_MEMORY_MB` | no | 512 to 16384 | 2048 | OOM in the sandbox | |
| `BUILDER_AGENT_CPUS` | no | 0.5 to 8 | 2 | | |
| `BUILDER_VISUAL_REVIEW` | no | `off` at first (`on` needs `FORGE_SANDBOX_REVIEW_IMAGE`) | `off` | `on` without the image: review stays off, warning at start | |

### 3.3 Sandbox (`apps/builder/docker/README.md`)

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `FORGE_SANDBOX_IMAGE` | yes | image id printed by `docker/build-images.sh`, pinned (`sha256:...` or `name@sha256:...`) | none | start-up fails | |
| `FORGE_SANDBOX_PROXY_IMAGE` | yes | same script, pinned | none | start-up fails | |
| `FORGE_SANDBOX_REVIEW_IMAGE` | cond | only for `BUILDER_VISUAL_REVIEW=on`; pinned | none | review stays off | |
| `FORGE_SANDBOX_JOBS_ROOT` | yes | absolute path on a size-limited filesystem | none | start-up fails | |
| `FORGE_SANDBOX_GATEWAY_UPSTREAM` | yes | `host:port` of the gateway as the egress proxy sees it, e.g. `host.docker.internal:8787` | none | start-up fails (`index.ts`) | |
| `FORGE_SANDBOX_RUNTIME` | no | `runsc` (gVisor, recommended) | `runc` | weaker isolation | |
| `FORGE_SANDBOX_UID` / `FORGE_SANDBOX_GID` | no | run the builder as this uid, or as root | image default | job folders unreadable | |
| `FORGE_DOCKER_BIN` | no | leave unset | `docker` | | |
| `FORGE_SANDBOX_INSTALL_TIMEOUT_MINUTES` | no | 1 to 60; `2 x (install + build) + 30 min` must fit the 90-minute job cap | 10 | start-up refuses | |
| `FORGE_SANDBOX_BUILD_TIMEOUT_MINUTES` | no | 1 to 60 | 15 | same | |
| `FORGE_SANDBOX_STEP_MEMORY_MB` | no | 2048 to 8192 | 4096 | OOM or a starved host | |

### 3.4 GitHub App, Vercel

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `GITHUB_APP_ID` | yes | id of the organization GitHub App (contents read/write, one repo per token) | none | start-up fails | |
| `GITHUB_ORG` | yes | organization that owns client repos | none | start-up fails | |
| `GITHUB_APP_PRIVATE_KEY_PATH` | cond | path of the PEM file (preferred); one of path or inline key is required | none | start-up fails | S (the file) |
| `GITHUB_APP_PRIVATE_KEY` | cond | inline PEM (`\n` escapes accepted), used only without the path | none | same | S |
| `GITHUB_TEMPLATE_REPO` | no | template repository in the org | `launchpad-template` | repo creation fails | |
| `GITHUB_REPO_DENYLIST` | no | extra repository names the builder must never touch (the FORGE monorepo is always refused) | empty | | |
| `VERCEL_TOKEN` | yes | token of the Vercel team (10 characters or more) | none | start-up fails | S |
| `VERCEL_TEAM_ID` | cond | `team_...`; one of id or slug when projects live in a team | none | projects created in the wrong scope | |
| `VERCEL_TEAM` | cond | team slug, used when no id | none | same | |
| `CLIENTS_DOMAIN` | yes | clients domain (`<slug>.<domain>`), same as web's | none | start-up fails; sites served at the recorded `*.vercel.app` host only | |

### 3.5 Public values copied into client projects (D21: public values only)

The builder never forwards `RPC_URL`, `JUPITER_API_KEY`, `R2_*` write keys or `RPC_RELAY_TOKEN_SECRET`; `vercel.ts` refuses them (`PROJECT_ENV_FORBIDDEN`). A twin given explicitly must equal its source or the variable is dropped and start-up fails.

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `FORGE_REVENUE_WALLET` | yes | public key of signer keystore role `revenue` | none | start-up fails if invalid; wrong value: sites refuse swaps (referral owner check) | |
| `FORGE_PLATFORM_FEE_WALLET` | yes | the same address as `FORGE_REVENUE_WALLET` | none | sites refuse every curve swap and first buy (`PLATFORM_FEE_WALLET_MISMATCH`); not compared by the builder itself | |
| `FORGE_METEORA_REFERRAL_ACCOUNT` | yes | standalone WSOL token account owned by the revenue wallet (section 5) | none | sites refuse swaps if it is not held by the revenue wallet | |
| `FORGE_JUPITER_REFERRAL_ACCOUNT` | yes | named referral account of the Ultra project, partner = revenue wallet | none | trades after graduation pay no one, or `claim_v2` can never claim | |
| `NEXT_PUBLIC_FORGE_RPC_RELAY_URL` | yes | `https://<FORGE web host>` (a bare origin gets `/api/rpc`); https, no query, no key, not the provider host | none | start-up fails (invalid); sites cannot trade or create coins | |
| `R2_PUBLIC_URL` | yes | same as web's `R2_PUBLIC_URL` | none | start-up fails; images and CSP break | |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | no | derived from `SOLANA_CLUSTER`; leave unset | derived | different from `SOLANA_CLUSTER`: start-up fails | |
| `NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT` | no | derived; leave unset | derived | different from its source: start-up fails | |
| `NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET` | no | derived; leave unset | derived | same | |
| `NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT` | no | derived; leave unset | derived | same | |
| `NEXT_PUBLIC_FORGE_REVENUE_WALLET` | no | derived; leave unset (listed with the other twins in the builder's `.env.example`) | derived | same | |
| `NEXT_PUBLIC_R2_PUBLIC_URL` | no | derived; leave unset | derived | same | |
| `RPC_RELAY_TOKEN_SECRET` | yes | at least 32 bytes, the same value as web's; derives each site's `FORGE_RPC_RELAY_TOKEN`; never sent to a project | none | start-up fails; a different value than web's: every site token is refused | S |

### 3.6 Signer link, sleep cycle

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SIGNER_URL` | yes | `http://<signer private address>:8787`. The signer speaks plain http: use the private network between the two VPS | none | start-up fails (unreachable after 5 tries) | |
| `SIGNER_HMAC_SECRET` | yes | at least 32 bytes, the same value as the signer's | none | start-up fails on a rejected request | S |
| `SIGNER_TIMEOUT_MS` | no | 5000 to 600000 | 120000 | the configs route waits for confirmations; too low: false failures | |
| `BUILDER_SLEEP_ENABLED` | no | `true` | `true` | | |
| `BUILDER_SLEEP_INTERVAL_HOURS` | no | 1 to 168 | 24 | | |
| `BUILDER_DISABLED_SWEEP_MINUTES` | no | 1 to 1440 | 15 | disabled sites stay up longer | |


## 4. Signer (VPS 2)

Parsed at start-up (`runtime/env.ts` and the jobs' `...FromEnv` parsers, `server.ts`, `packages/core/src/addresses.ts`); anything malformed stops the process before a key is opened. Run under a supervisor with `LimitCORE=0`. `SIGNER_KEYSTORE_PASSPHRASE` and `SUPABASE_SERVICE_ROLE_KEY` are removed from the process environment once parsed, `SIGNER_HMAC_SECRET`, `TELEGRAM_BOT_TOKEN` and `JUPITER_API_KEY` once consumed.

### 4.1 Cluster, services

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SOLANA_CLUSTER` | yes | `mainnet-beta` | `devnet` | the builder refuses to start against a signer on another cluster | |
| `RPC_URL` | yes | Helius mainnet URL (https). Its genesis hash is compared with mainnet at start-up | none | start-up fails (`RPC_URL does not serve SOLANA_CLUSTER`) | S |
| `SUPABASE_URL` | yes | same project as web and builder | none | start-up fails | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service role key (20 characters or more) | none | start-up fails | S |
| `TELEGRAM_BOT_TOKEN` | yes | alert bot (required on mainnet-beta and in production) | none | start-up fails | S |
| `TELEGRAM_CHAT_ID` | yes | team group id | none | start-up fails | |
| `JUPITER_API_KEY` | cond | Jupiter developer portal key; required as soon as `FORGE_CONVERT_LIVE=true` or `FORGE_BUYBACK_LIVE=true` on mainnet, with either `JUPITER_SWAP_API` | none | start-up error when a live job lacks it; dry runs work without it | S |
| `JUPITER_API_URL` | no | leave unset (https only) | `https://api.jup.ag/swap/v2` (`/swap/v1` with `JUPITER_SWAP_API=v1`) | a URL of the other API, or http, is a start-up error; quotes fail | |
| `JUPITER_SWAP_API` | no | leave unset | `v2` (Swap API V2 `/build`, the signer assembles the transaction) | `v1` = Metis rollback for one release (restart, no deploy); any other value is a start-up error | |
| `NODE_ENV` | no | set `production` explicitly. Anything but `development` or `test` counts as production, unset included | unset (= production) | `development` relaxes the IP allowlist to loopback | |
| `LOG_LEVEL` | no | `info` | `info` | | |

### 4.2 FORGE addresses (`packages/core/src/addresses.ts`; a missing or invalid one stops the start)

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `FORGE_MULTISIG_VAULT` | yes | Squads v4 vault PDA of `FORGE_SQUADS_MULTISIG` at `FORGE_SQUADS_VAULT_INDEX` (0): the vault address shown in the Squads app, not the multisig account. Receives claims, sweeps and revenue forwards | none | funds go to the wrong place; with Squads variables set, a mismatch makes the buyback configuration refused (section 4.7) | |
| `FORGE_CASHBOX_WALLET` | yes | public key of keystore role `cashbox` | none | start-up fails if the keystore `cashbox` key is another address | |
| `FORGE_REVENUE_WALLET` | yes | public key of keystore role `revenue` | none | mainnet start-up refuses (`revenueWiringProblems`) | |
| `FORGE_PLATFORM_FEE_WALLET` | yes | the same address as `FORGE_REVENUE_WALLET` | none | mainnet start-up refuses | |
| `FORGE_METEORA_REFERRAL_ACCOUNT` | yes | standalone WSOL token account owned by the revenue wallet, rent-exempt (section 5) | none | mainnet start-up refuses if its owner is not the revenue wallet; below rent: high alert `fee_recipient_not_rent_exempt` | |
| `FORGE_JUPITER_REFERRAL_ACCOUNT` | yes | named referral account, Ultra project, partner = revenue wallet (section 5) | none | the claims job refuses a foreign account (immediate alert) | |
| `FORGE_MINT` | no | unset until the $FORGE launch; then the mint | unset | buyback stays in simulation; the conversion never sells it (auto-excluded) | |

### 4.3 Keystore, journals, HMAC server

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SIGNER_KEYSTORE_PASSPHRASE` | yes | at least 32 characters, no surrounding whitespace; keep an offline copy | none | start-up fails; losing it loses every key | S |
| `SIGNER_KEYSTORE_DIR` | no | absolute path, backed up with the journals | `./keystore` | start-up fails (`no payer key in the keystore`) | |
| `SIGNER_JOURNAL_DIR` | no | absolute path; holds `signer.lock`, `refund-ledger.*`, `revenue-forward.*`, `claim-receipt.*`, `buyback.day-*`: never delete | `./journal` | payments, refunds or the buyback budget can repeat or vanish | |
| `SIGNER_HMAC_SECRET` | yes | at least 32 bytes, same as the builder's | none | start-up fails; mismatch: every builder call is 401 | S |
| `SIGNER_ALLOWED_IPS` | yes | exact IPs of the builder host as the signer sees them, comma separated, no CIDR | none (production: all requests refused) | empty: builder locked out; too wide: exposes the signer | |
| `SIGNER_HOST` | no | the private interface address | `0.0.0.0` | listens on every interface | |
| `SIGNER_PORT` | no | free port | 8787 | bind error | |
| `SIGNER_URL` | no | not read by the signer (builder's variable, listed for reference) | | | |
| `SIGNER_SHUTDOWN_TIMEOUT_SECONDS` | no | 1 to 3600 | 120 | | |

### 4.4 Signing routes (`/v1/configs`, `/v1/launch-coin/prepare`) and priority fees

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SIGNER_COIN_METADATA_URL` | yes | `https://<web host>/api/coin-meta/{slug}` (exactly one `{slug}` or `{launchpadId}`), at most 106 bytes with a 32-byte slug. Immutable on-chain once coins use it | none | start-up fails; a later change breaks every existing coin's metadata | |
| `SIGNER_PRIORITY_FEE_MICRO_LAMPORTS` | no | `10000` (floor for quiet accounts, OPERATIONS.md) | 0 | too low: transactions dropped under congestion; above the cap: start-up error | |
| `SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS` | no | keep | 1000000 (max 1000000; 0 = off) | | |
| `SIGNER_PRIORITY_FEE_PERCENTILE` | no | keep; raise to 90 if transactions land late | 75 | | |
| `SIGNER_PRIORITY_FEE_MAX_LAMPORTS` | no | keep | 500000 (max 1000000) | above the maximum: start-up error | |
| `SIGNER_ROUTES_PAUSED` | no | `false`; see section 8 | `false` | `true`: routes answer 503 | |
| `SIGNER_MAX_LAUNCHPADS_PER_DAY` | no | owner decision, 1 to 1000 | 20 | past it new launchpads are refused (503, alert) | |
| `SIGNER_MIN_CREATION_PAYMENT_LAMPORTS` | no | leave empty (default from `SOL_USD_PRICE_MAX`) | 5940000 | above the smallest real quote: legitimate payments refused | |
| `SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS` | no | leave empty | 990000 | same | |

### 4.5 Money jobs

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `SIGNER_CLAIMS_MIN_LAMPORTS` | no | keep | 10000000 (0.01 SOL) | below: claims cost more than they bring | |
| `SIGNER_CLAIMS_MIN_POSITION_LAMPORTS` | no | keep | 50000000 | each position claim costs about 0.002 SOL of rent | |
| `SIGNER_CLAIMS_FEE_PAYER` | no | `payer` | `payer` | `creator`: creator wallets must hold SOL | |
| `SIGNER_CLAIMS_INTERVAL_HOURS` | no | keep | 1 | | |
| `SIGNER_CLAIMS_PAUSED` | no | `false`; see section 8 | `false` | | |
| `SIGNER_JUPITER_CLAIMS_MINTS` | no | leave empty (wrapped SOL from 0.01 SOL, USDC from 1 USDC); other mints as `<mint>:<min raw units>` | empty | a mint with no threshold is a start-up error | |
| `SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS` | no | keep | 24 | | |
| `SIGNER_JUPITER_CLAIMS_PAUSED` | no | `false`; section 8 | `false` | | |
| `SIGNER_CASHBOX_RESERVE_LAMPORTS` | no | keep | 100000000 | kept in the cashbox for refunds and fees | |
| `SIGNER_CASHBOX_MIN_SWEEP_LAMPORTS` | no | keep | 100000000 | | |
| `SIGNER_CASHBOX_MAX_SWEEP_LAMPORTS` | no | empty = no cap | none | | |
| `SIGNER_CASHBOX_DRY_RUN` | no | `true` at first boot (section 8) | `true` | `false` sweeps the surplus to the vault | |
| `SIGNER_CASHBOX_INTERVAL_HOURS` | no | keep | 24 | | |
| `SIGNER_CASHBOX_PAUSED` | no | `false`; section 8 | `false` | | |
| `SIGNER_REFUNDS_MAX_LAMPORTS` | no | keep | 2000000000 | a larger refund is left to manual handling | |
| `SIGNER_REFUNDS_INTERVAL_MINUTES` | no | keep | 5 | | |
| `SIGNER_REFUNDS_PAUSED` | no | `false`; section 8 | `false` | | |
| `FORGE_CONVERT_LIVE` | no | `false` at first boot; `true` only with `JUPITER_API_KEY` (section 8) | `false` | `true` enables real swaps (cashbox/payer conversion and the revenue job's swaps) | |
| `SIGNER_CONVERT_ROLES` | no | `cashbox` | `cashbox` | only `cashbox` and `payer`; the buyback and revenue wallets are refused | |
| `SIGNER_CONVERT_INTERVAL_HOURS` | no | keep | 24 | | |
| `CONVERT_SLIPPAGE_BPS` | no | keep | 50 (1 to 500) | above `CONVERT_MAX_SLIPPAGE_BPS`: start-up error | |
| `CONVERT_MAX_SLIPPAGE_BPS` | no | keep | 100 | quotes above are refused | |
| `CONVERT_MAX_PRICE_IMPACT_BPS` | no | keep | 100 (1 to 1000) | quotes above are refused | |
| `CONVERT_MIN_OUTPUT_LAMPORTS` | no | keep | 10000000 | smaller swaps skipped as dust | |
| `CONVERT_MAX_INPUT_AMOUNT` | no | keep (1,000 USDC in raw units); 0 = no cap | 1000000000 | bounds the loss of one run | |
| `CONVERT_MAX_PRIORITY_FEE_LAMPORTS` | no | keep | 1000000 | with V2, the cap per transaction of the signer's own price; the lower of it and `SIGNER_PRIORITY_FEE_MAX_LAMPORTS` applies | |
| `CONVERT_REQUEST_INTERVAL_MS` | no | keep (free tier: 1 request per second) | 1100 | 429 from Jupiter | |
| `CONVERT_REQUEST_TIMEOUT_MS` | no | keep | 15000 | | |
| `CONVERT_EXCLUDED_MINTS` | no | comma-separated mints never sold; `FORGE_MINT` is added automatically | empty | | |
| `SIGNER_REVENUE_RESERVE_LAMPORTS` | no | keep | 10000000 | kept on the wallet above rent; low: unwrap cannot advance its rent | |
| `SIGNER_REVENUE_MIN_FORWARD_LAMPORTS` | no | keep (must be positive) | 10000000 | | |
| `SIGNER_REVENUE_MIN_UNWRAP_LAMPORTS` | no | keep | 1000000 | | |
| `SIGNER_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS` | no | raise with the priority fee | 100000 | false `revenue_unexpected_outflow` alerts | |
| `SIGNER_REVENUE_DRY_RUN` | no | `true` at first boot (section 8) | `true` | `false` unwraps and forwards; also lets the revenue job call the conversion | |
| `SIGNER_REVENUE_INTERVAL_HOURS` | no | keep | 24 | | |
| `SIGNER_REVENUE_PAUSED` | no | `false`; section 8 | `false` | | |

### 4.6 Watcher (read-only, no kill switch; all optional, `jobs/watch.ts`)

| Variable | Mainnet value | Default | If wrong |
|---|---|---|---|
| `WATCH_INTERVAL_MS` | keep | 60000 (min 5000) | slower detection |
| `WATCH_MAX_BACKOFF_MS` | keep | 900000 | |
| `WATCH_RPC_ERROR_STREAK` | keep | 5 | alert noise |
| `WATCH_OUTFLOW_TOLERANCE_LAMPORTS` | keep | 20000 | false or missed outflow alerts |
| `WATCH_SIGNATURE_LIMIT` | keep | 50 (max 1000) | |
| `WATCH_MAX_SIGNATURE_PAGES` | keep | 20 | |
| `WATCH_MIN_VAULT_LAMPORTS` | keep | 0 | |
| `WATCH_MIN_PLATFORM_FEE_LAMPORTS` | keep | 0 | |
| `WATCH_MIN_CASHBOX_LAMPORTS` | keep; fund the cashbox above it first | 100000000 | high alert at boot if the cashbox is below |
| `WATCH_MIN_PAYER_LAMPORTS` | keep; fund the payer above it first | 200000000 | same for the payer |
| `WATCH_MIN_CREATOR_LAMPORTS` | keep | 0 with `SIGNER_CLAIMS_FEE_PAYER=payer`, else 5000000 | |
| `WATCH_MIN_BUYBACK_LAMPORTS` | `0` until the buyback is live | 0 | |
| `WATCH_MIN_REVENUE_LAMPORTS` | keep | 5000000 | |

### 4.7 Squads spending limit and buyback

A refused buyback configuration ("refused" below) disables the buyback alone, with the high alert `job_module_disabled`; the claims, refunds, routes and watcher keep running. Exception: on mainnet-beta with `FORGE_BUYBACK_LIVE` set to anything but `false`, the signer refuses to start, and with it every other job.

| Variable | Req. | Mainnet value / how to obtain | Default | If wrong | Secret |
|---|---|---|---|---|---|
| `FORGE_SQUADS_MULTISIG` | cond | the multisig account address; with `FORGE_SQUADS_SPENDING_LIMIT` or neither | none (no withdrawer: simulation) | one without the other: refused | |
| `FORGE_SQUADS_SPENDING_LIMIT` | cond | the spending limit account address (section 5) | none | not a distinct account, or fails the on-chain policy: no withdrawal is signed | |
| `FORGE_SQUADS_VAULT_INDEX` | no | leave empty (vault 0) | 0 (0 to 255) | derived vault differs from `FORGE_MULTISIG_VAULT`: refused | |
| `FORGE_BUYBACK_LIVE` | no | `false` until the go-live restart (section 8); then `true` | `false` | `true` with a refused configuration stops the signer on mainnet; any value other than `true`/`false` counts as a live request and is refused (stops it on mainnet) | |
| `BUYBACK_REVENUE_SINCE` | cond | required by `FORGE_BUYBACK_LIVE=true` on mainnet: the go-live instant, ISO 8601 with its zone, e.g. `date -u +%Y-%m-%dT%H:%M:%SZ`. Never moved backwards | unset | unset: refused when live on mainnet; elsewhere high alert `buyback_budget_unconfigured` and no buy | |
| `BUYBACK_ROUTE` | no | leave unset (`jupiter`; `dbc-devnet` is refused on mainnet) | `jupiter` | refused | |
| `FORGE_BUYBACK_DEVNET_TEST` | no | never set on mainnet (refused) | `false` | | |
| `BUYBACK_DEVNET_DBC_POOL` | no | never set on mainnet (refused) | none | | |
| `BUYBACK_DAILY_CAP_LAMPORTS` | yes for a live buyback | `5000000000` (D35), at most `BUYBACK_ORDERS_PER_DAY` x `BUYBACK_MAX_ORDER_LAMPORTS` | 0 (nothing bought) | above orders x max order: refused | |
| `BUYBACK_ORDERS_PER_DAY` | no | `10` | 8 (1 to 48) | | |
| `BUYBACK_MIN_ORDER_LAMPORTS` | no | keep | 10000000 | | |
| `BUYBACK_MAX_ORDER_LAMPORTS` | no | `500000000` | 250000000 | with the default, 8 x 0.25 = 2 SOL holds only a 2 SOL cap | |
| `BUYBACK_SLIPPAGE_BPS` | no | keep | 50 (max 100) | | |
| `BUYBACK_MAX_PRICE_IMPACT_BPS` | no | keep | 100 (max 100) | | |
| `BUYBACK_FEE_RESERVE_LAMPORTS` | no | keep; the bot wallet must hold it before the first day (withdrawals never fund it) | 20000000 | orders skipped `insufficient_funds` | |
| `BUYBACK_MAX_LATENESS_MINUTES` | no | keep | 30 | a slot later than this is skipped | |
| `BUYBACK_DAY_MARGIN_MINUTES` | no | keep | 10 | | |
| `BUYBACK_MAX_PRIORITY_FEE_LAMPORTS` | no | keep | 100000 | also feeds the allowance below; with V2, the cap per transaction of the signer's own price (the lower of it and `SIGNER_PRIORITY_FEE_MAX_LAMPORTS` applies) | |
| `BUYBACK_ORDER_FEE_ALLOWANCE_LAMPORTS` | no | leave empty | `BUYBACK_MAX_PRIORITY_FEE_LAMPORTS` + 10000 | raises the Squads minimum (rule 12) | |
| `BUYBACK_TICK_SECONDS` | no | keep | 60 (5 to 3600) | | |
| `BUYBACK_PAUSED` | no | `false`; section 8 | `false` | | |
| `BUYBACK_REQUEST_INTERVAL_MS` | no | keep | 1100 | | |
| `BUYBACK_REQUEST_TIMEOUT_MS` | no | keep | 15000 | | |

## 5. Client sites (built from `apps/launchpad-template`, hosted on Vercel)

Nothing is set by hand: the builder injects these into each client Vercel project (`apps/builder/src/vercel.ts`, `PROJECT_ENV_ALLOWLIST`). The site holds no secret except its own relay token.

| Variable | Source | Public | Note |
|---|---|---|---|
| `SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_CLUSTER` | builder `SOLANA_CLUSTER` | yes | `forge.config.json#onchain.cluster` wins once the launchpad is set up |
| `FORGE_REVENUE_WALLET`, `NEXT_PUBLIC_FORGE_REVENUE_WALLET` | builder | yes | the site refuses a swap whose Meteora referral account is not held by it |
| `FORGE_PLATFORM_FEE_WALLET`, `NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET` | builder | yes | only recipient of the 30 bps transfer; must be the revenue wallet |
| `FORGE_METEORA_REFERRAL_ACCOUNT`, `NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT` | builder | yes | referral account of every curve swap |
| `FORGE_JUPITER_REFERRAL_ACCOUNT`, `NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT` | builder | yes | plugin `referralAccount`; fee 50 bps fixed in code |
| `NEXT_PUBLIC_FORGE_RPC_RELAY_URL` | builder | yes | all RPC goes through the relay; also CSP `connect-src` |
| `R2_PUBLIC_URL`, `NEXT_PUBLIC_R2_PUBLIC_URL` | builder | yes | read-only image base |
| `POOL_CONFIG_KEY`, `NEXT_PUBLIC_POOL_CONFIG_KEY` | builder, per launchpad | yes | the launchpad's config keys (comma separated, 20 at most) |
| `FORGE_RPC_RELAY_TOKEN` | builder, derived per slug from `RPC_RELAY_TOKEN_SECRET` | **S** (`sensitive`, server only) | grants only that site's relay/upload quota |
| `NEXT_PUBLIC_FORGE_API_URL` | not injected | yes | optional; default is the origin of the relay URL, which must therefore be the FORGE web host |
| `NEXT_PUBLIC_VERCEL_BRANCH_URL` | set by Vercel | yes | used by the token icon |

Forbidden in a client project and refused by the builder: `RPC_URL`, `JUPITER_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `GITHUB_PACKAGES_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `RPC_RELAY_TOKEN_SECRET`.

### The three referral accounts

- **Revenue wallet**: public key of `--init-keys` role `revenue`. Fund it with its rent plus `SIGNER_REVENUE_RESERVE_LAMPORTS` (0.01 SOL by default) before the first run.
- **Meteora referral account** (`FORGE_METEORA_REFERRAL_ACCOUNT`): a standalone wrapped-SOL token account whose owner is the revenue wallet, funded for rent. Not the wallet's associated token account: Jupiter claims land in the associated account and would be booked as Meteora referral. Created by the signer command below at `createWithSeed(payer, "forge-meteora-referral", SPL Token)` (no keypair to keep; `packages/core/src/meteora-referral.ts`). The signer checks the owner at start-up and the command checks everything else (mint, standalone, not frozen, no delegate, no foreign close authority).
- **Jupiter referral account** (`FORGE_JUPITER_REFERRAL_ACCOUNT`): a NAMED referral account of Jupiter's Ultra project (PDA `["referral", project, name]`, `initialize_referral_account_with_name`), with the revenue wallet as partner, plus its v2 collection accounts for wrapped SOL and USDC (the associated token accounts of the referral account: what the plugin pays and `claim_v2` empties; `docs/METEORA.md`, "The platform fee"). An unnamed account can never `claim_v2`. Created by the signer command below (`packages/core/src/jupiter-referral.ts`, verified against the program source: the partner does not sign, the name has 1 to 19 characters and at most 32 bytes, the share is the project's default).
- **The command** (one-off, on the signer host, service stopped, after `--init-keys`; `apps/signer/src/jobs/referral-setup.ts`): `pnpm --filter @forge/signer exec tsx src/index.ts --setup-revenue-referrals [--name forge] [--send]`. The keystore **payer** wallet signs alone, for both accounts: the referral program takes the partner as a plain account and SPL Token `InitializeAccount3` takes the owner from the instruction data, so the revenue key never signs its own setup (and the revenue wallet's outflows stay what the watcher expects: forwards to the vault only). It reads the chain first and skips an account that exists and matches; an account that exists and does not match (owner, mint, standalone; partner, project, name) is refused with its reason (exit code 2, nothing sent). Dry run by default: it prints the plan, the rents the payer pays (about 0.002 SOL for the Meteora account; about 0.003 SOL plus 2 x 0.002 SOL for the Jupiter account and its two collection accounts) and the env lines to come; `--send` signs, journals (`SIGNER_JOURNAL_DIR/referral-setup.<part>.json`, before the broadcast) and confirms, then prints `FORGE_METEORA_REFERRAL_ACCOUNT=...` and `FORGE_JUPITER_REFERRAL_ACCOUNT=...` to set on the signer, the builder and the web. Needs `SOLANA_CLUSTER`, `RPC_URL`, the keystore and journal variables and `SIGNER_PRIORITY_FEE_*` only; `FORGE_REVENUE_WALLET` must be the keystore `revenue` key when set, and the two referral variables, when already set, must be the accounts the command derives (an account created by other means is accepted for the Meteora part when it matches; a Jupiter account of another name is accepted with `--name <that name>`). Exit code 3: sent but not settled, run it again (the same bytes are re-sent, never rebuilt while they may land). On devnet the Meteora part runs the same way and the Jupiter part is skipped (`wrong_cluster`: the program and the Ultra project only exist on mainnet-beta). Fund the payer first (section 9 C).
- **Squads** (`docs/SECURITY.md` section 7, `apps/signer/src/jobs/squads.ts`): vault 0 of the multisig is `FORGE_MULTISIG_VAULT`. The buyback wallet (role `buyback`) is a multisig member with **no permission**, and a SOL spending limit on vault 0 lists it as the only member and the only destination, period `Day`, positive amount.

## 6. Cross-service consistency rules

| # | Rule | Variables | Enforced by | If broken |
|---|---|---|---|---|
| 1 | One cluster everywhere | web `SOLANA_CLUSTER` = `NEXT_PUBLIC_SOLANA_CLUSTER`; builder = signer; sites inherit the builder's | web `readiness.ts` (503 `cluster_mismatch`); builder start-up calls the signer's `/v1/health`; signer genesis check; `vercel.ts` twin check | health 503, builder will not start, signer will not start |
| 2 | Revenue wallet = platform fee wallet = signer `revenue` key | `FORGE_REVENUE_WALLET` (signer, builder, sites), `FORGE_PLATFORM_FEE_WALLET` (signer, builder, sites), keystore role `revenue`; also different from the vault and the cashbox | signer start-up (`revenueWiringProblems`, fatal on mainnet); core `swapFeeAddresses` in the sites; not compared by the builder | signer will not start, or sites refuse every swap |
| 3 | Meteora referral = standalone WSOL account owned by the revenue wallet | `FORGE_METEORA_REFERRAL_ACCOUNT` (signer, builder, sites) | signer reads the owner at start-up; sites check the owner; nothing detects an associated account | wrong owner: refused; associated account: Jupiter claims booked as Meteora referral |
| 4 | Jupiter referral: named, Ultra project, partner = revenue wallet | `FORGE_JUPITER_REFERRAL_ACCOUNT` (signer, builder, sites) | core claim builder (`project_mismatch`, `partner_mismatch`, `referral_account_unnamed`); signer alerts `immediate` | plugin fees lost or unclaimable |
| 5 | Cashbox | `FORGE_CASHBOX_WALLET` (web, signer) = keystore `cashbox` key = `NEXT_PUBLIC_FORGE_CASHBOX_WALLET` (web build) | signer start-up compares the key; browser pins the recipient | client payments land where the signer cannot refund them |
| 6 | Vault | `FORGE_MULTISIG_VAULT` = Squads vault PDA of `FORGE_SQUADS_MULTISIG` + `FORGE_SQUADS_VAULT_INDEX` | signer start-up (`squadsConfigFromEnv`) | buyback refused; the signer stops when it is live on mainnet |
| 7 | HMAC builder -> signer | `SIGNER_HMAC_SECRET` identical on both, 32 bytes or more; clocks within 60 s (NTP on both VPS) | signer HMAC check; builder start-up health call | every request 401 `bad_signature` or `bad_timestamp` |
| 8 | Relay token builder -> web | `RPC_RELAY_TOKEN_SECRET` identical on web and builder (not on the signer) | web relay and upload routes recompute the token | site server routes refused |
| 9 | One Supabase project | `SUPABASE_URL` and service role key on web, builder, signer; anon key and JWT secret of the same project on web; migrations 0001 to 0016 applied | none at start-up | flags, jobs and payments invisible to each other |
| 10 | Domains | web `CLIENTS_DOMAIN` = builder `CLIENTS_DOMAIN`; builder `NEXT_PUBLIC_FORGE_RPC_RELAY_URL` = the origin of web `NEXT_PUBLIC_APP_URL`; `SIGNER_COIN_METADATA_URL` = `https://<web host>/api/coin-meta/{slug}`; web `R2_PUBLIC_URL` = builder `R2_PUBLIC_URL` | origin checks in the relay; CSP; core metadata check | relay refuses sites; coin metadata unreachable (immutable on-chain) |
| 11 | $FORGE | `FORGE_MINT` identical on web and signer; `FORGE_GATING_AMOUNT` on web only | none | gate and buyback point at different mints |
| 12 | Squads limit covers a full day | spending limit amount >= `BUYBACK_DAILY_CAP_LAMPORTS` + `BUYBACK_ORDERS_PER_DAY` x `BUYBACK_ORDER_FEE_ALLOWANCE_LAMPORTS`; and `BUYBACK_DAILY_CAP_LAMPORTS` <= `BUYBACK_ORDERS_PER_DAY` x `BUYBACK_MAX_ORDER_LAMPORTS` | the day budget is cut to `fundable = bot balance above reserve + remaining allowance - orders x allowance` (`jobs/buyback.ts` `computeBudget`); the second inequality is a start-up check | the day buys less than the cap; the rest waits |
| 13 | Payment floors | web `SOL_USD_PRICE_MAX` vs signer `SIGNER_MIN_*_PAYMENT_LAMPORTS`: lower the floors before raising the bound, raise them only after lowering it | none | legitimate payments refused by the signer |
| 14 | Signer reachable only from the builder host | `SIGNER_ALLOWED_IPS` = builder IP(s) exactly; firewall the port to the same address; the web and Vercel never call the signer | signer IP filter (peer address, no proxy headers) | open signer, or builder locked out |
| 15 | Separate Helius keys | web `RPC_URL` and signer `RPC_URL` (payments, claims, buyback) differ from `RPC_RELAY_UPSTREAM_URL` (public relay) | startup warning when equal | relay traffic spends the payment quota |
| 16 | Secrets stay out of client projects | no `RPC_URL`, `JUPITER_API_KEY`, `R2_*` write keys, `RPC_RELAY_TOKEN_SECRET` in the builder's project env | `vercel.ts` allowlist and forbidden list | refused |

Arithmetic for rule 12 with the go-live values and the default allowance: per order, allowance = buy priority cap 100000 + return priority cap 100000 (100000 CU at the signer's 1000000 micro-lamports per CU) + network fees 10000 = 210000; 10 x 210000 = 2100000; plus the withdrawal fee withdrawn with the day's funding, 5000 + 200000 (200000 CU at the same price cap) = 205000. The spending limit must be at least 5000000000 + 2100000 + 205000 = 5002305000 lamports (5.002305 SOL). Round up a little, not much: the limit is the most the bot can ever pull per day.

## 7. Go-live values decided by the owner

| Item | Value | Where | Source |
|---|---|---|---|
| Jupiter plugin fee | 50 bps (accepted range 50 to 255) | fixed in code (section 1) | D7 |
| Platform fee on curve swaps | 30 bps | fixed in code | D7 |
| Revenue wallet | keystore role `revenue`; = `FORGE_REVENUE_WALLET` = `FORGE_PLATFORM_FEE_WALLET`; holds the Meteora referral account; partner of the Jupiter referral account | signer, builder, web (via sites) | D34 |
| Buyback budget | the revenue backlog (revenue forwards + creator claims received by the vault since `BUYBACK_REVENUE_SINCE`, minus the buyback's own withdrawals), capped per UTC day; never a balance or a client payment | signer journals | D35 |
| `BUYBACK_DAILY_CAP_LAMPORTS` | `5000000000` | signer | D35 |
| `BUYBACK_ORDERS_PER_DAY` | `10` | signer | D35 |
| `BUYBACK_MAX_ORDER_LAMPORTS` | `500000000` | signer | D35 |
| `BUYBACK_REVENUE_SINCE` | the go-live instant, set in the same restart as `FORGE_BUYBACK_LIVE=true`; never moved backwards (moving it forwards forgets the backlog before it) | signer | D35 |
| Squads | vault 0 = `FORGE_MULTISIG_VAULT`; two owner keys, threshold 1; the buyback bot is a member with no permission; SOL spending limit, period Day, only member and only destination = the bot, amount >= 5002305000 lamports | Squads app, then `FORGE_SQUADS_MULTISIG` / `FORGE_SQUADS_SPENDING_LIMIT` | D33 |

The owner's decision (2026-10-17, `docs/DECISIONS.md` D36, `docs/SECURITY.md` section 7): two owner keys with threshold 1, so one compromised key can move the vault; raise the threshold when members are added.

## 8. Kill switches and the first mainnet boot

Two layers per money flow, so one mistake never moves money: the **flag** in the Supabase `flags` table (read at least every minute and again before each signature; no restart) and an **environment gate** (needs a restart): `*_DRY_RUN`, `FORGE_CONVERT_LIVE`, `FORGE_BUYBACK_LIVE`. Migrations seed every flag at `false` (not paused), so a fresh database starts with everything open: set the flags yourself before the first boot.

| Flow | Flag (`flags.key`) | Env pause | Env gate | Safe initial state | Effect of the switch |
|---|---|---|---|---|---|
| New creations | `signups_paused` (web) | none | `FORGE_BETA_MODE`, `FORGE_BETA_ALLOWLIST` | `true`; beta `on` with the team wallets | web refuses new creations |
| Deploys, builder, signing routes | `deploys_paused` | `SIGNER_ROUTES_PAUSED` | none | `true` | builder stops picking up jobs; signer routes (which spend the payer wallet) answer 503 |
| Creator claims to the vault | `claims_paused` | `SIGNER_CLAIMS_PAUSED` | none | `true` | no claims |
| Refunds | `refunds_paused` | `SIGNER_REFUNDS_PAUSED` | none | `true` | refunds wait, nothing is lost |
| Cashbox sweep | `cashbox_sweep_paused` | `SIGNER_CASHBOX_PAUSED` | `SIGNER_CASHBOX_DRY_RUN=true` | `true` and dry run | no sweep to the vault |
| Jupiter referral claims | `jupiter_claims_paused` | `SIGNER_JUPITER_CLAIMS_PAUSED` | none (mainnet only) | `true` | no claims to the revenue wallet |
| Fee conversion (cashbox, payer) | `convert_paused` | none | `FORGE_CONVERT_LIVE=false` | `true` and not live | no swaps (dry runs included); also stops the revenue job's swaps |
| Revenue wallet job | `revenue_paused` | `SIGNER_REVENUE_PAUSED` | `SIGNER_REVENUE_DRY_RUN=true` | `true` and dry run | no unwrap, swap or forward |
| Buyback | `buyback_paused` | `BUYBACK_PAUSED` | `FORGE_BUYBACK_LIVE=false`, `BUYBACK_DAILY_CAP_LAMPORTS=0`, no `FORGE_MINT`, no Squads variables | `true`; simulation | no withdrawal, no order |
| One launchpad | `launchpads.status = 'disabled'` | | | per site | maintenance page and Vercel project paused |

The signer's switches fail closed: a missing row or an unreadable table pauses the job with a high alert (`<job>_paused_flag_missing`). The watcher has no switch: it only reads and alerts.

First boot, all paused (run in the Supabase SQL editor before starting the services):

```sql
select key, value from flags order by key;   -- expect 9 rows (migrations 0001, 0005, 0013, 0015, 0016)
update flags set value = true where key in (
  'signups_paused', 'deploys_paused', 'buyback_paused', 'claims_paused', 'cashbox_sweep_paused',
  'refunds_paused', 'jupiter_claims_paused', 'convert_paused', 'revenue_paused');
```

Enable one at a time, in this order; check the log and Telegram between steps, and give each money job one full interval in dry run before going live:

1. **Boot** with everything paused and dry-run. Expect: web `/api/health` 200, builder log `signer cluster checked`, signer log `signer started` with its jobs, a test alert in Telegram, the watcher running without alerts.
2. **Refunds and claims**: `refunds_paused = false` (before any payment is accepted), `claims_paused = false`.
3. **First creations, team only**: `FORGE_BETA_MODE=on` with the team wallets, then `deploys_paused = false`, `signups_paused = false`. Run one real creation end to end: payment in the cashbox, configs on-chain, launch, site live. Open the beta to the public later (`FORGE_BETA_MODE=off`) as a separate decision.
4. **Jupiter claims**: `jupiter_claims_paused = false`, after a small trade has gone through the plugin on a graduated coin and the referral account has collected.
5. **Cashbox sweep**: `cashbox_sweep_paused = false` with `SIGNER_CASHBOX_DRY_RUN=true`; read one `dry run: would sweep the cashbox` line (amount; destination is the vault by construction); then `SIGNER_CASHBOX_DRY_RUN=false` and restart.
6. **Revenue job**: `revenue_paused = false` in dry run; read one `dry run: would unwrap and forward the revenue` line (wrapped amount, forward amount); then `SIGNER_REVENUE_DRY_RUN=false` and restart. Native SOL is forwarded and every forward writes `revenue-forward.<signature>.json`. Non-SOL tokens are still not swapped.
7. **Conversion**: set `JUPITER_API_KEY`, `FORGE_CONVERT_LIVE=true`, restart, `convert_paused = false`. The revenue job then swaps the revenue wallet's non-SOL balances, and the conversion job those of the cashbox. Check that the `convert job wired` log line shows `jupiterSwapApi: v2`; roll back to Metis with `JUPITER_SWAP_API=v1` and a restart.
8. **$FORGE launch** (D13, after the MVP is validated): `FORGE_MINT` on web and signer, `FORGE_GATING_AMOUNT` on web. The gate turns on; the buyback stays in simulation.
9. **Buyback go-live**, one restart: `FORGE_SQUADS_MULTISIG`, `FORGE_SQUADS_SPENDING_LIMIT`, `JUPITER_API_KEY`, `BUYBACK_DAILY_CAP_LAMPORTS=5000000000`, `BUYBACK_ORDERS_PER_DAY=10`, `BUYBACK_MAX_ORDER_LAMPORTS=500000000`, `BUYBACK_REVENUE_SINCE=<now>`, `FORGE_BUYBACK_LIVE=true` (a missing or invalid value stops the whole signer, claims and refunds included: keep the previous env file for a quick rollback). Fund the bot wallet with `BUYBACK_FEE_RESERVE_LAMPORTS` first. Then `buyback_paused = false`. If a plan already exists for the current UTC day, the first live plan is made at the next day start; the log line `buyback day planned` shows the budget and the backlog. Check that the `buyback job wired` log line shows `jupiterSwapApi: v2` (rollback: `JUPITER_SWAP_API=v1` and a restart).

Roll back by setting the flag back to `true` (within a minute); for a hard stop also set the env pause and restart. `BUYBACK_REVENUE_SINCE` stays where it is.

## 9. Pre-boot checklist

Each item can be checked from a shell or a read, without opening a secret. Run the on-chain reads against the public endpoint (`https://api.mainnet-beta.solana.com`); the addresses are public. Helper used below:

```bash
rpc() { curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
len() { printf %s "${!1}" | wc -c; }                       # secret length, nothing printed
fp()  { printf %s "${!1}" | sha256sum | cut -c1-12; }      # fingerprint to compare two hosts
```

**A. Code and database**
- [ ] The three services run the same commit as the one tested: `git rev-parse HEAD` on each host; CI green (`pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`).
- [ ] No env file is tracked: `git ls-files | grep -E '(^|/)\.env' | grep -v '\.example$'` prints nothing.
- [ ] Migrations 0001 to 0016 are applied: `select key from flags order by key;` returns the 9 keys of section 8.
- [ ] Each env file has no unknown name and no missing name: `comm -13 <(grep -oE '^[A-Z][A-Z0-9_]*' .env.example | sort -u) <(grep -oE '^[A-Z][A-Z0-9_]*' .env | sort -u)` lists names; compare with sections 2 to 4.

**B. Cluster and RPC** (run on each host with its own URL; the output carries no key)
- [ ] `curl -s -X POST "$RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'` returns `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` for web `RPC_URL`, web `RPC_RELAY_UPSTREAM_URL` and signer `RPC_URL`.
- [ ] Web `RPC_URL` and `RPC_RELAY_UPSTREAM_URL` are different keys: `[ "$(fp RPC_URL)" != "$(fp RPC_RELAY_UPSTREAM_URL)" ] && echo ok`.
- [ ] `SOLANA_CLUSTER=mainnet-beta` on web, builder and signer; `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` on web.

**C. Keys and wallets**
- [ ] On the signer host: `pnpm --filter @forge/signer exec tsx src/index.ts --init-keys` prints the public addresses of `payer`, `cashbox`, `buyback`, `revenue` (it only creates missing ones). Compare: `cashbox` = `FORGE_CASHBOX_WALLET`; `revenue` = `FORGE_REVENUE_WALLET` = `FORGE_PLATFORM_FEE_WALLET`; the four are distinct from the vault.
- [ ] Keystore and journal directories are on the backed-up volume; the passphrase is stored offline: `[ "$(len SIGNER_KEYSTORE_PASSPHRASE)" -ge 32 ] && echo ok`.
- [ ] Secret lengths: `len` is at least 32 for `SIGNER_HMAC_SECRET`, `RPC_RELAY_TOKEN_SECRET`, `SESSION_SECRET`, `SUPABASE_JWT_SECRET`, `FORGE_INTERNAL_CRON_SECRET`.
- [ ] Shared secrets match across hosts: `fp SIGNER_HMAC_SECRET` equal on builder and signer; `fp RPC_RELAY_TOKEN_SECRET` equal on web and builder; the two Supabase keys equal on all three.
- [ ] Funding: payer at least `WATCH_MIN_PAYER_LAMPORTS` (0.2 SOL), cashbox at least 0.1 SOL, revenue wallet at least rent plus 0.01 SOL, buyback bot at least `BUYBACK_FEE_RESERVE_LAMPORTS` when the buyback goes live: `rpc getBalance "[\"$FORGE_REVENUE_WALLET\"]"` (lamports) for each; minimum rent: `rpc getMinimumBalanceForRentExemption '[0]'` (wallet) and `'[165]'` (token account).

**D. On-chain accounts** (run from `apps/signer`, public addresses exported in the shell: `cd apps/signer && node --input-type=module -e '...'`)
- [ ] The two referral accounts were created, or checked, by the signer command (section 5, service stopped): `pnpm --filter @forge/signer exec tsx src/index.ts --setup-revenue-referrals` prints the plan (dry run); `--send` creates what is missing; a second run prints `[meteora] ready ...` and `[jupiter] ready ...` and the two env lines, and sends nothing. Exit code 2 means a mismatch: read the printed reason, never work around it by hand.
- [ ] Meteora referral account is a WSOL token account owned by the revenue wallet and not its associated account (the command checks this; to double-check by hand):
  ```js
  import { Connection, PublicKey } from '@solana/web3.js';
  import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
  const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const ref = new PublicKey(process.env.FORGE_METEORA_REFERRAL_ACCOUNT);
  const rev = new PublicKey(process.env.FORGE_REVENUE_WALLET);
  const i = (await c.getParsedAccountInfo(ref)).value;
  console.log('owner is revenue wallet:', i?.data.parsed?.info.owner === rev.toBase58());
  console.log('mint is WSOL:', i?.data.parsed?.info.mint === NATIVE_MINT.toBase58());
  console.log('standalone (not the ATA):', !ref.equals(getAssociatedTokenAddressSync(NATIVE_MINT, rev)));
  console.log('lamports:', i?.lamports);
  ```
  Expect `true`, `true`, `true` and at least the token-account rent.
- [ ] Jupiter referral account is owned by the referral program, belongs to the Ultra project, has the revenue wallet as partner and a name (layout: partner at bytes 8 to 40, project at 40 to 72, name tag at byte 74; `packages/core/src/jupiter-referral.ts`):
  ```js
  import { Connection, PublicKey } from '@solana/web3.js';
  const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const i = await c.getAccountInfo(new PublicKey(process.env.FORGE_JUPITER_REFERRAL_ACCOUNT));
  console.log('owner  ', i.owner.toBase58());                          // REFER4Zgmy...
  console.log('partner', new PublicKey(i.data.subarray(8, 40)).toBase58());   // = FORGE_REVENUE_WALLET
  console.log('project', new PublicKey(i.data.subarray(40, 72)).toBase58());  // DkiqsTrw1u...
  console.log('named  ', i.data[74] === 1);                            // true
  ```
- [ ] The vault is the Squads vault of the multisig: the printed address must equal `FORGE_MULTISIG_VAULT`:
  ```js
  import * as multisig from '@sqds/multisig';
  import { PublicKey } from '@solana/web3.js';
  const [vault] = multisig.getVaultPda({ multisigPda: new PublicKey(process.env.FORGE_SQUADS_MULTISIG),
    index: Number(process.env.FORGE_SQUADS_VAULT_INDEX || 0) });
  console.log(vault.toBase58());
  ```
- [ ] The spending limit is the one of section 7: in the Squads app, SOL, period Day, amount at least 5002305000 lamports, members and destinations = the buyback wallet only; the buyback wallet is a member with no permission; the multisig has the two owner keys and threshold 1. The signer re-checks the on-chain account before every withdrawal (`checkSpendingLimit`).

**E. Network**
- [ ] From the builder host: `curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<signer address>:<port>/v1/health` answers `401` (reachable, signature required). From any other host it must time out or answer `403`.
- [ ] `SIGNER_ALLOWED_IPS` is exactly the builder's address as the signer sees it, no CIDR; `NODE_ENV=production`; the service unit sets `LimitCORE=0`.
- [ ] Gateway: `FORGE_GATEWAY_HOST` is the docker0 address (or loopback on Docker Desktop), not `0.0.0.0`: `ss -ltn | grep :8787` on the builder host shows that address only.
- [ ] Clocks: `timedatectl show -p NTPSynchronized` is `yes` on the builder and the signer host (60-second HMAC window).

**F. Safe initial state** (section 8)
- [ ] The 9 flags are `true`; `SIGNER_CASHBOX_DRY_RUN`, `SIGNER_REVENUE_DRY_RUN` are `true` or unset; `FORGE_CONVERT_LIVE` and `FORGE_BUYBACK_LIVE` are `false` or unset; `FORGE_MINT`, `FORGE_SQUADS_*`, `BUYBACK_REVENUE_SINCE` are unset; `BUYBACK_DAILY_CAP_LAMPORTS` is `0` or unset; `FORGE_BETA_MODE=on` with the team wallets.
- [ ] Web has no `NEXT_PUBLIC_USE_MOCKS=1`.

**G. After the first boot**
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://<web host>/api/health` is `200` (else the web log names the variables: `server_not_ready`, scope `readiness`).
- [ ] Builder log has `signer cluster checked` and `gateway listening`; signer log has `signer started` with the job list and `buyback job wired` with `mode: simulation`.
- [ ] A Telegram test alert reaches the team group (stop and start the signer, or trigger a low-balance alert).
- [ ] Coin metadata route answers: `curl -s https://<web host>/api/coin-meta/<slug>` for an existing slug, and the URL template in `SIGNER_COIN_METADATA_URL` has the same host.
