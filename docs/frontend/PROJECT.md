# PROJECT — FORGE explained for the interface

## In one sentence

A client describes their launchpad (a site where others launch and trade Solana coins) to an AI agent in a chat; the agent codes their site, FORGE connects it to Meteora and launches the launchpad's coin; afterwards, a share of the trading fees goes back to the client and to FORGE.

## Vocabulary

| Term | Meaning for the user |
|---|---|
| Launchpad | The client's site, e.g. "MoonPad", live at `moonpad.forgepads.xyz` |
| Launchpad coin | The launchpad's own token, e.g. `$MOON`, created at launch |
| Coin | A token launched by anyone on the launchpad, e.g. Lisa's `$CAT` |
| Curve / graduation | A coin starts on a price curve; once 10 SOL is raised it "graduates" and then trades on Jupiter |
| Partner fees | The share of trading fees that goes to the client on **all** coins of their launchpad; they claim it from their dashboard |
| Creator fees | The share that goes to a coin's creator; claimed on the launchpad's site |
| $FORGE | FORGE's token; you must hold a certain amount to use the agent (nothing is spent) |
| Preview | A test version of the site, to be approved before going live |

## The people who will see your interface

| Who | Where | What they want |
|---|---|---|
| **Client** (e.g. Hugo) | FORGE site (`apps/web`) | describe their launchpad, pay, follow the build, approve, launch their coin, claim their fees, request changes |
| **Coin creator** (e.g. Lisa) | client's site (template) | create a coin, claim their creator fees |
| **Trader** | client's site (template) | see the coins, buy, sell |

## Journey 1 — Creating a launchpad (FORGE site)

1. **Arrival** on the home page: what FORGE does, the price, a "Connect my wallet" button.
2. **Connection**: the client picks their wallet (Phantom, Backpack…), signs a message (free, no transaction). A session is opened.
3. **$FORGE check**: if they do not have enough $FORGE, a blocking screen shows the required amount and their balance. As long as $FORGE is not launched, this step always passes.
4. **Design chat**: the agent asks its questions (name, trading fees, creator share, coin creation fee, style, colors, launchpad coin and its first buy). Answers arrive as a stream, word by word. Once everything is collected, a **summary card** is displayed; the client can ask for changes in the chat or **confirm**.
5. **Payment**: $33 converted to SOL at quote time (~0.3 SOL). The quote is valid for **120 seconds** (countdown). The client signs the payment in their wallet; we wait for on-chain confirmation. Quote expired → "New quote" button.
6. **Build**: real-time tracking page. Readable messages arrive ("I'm creating your repo", "I'm coding the design", "Preview ready"). Duration: a few minutes to ~30 min.
7. **Preview**: link (and, if possible, an embedded frame) to the preview. The client clicks "Approve".
8. **On-chain setup**: FORGE creates the configs and prepares the launch transaction (automatic step, a few seconds to a minute).
9. **Coin launch**: the client signs **one** transaction that creates `$MOON` and makes their first buy (amount chosen in the chat, paid by them, they receive their `$MOON`). Explain clearly what they are signing and how much.
10. **Live**: the site goes to production at `moonpad.forgepads.xyz`. Success screen with the link.

**Failure**: if the build fails, FORGE retries automatically once. After two failures, the payment is **refunded automatically** (show the "Refunded" state with the transaction link). If the failure happens after approval, the team is notified and handles it: show "Our team is on it" (no automatic refund).

## Journey 2 — Modification (FORGE site)

From the dashboard: "Request a change" → new $FORGE check → chat (describe the change) → payment if no included change is left (2 included, then $5.50) → build → preview → approval → going live. The on-chain settings (fees, recipient) **cannot change**: say so clearly if the client asks.

## Journey 3 — Revenue (dashboard)

For each launchpad, the client sees: status, number of coins, partner fees available to claim (in SOL), "Claim" button (one transaction to sign), remaining changes, version history.

## Journey 4 — Client site (template)

- **Home**: list of coins (new, almost graduated, graduated), search.
- **Coin page**: chart, buy/sell panel, curve progress, holders, transactions.
- **Before graduation**, the buy panel shows the **0.3% platform fee** and the total before signing. **After graduation**, it is the Jupiter module.
- **Create a coin**: form (name, symbol, image, description, first buy), with the launchpad's fixed coin creation fee displayed.
- **My creator fees**: a connected creator sees their coins and claims their share.
- **Sleep** pages (inactive launchpad) and **maintenance** (disabled launchpad).

## Numbers shown to the user

| Item | Value |
|---|---|
| Creation price | $33 in SOL (exact SOL amount given by the quote) |
| Changes | 2 included, then $5.50 each |
| Quote validity | 120 s |
| Platform fee (buy before graduation) | 0.3% |
| A launchpad's trading fees | between 0.5% and 2%, chosen by the client |
| Graduation threshold | 10 SOL |
| Sleep mode | after 30 days without a trade |

These values come from the backend (`CONTRACT.md`): do not hardcode them, except in the home page marketing copy (centralized in a single content file).

## Tone and language

- UI in **English** by default, with copy centralized (one file per page) so other languages can be added later.
- Casual, simple tone, short sentences. Never jargon without explanation ("sign", "graduated", "partner fees" have a tooltip).
- Always say **what the user is about to sign** and **how much it costs** before opening their wallet.
