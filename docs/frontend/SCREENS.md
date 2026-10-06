# SCREENS — all screens and their states

For each screen: route, data (see `CONTRACT.md`), actions, states. "Global" applies everywhere.

## Global (both sites)

- **Loading**: skeletons, never a blank screen.
- **Network error**: clear message + "Retry" button.
- **Wallet not connected** on a page that needs one: prompt to connect.
- **Transaction in progress**: 3 visible phases — "Sign in your wallet" → "Sending…" → "Confirmed" (with a link to the explorer); the user rejecting the signature = neutral message, not an error.
- **Toasts** for short confirmations.
- Shortened address (`7xKX…9fQa`) with a copy button.
- Amounts: SOL with 2 to 4 decimals depending on size, dollar equivalent in gray when provided.

---

## A. FORGE site (`apps/web`)

### A1. Home — `/`
- Content: promise, "how it works" in 4 steps, price ($33, 2 changes included), example launchpad, short FAQ, footer (Terms, FAQ).
- Actions: "Connect my wallet"; if connected: "Create my launchpad" and "My dashboard".
- States: normal; **signups paused** (`flags.signupsPaused`) → banner "Creation is paused, try again later", creation button disabled.

### A2. Login — global modal
- Wallet choice → signing the login message.
- States: choice; waiting for signature; signature rejected; error; connected (avatar/address in the header, menu: dashboard, disconnect).

### A3. $FORGE check — `/new` (before the chat) and before each change
- Data: `gating` (`ok`, `required`, `balance`).
- States: check in progress; **ok** → continue; **insufficient** → blocking screen: required vs balance, explanation ("nothing is spent"), link to get $FORGE, "Recheck" button.

