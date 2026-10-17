# SECURITY — threats and protections

Every protection below is **mandatory** in the MVP. Agents that touch one of these areas must implement and test it.

## 1. Client site booby-trapped by the agent

**Threat**: a client asks the agent to add a token approval request, replace our fee addresses, or inject an external script. The site becomes a phishing site hosted by us.

**Protections** (agent 4, with agent 2 for the template structure):
- `@forge/core` and `@forge/shared` installed from npm (`@forgedevv/core`, `@forgedevv/shared`) at an exact pinned version. The scan rejects any change to `package.json` on these dependencies (including overrides), any `patch-package`, any file in `node_modules`.
- The template clearly separates `src/forge/` (untouchable, wired to `@forge/core`) from the rest (design, pages, content).
- **Blocking scan before every push**:
  - no modification under `src/forge/` (which holds the mode gate and the mode pages), `src/pages/_app.*`, `src/pages/_document.*`, `src/pages/creator-fees.*`, `src/components/modes/**`, `forge.config.json#onchain` and `#mode`, `next.config.*` (security headers), `package.json#dependencies['@forge/core']`;
  - free-zone pages are static: no `getServerSideProps` or `getInitialProps`, no use of the response object (`res.end`, `res.write`, headers...), no second React root (`react-dom/client`);
  - no added base58 string of 32 to 44 characters (Solana address);
  - no external `<script src=`, no `fetch`/`import` to a domain outside the allowlist;
  - no use of `approve`, `setAuthority`, `createApproveInstruction`, `signAllTransactions` outside `src/forge/`;
  - no `eval`, `new Function`, `dangerouslySetInnerHTML` with dynamic content.
- Strict Content-Security-Policy in the template (Jupiter domains, Helius via relay, R2, Vercel).
- Preview approved by the client before any production release.

## 2. Anthropic API key exposed

**Protections** (agent 4): the real key stays on the host machine, in the gateway. The container receives `ANTHROPIC_BASE_URL` (gateway) + `ANTHROPIC_AUTH_TOKEN` (temporary token, budget `OPS.agentBudgetUsdPerJob`, expires at the end of the job). Monthly spending limit also set in the Anthropic console.

## 3. Agent's GitHub access

**Protections** (agent 4): organization GitHub App; temporary installation token, limited to the client's repo only, `contents:write` permission only. No access to the FORGE monorepo.
- One read sees one more repo: whether a client repo was created from the template (`template_repository`, which GitHub only fills for a token that can see the template) is read with a metadata-only token (`metadata:read`, nothing else, no write) scoped to that client repo plus the template repo.

## 4. Sandbox network egress

**Protections** (agent 4): Docker network with an egress allowlist: AI gateway, `github.com`, `registry.npmjs.org`. Everything else is denied. No host folder mounted outside the job's working folder.

**Visual review capture** (agent 4, `BUILDER_VISUAL_REVIEW=on`, off by default): after the first agent pass of a new site has been scanned and built, a separate container renders it so a second pass can fix what it sees.
- It runs the agent's site (`next start`) and a headless Chromium, so it gets the strictest run: review image only (`FORGE_SANDBOX_REVIEW_IMAGE`, pinned, no agent CLI), network `none` (loopback only; the runner refuses the review image with any other network or with a secret), the same hardening flags and resource limits as every sandbox run, the job folder mounted read-only, and one fresh output folder (inside the jobs root, separate from the job folder) as the only writable host path. In the browser, every external request is intercepted: the Jupiter data API gets empty lists, the rest fails, and no host name resolves.
- Its output is untrusted: the host reads only the expected file names, never through a link, with size caps; the report is parsed with zod and checked against the contract (pages, viewports, sizes); each PNG is checked chunk by chunk and rebuilt from its critical chunks; every string is cut short and reduced to a safe character set before it reaches the agent.
- The second pass runs like the first (gateway only, job token, what is left of the job budget, capped). Its review input (`.forge-review/`) is removed before the scan, then the same scan against the same baseline and the same install and build run again. Any failure of the review (capture, agent, scan, build, time, budget) keeps the first pass, already scanned and built; the files of the two passes are never mixed.

## 5. Theft of a creator wallet key

**Threat**: a pool's creator role is **transferable** (`transferPoolCreator`). A stolen key = the whole creator share diverted forever.

**Protections** (agent 5):
- One creator wallet per launchpad, keys encrypted at rest (`SIGNER_KEYSTORE_PASSPHRASE`), only on VPS 2.
- The signer never calls `transferPoolCreator`. On-chain monitoring alerts immediately (Telegram) if a creator transfer appears on one of our pools.
- Creator wallets keep only enough to pay transaction fees; everything claimed goes straight to the multisig.

## 6. Signer called by anyone

**Protections** (agent 5): API reachable only from VPS 1's IP (firewall), HMAC-signed requests bound to the method, the path, a timestamp, a single-use nonce and the body, and the signer **rereads everything in Supabase** (job, spec, confirmed payment) instead of trusting the request body.

## 7. Treasury drained

**Protections**: Squads multisig. Current decision (owner, 2026-10-17, `docs/DECISIONS.md` D36): at launch the vault has two keys of the owner (main wallet and backup wallet) with a threshold of 1, plus the buyback bot as a member without permission; more members come later. The original proposal was 2 signatures out of 3. Residual risk: with a threshold of 1, one compromised owner key can move everything the vault holds, so keep the two keys on separate devices and raise the threshold when members are added (2 as soon as a second person or an independent key joins). The buyback bot only has a daily spending limit to its own wallet.

## 7b. Revenue wallet hot key (D34)

