# SECURITY — threats and protections

Every protection below is **mandatory** in the MVP. Agents that touch one of these areas must implement and test it.

## 1. Client site booby-trapped by the agent

**Threat**: a client asks the agent to add a token approval request, replace our fee addresses, or inject an external script. The site becomes a phishing site hosted by us.

**Protections** (agent 4, with agent 2 for the template structure):
- `@forge/core` installed from the private registry at a pinned version. The scan rejects any change to `package.json` on this dependency, any `patch-package`, any file in `node_modules`.
- The template clearly separates `src/forge/` (untouchable, wired to `@forge/core`) from the rest (design, pages, content).
- **Blocking scan before every push**:
  - no modification under `src/forge/`, `forge.config.json#onchain`, `next.config.*` (security headers), `package.json#dependencies['@forge/core']`;
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

## 4. Sandbox network egress

**Protections** (agent 4): Docker network with an egress allowlist: AI gateway, `github.com`, `registry.npmjs.org`, `npm.pkg.github.com`. Everything else is denied. No host folder mounted outside the job's working folder.

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

**Protections** (agent 3): `POST /api/payments/confirm` verifies the transaction on-chain: signer = session wallet = launchpad owner (`spec.ownerWallet`), recipient = cashbox, amount ≥ quote, quote not expired, signature never used before.

## 11. RPC relay abused

**Protections** (agent 3): JSON-RPC method allowlist, per-IP rate limit, bounded request size.

## 12. Scam launchpads

**Protections**: terms of use; per-launchpad `disabled` flag that cuts the site (we host it); the coin stays on-chain but the site disappears.