### A4. Design chat — `/new` and `/launchpads/[id]/modify`
- Layout: conversation thread + side panel (or drawer on mobile) **"Summary"** that fills in as the conversation goes on.
- Assistant messages streamed (word by word), "the agent is typing…" indicator.
- Summary card (creation): name, site address (`slug`), trading fees (%), coin creators' share (%), coin creation fee (SOL), anti-sniper yes/no, colors (swatches), dark mode, tagline, launchpad coin (name, symbol, image, description, first buy in SOL), wallet that will receive the fees. Each invalid field is flagged.
- Actions: send a message; "Confirm and go to payment" (enabled only if the spec is complete and valid).
- Change: the card shows the summarized request and "included changes left: N".
- States: empty (agent's welcome message); conversation; incomplete spec; spec ready; sending the confirmation; error; **message limit reached** ("slow down a bit").

### A5. Payment — `/jobs/[id]/pay`
- Data: `quote` (`lamports`, `usdAmount`, `expiresAt`), `kind` (creation / change).
- Display: amount in SOL (large), dollar equivalent, what it includes, **countdown** until `expiresAt`.
- Actions: "Pay" (signs and sends via the client); "New quote".
- States: quote loading; **quote ready**; signing; on-chain confirmation; **paid** → redirect to tracking; **quote expired**; payment rejected by the check (message + support); **included change** (amount 0: no payment, "Continue" button).

### A6. Job tracking — `/jobs/[id]`
- Data: `job` (status, `previewUrl`, `error`, `failedStage`, `attempts`), real-time `jobEvents`.
- **Step tracker** (creation): Paid → Building → Preview ready → Approved → Connecting to Meteora → Signing the launch → Going live → Live. Change: Paid → Building → Preview ready → Approved → Going live → Live.
- Below the tracker: message log (`jobEvents`), most recent at the bottom, `aria-live`.
- States by status (labels in `CONTRACT.md`):
  - `spec_ready` → button to the payment;
  - `paid`, `building` → "Building", attempt N/2 if `attempts = 2`;
  - `preview_ready` → **Preview** block (link + embedded frame if possible) + "Approve the preview" button + "Request a change" (back to the chat, counts as a change);
  - `approved`, `onchain_setup` → "Connecting to Meteora";
  - `awaiting_owner_signature` → redirect to A7;
  - `owner_signed`, `deploying` → "Going live";
  - `live` → **success**: site link, dashboard button, share;
  - `failed` + `failedStage = build` + `attempts < 2` → "Retrying automatically";
  - `failed` + `failedStage` `onchain` or `deploy` → "Something went wrong. Our team has been notified and is on it";
  - `refunded` → "Refunded" + amount + refund transaction link.

### A7. Coin launch — `/jobs/[id]/launch`
- Data: `ownerTransactionSummary` (coin name/symbol, first buy in SOL, estimated network fee).
- Explanation: "This transaction creates $MOON and buys X SOL of $MOON for you. You receive the tokens in this wallet."
- Actions: "Sign and launch".
- States: preparing; ready; signing; sending; **confirmed** → back to tracking; send failure ("Retry", the transaction remains valid); **wrong wallet connected** (must be the owner wallet: show which one).

### A8. Dashboard — `/dashboard`
- Data: `launchpads[]`.
- Card per launchpad: name, site link, status badge (`draft`, `live`, `sleeping`, `disabled`), launchpad coin, number of coins, **partner fees to claim** (SOL), remaining changes, current job if any (link to its tracking).
- Actions: "Claim my fees" (transaction to sign); "Request a change"; "View" (A9); "Reactivate" if sleeping.
- States: no launchpad (empty state with "Create my launchpad" button); list; claim in progress / successful; nothing to claim (button disabled).

### A9. Launchpad detail — `/launchpads/[id]`
- Read-only on-chain settings (fees, shares, addresses of the configs and of the coin), version history (date, request, preview link), job history, claimed fees.
- Note: "On-chain settings are final."

### A10. FAQ — `/faq` and Terms — `/terms`
- FAQ: how to claim your fees, why my coin does not show up yet, what to do if creation fails, what happens in sleep mode. Terms: provisional text.

### A11. Non-production — `/dev/states`
- Gallery of all screens in all their states with the mocks. Not accessible in production.

---

## B. Client site (`apps/launchpad-template`) — base design

Everything is driven by the theme (`forge.config.json#theme` → CSS variables). The components in `src/forge/` (buy panel, coin creation, claim) are **placed** by you but **not modified**: you only give them room and style them via the CSS variables they expose.

### B1. Home — `/`
- Header: launchpad logo/name, tagline (`content.tagline`), wallet connection, "Create a coin".
- Launchpad coin highlight (`$MOON`).
- Lists: new, almost graduated (progress bar toward 10 SOL), graduated; search.
- States: loading; empty list ("Be the first to launch a coin"); **data unavailable** (the site falls back to a slower on-chain read: show a discreet banner).

### B2. Coin page — `/coin/[mint]`
- Image, name, symbol, creator, description, chart, curve progress, holders, transactions.
- Slot for the **buy/sell panel** (`TradePanel` from `src/forge`): it shows the 0.3% fee and the total itself; make room for it in the right column (desktop) or as a fixed bottom bar (mobile).
- States: on the curve; **graduated** (badge, the panel becomes the Jupiter module); coin not found.

### B3. Create a coin — `/create`
- Slot for the `CreateCoin` form from `src/forge`; around it: explanations, the launchpad's coin creation fee, preview of the coin card.

### B4. My creator fees — `/creator`
- Slot for `ClaimCreatorFees` from `src/forge`; not-connected state; no coin created.

### B5. About — `/about`
- Content from `content.about`.

### B6. Sleep — shown when the launchpad is sleeping
- Lightweight static page: name, tagline, "This launchpad is sleeping", link to the coin on Jupiter. **No data loaded** (no RPC).

### B7. Maintenance — shown when the launchpad is disabled
- Static page: "This site is unavailable."

### Theme variables to expose (minimum)

`--color-primary`, `--color-accent`, `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-success`, `--color-danger`, `--radius`, `--font-heading`, `--font-body`. Dark/light mode derived from `theme.darkMode`. Document the list in `src/theme/README.md`.