**Threat**: the revenue wallet's key lives in the signer keystore (VPS 2), like the cashbox's. A compromise of the machine exposes what the wallet holds, and a bug in the job could send its balance elsewhere.

**Protections** (agent 5):
- The wallet only ever holds about one day of revenue: the job forwards everything above a small reserve to the multisig every day (`SIGNER_REVENUE_INTERVAL_HOURS`), and the key is never used for anything else.
- The forward is a single policy-checked transfer whose destination is pinned to `FORGE_MULTISIG_VAULT` before signing; the unwrap is pinned instruction by instruction (ephemeral account seeded from the wallet, transfers only into it, closed only to the wallet); the swaps go through the conversion policy (allowlist and simulation). Any other transaction is refused before the keystore signs.
- Fail-closed startup on mainnet-beta: the key, `FORGE_PLATFORM_FEE_WALLET` and the owner of the Meteora referral account must agree with `FORGE_REVENUE_WALLET`. Kill switch `revenue_paused` (fail closed), read again before every signature.
- The outflow watcher treats the wallet like the cashbox (vault as the only allowed destination, token accounts included), and the job alerts on any native drop it cannot explain by its own fees.

## 8. Buyback front-run by bots (MEV)

**Protections** (agent 5): small amounts, random times, capped slippage (1%), never a predictable amount.

## 9. Abuse of the agent and of costs

**Protections**: modification quota, payment before each job, budget and timeout per job (`OPS`), rate limit on the design chat.

## 10. Forged payment

**Protections** (agent 3): `POST /api/payments/confirm` verifies the transaction on-chain: signer = session wallet = launchpad owner (`spec.ownerWallet`), recipient = cashbox, exact quoted amount, memo `forge:job:<jobId>`, quote not expired, signature never used before.

## 11. RPC relay abused

**Protections** (agent 3): JSON-RPC method allowlist with strict params, per-IP rate limit weighted per method, bounded request and response size.
- `getRecentPrioritizationFees` (the priority fee of every transaction core builds) is served to every tier, sleeping sites included (their creator fee claim is priced): no params, or one list of at most 32 writable accounts, nothing else; it weighs 2 units.
- `getProgramAccounts` is refused in every shape but two: the creator pools query of the creator fee claim (Meteora SDK `getPoolsByCreator`): the DBC program, a pool account discriminator at offset 0 and exactly one 32-byte creator key at offset 104, base64 data, no dataSlice, dataSize, withContext or extra filter; and the config pools query of the on-chain coin list fallback (SDK `getPoolsByConfig`): the same shape with the key at offset 72, served to the server-token tier only (a client site's `/api/coins` route, which caches it for all its visitors; a browser, sleeping or anonymous caller gets "method not allowed"). They weigh 20 and 30 units (an account read weighs 1) and keep the response size cap. Any other shape answers "method not allowed".
- Callers: the FORGE site, draft and live client sites, previews awaiting approval, and sleeping client sites. A sleeping site's origin gets only the methods of the creator fee claim (D29); the server-token tier (client server routes, uploads) serves draft and live launchpads only.
- Client site origins are exact: `https://<slug>.<CLIENTS_DOMAIN>`, or `https://<site_host>` where `launchpads.site_host` is the production host the builder read from the Vercel API for the launchpad's own project and promoted deployment (D30). A `*.vercel.app` origin is never matched by pattern (anyone can create a project with a look-alike name), and a recorded host only ever speaks for its own launchpad, with its status rules. On read, a recorded host is trusted only in the two forms the builder writes: `<one label>.vercel.app`, or exactly `<own slug>.<CLIENTS_DOMAIN>`; any other value is ignored. When the database cannot be read, the relay keeps trusting recorded hosts from its last snapshot for 2 minutes at most (slugs: 15 minutes). The upload route accepts the same two hosts as the signed `auth.host`.

## 11b. Priority fees used to drain a wallet

**Threat**: a compromised server or a bug sets a huge compute unit price (or a second price, a heap frame request...) on a transaction a user or a FORGE wallet signs: the priority fee is burnt from the fee payer, nothing in the instructions shows it.

**Protections** (core, with agents 2, 3 and 5):
- One builder of the price, in `@forge/core` (`priority-fee.ts`): a percentile of the recent fees of the transaction's writable accounts, floor, cap per compute unit and cap per transaction (user transactions: at most 1,000,000 micro-lamports per CU and 0.0005 SOL; hard ceilings 10 lamports per CU and 0.01 SOL). A failed read prices at the floor, it never removes the cap.
- Every check that reads instruction lists accepts Compute Budget instructions in their exact form only: no account, `SetComputeUnitLimit` or `SetComputeUnitPrice`, at most one of each, bounded: core `checkComputeBudgetInstructions` and `verifyLaunchCoinTransaction` (0.01 SOL), the FORGE site's browser checks (0.01 SOL), the template's browser checks (its own cap, 0.0005 SOL; a price without a limit is refused), the signer policies (1 lamport per CU, 0.001 SOL; a price without a limit is counted for 1.4M CU).
- Shown before signing: the template's trade quote shows the most the priority fee can be (0.00015 SOL per swap) and counts it in the total; its coin creation and claim summaries show the fee computed from the transaction itself.

## 12. Scam launchpads

**Protections**: terms of use; per-launchpad `disabled` flag that cuts the site (we host it): the builder deploys the maintenance page and pauses the Vercel project (D24), and a sweep every 15 minutes checks that every disabled project is paused. The coin stays on-chain but the site disappears. Re-enabling needs the mode set back to `live`, a release and an unpause.
