# 00 — SETUP (Ali, by hand)

What the agents cannot do. Allow 2 to 4 hours. Steps marked **[devnet is enough]** can wait for the mainnet part.

Keep all keys in a password manager. Never paste them into a conversation with an agent: put them in the `.env` files yourself.

## 1. Code

- [ ] Create a GitHub organization (e.g. `forge-launchpads`).
- [ ] Create the private `forge` monorepo and put all the `.md` files from this pack in it.
- [ ] Create an empty `launchpad-template` template repo (it will be filled from `apps/launchpad-template`), check "Template repository".
- [ ] Create a **GitHub App** in the organization: `Contents: read & write` permission, installed on the organization. Note the App ID and generate a private key (for the builder).
- [ ] Create a token to publish `@forge/core` on GitHub Packages (private registry).

## 2. Hosting

- [ ] Vercel: create a team, Pro plan (1 member). Create an API token (for the builder). Note the team ID.
- [ ] Domains: buy the FORGE domain and a **separate domain** for client sites (e.g. `forgepads.xyz`). Connect the clients domain to Vercel with a wildcard `*.forgepads.xyz`.
- [ ] Hetzner: 2 Ubuntu VPS.
  - VPS 1 (builder): 4 vCPU, 8 GB RAM, Docker installed.
  - VPS 2 (signer): small model. Firewall: SSH from your IP only, signer API reachable only from VPS 1's IP.
- [ ] Supabase: create a project (free plan for dev).
- [ ] Cloudflare: create an R2 bucket and its access keys (coin images).

## 3. Blockchain

- [ ] Helius: account, API key, devnet and mainnet RPC URLs.
- [ ] Jupiter: API key on the developer portal. **[devnet is enough: do before the mainnet tests]**
- [ ] Team wallets (Phantom or Ledger), one per multisig member.
- [ ] Squads multisig: create the multisig with the members and the threshold decided (Q1 in DECISIONS.md). Note the **vault** address. Create a **devnet** version first for the tests.
- [ ] Fake $FORGE on devnet: agent 1 creates it in its scripts; you have nothing to do here.
- [ ] Devnet SOL: https://faucet.solana.com (GitHub login) when the scripts print the address to fund.
- [ ] Mainnet SOL for tests: 0.5 to 1 SOL on a test wallet. **[later]**

## 4. AI

- [ ] Anthropic Console: API key dedicated to the product (not your subscription), **monthly spending limit** set.
- [ ] Your Claude subscription is used only to run the dev agents.

## 5. Alerts

- [ ] Create a Telegram bot (BotFather), add it to the team group, note the token and the group ID.

## 6. `.env` files

Fill in one `.env` per app from the `.env.example` files the agents will create (full list in `docs/INTERFACES.md`, section 8). On the VPS, put the `.env` files directly on the machine, never in git.
