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

**Protections** (agent 5): API reachable only from VPS 1's IP (firewall), HMAC-signed requests with a timestamp, and the signer **rereads everything in Supabase** (job, spec, confirmed payment) instead of trusting the request body.

## 7. Treasury drained

**Protections**: Squads multisig, at least 2 signatures out of 3 (to be confirmed with the team). The buyback bot only has a daily spending limit to its own wallet.

## 8. Buyback front-run by bots (MEV)

**Protections** (agent 5): small amounts, random times, capped slippage (1%), never a predictable amount.

## 9. Abuse of the agent and of costs

**Protections**: modification quota, payment before each job, budget and timeout per job (`OPS`), rate limit on the design chat.

## 10. Forged payment

**Protections** (agent 3): `POST /api/payments/confirm` verifies the transaction on-chain: signer = session wallet = launchpad owner (`spec.ownerWallet`), recipient = cashbox, exact quoted amount, memo `forge:job:<jobId>`, quote not expired, signature never used before.

## 11. RPC relay abused

**Protections** (agent 3): JSON-RPC method allowlist with strict params, per-IP rate limit weighted per method, bounded request and response size.
- `getProgramAccounts` is refused in every shape but one: the creator pools query of the creator fee claim (Meteora SDK `getPoolsByCreator`): the DBC program, a pool account discriminator at offset 0 and exactly one 32-byte creator key at offset 104, base64 data, no dataSlice, dataSize, withContext or extra filter. It weighs 20 units (an account read weighs 1) and keeps the response size cap. Any other shape answers "method not allowed".
- Callers: the FORGE site, draft and live client sites, previews awaiting approval, and sleeping client sites. A sleeping site's origin gets only the methods of the creator fee claim (D29); the server-token tier (client server routes, uploads) serves draft and live launchpads only.
- Client site origins are exact: `https://<slug>.<CLIENTS_DOMAIN>`, or `https://<site_host>` where `launchpads.site_host` is the production host the builder read from the Vercel API for the launchpad's own project and promoted deployment (D30). A `*.vercel.app` origin is never matched by pattern (anyone can create a project with a look-alike name), and a recorded host only ever speaks for its own launchpad, with its status rules. On read, a recorded host is trusted only in the two forms the builder writes: `<one label>.vercel.app`, or exactly `<own slug>.<CLIENTS_DOMAIN>`; any other value is ignored. The upload route accepts the same two hosts as the signed `auth.host`.

## 12. Scam launchpads

**Protections**: terms of use; per-launchpad `disabled` flag that cuts the site (we host it): the builder deploys the maintenance page and pauses the Vercel project (D24), and a sweep every 15 minutes checks that every disabled project is paused. The coin stays on-chain but the site disappears. Re-enabling needs the mode set back to `live`, a release and an unpause.
