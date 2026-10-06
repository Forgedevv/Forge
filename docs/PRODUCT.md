# PRODUCT — what FORGE does

## In one sentence

A client describes their launchpad to an AI agent; the agent codes their site, FORGE connects it to Meteora and launches the launchpad coin; a share of the trading fees goes to FORGE and is used to buy back $FORGE.

## The actors

| Actor | Role | Pays | Receives |
|---|---|---|---|
| Client (e.g. Hugo) | Has a launchpad built | ~$33 in SOL at creation, holds $FORGE | Partner share of all coins on their launchpad; their first-buy tokens |
| Coin creator (e.g. Lisa) | Launches a coin on the client's launchpad | Creation fee set by the client | Creator share of their coin |
| Trader | Buys and sells | Meteora fee (~1%) + FORGE platform fee (0.3%) | — |
| FORGE | Builds, hosts, launches the launchpad coin | AI, servers, RPC | Creation price, creator share of the launchpad coin, referral, platform fee |
| Meteora | On-chain contracts | — | 20% of trading fees (minus the referral) |
| Jupiter | Trading of graduated coins | — | 20% of our integrator fee |

## Flow 1: creation (example Hugo / MoonPad)

1. **Hugo talks to the agent** on the FORGE site: name (MoonPad), trading fee (1%), currency (SOL), style. The agent asks its questions and produces a specification (`LaunchpadSpec`, see `INTERFACES.md`).
2. **Token check**: Hugo must hold a fixed amount of $FORGE (`FORGE_GATING_AMOUNT`, ~$100, reviewed weekly). Nothing is spent. Rechecked each time the agent is used.
3. **Payment**: price fixed at **$33**, converted to SOL at quote time (~0.3 SOL). Quote valid for 120 seconds. Hugo signs the payment from the wallet that will receive his fees.
4. **The agent codes the site**: GitHub repo created from the template, the agent edits the design, pages and texts. The transaction core (`@forge/core`) is locked.
5. **Scan + preview**: security scan on our VPS, then Vercel preview deployment. Hugo approves.
6. **Meteora configs**: the FORGE signer creates two configs:
   - **launchpad config**: `feeClaimer` = Hugo's wallet, for all coins launched on MoonPad;
   - **launchpad coin config**: `feeClaimer` = Hugo's wallet, `creatorTradingFeePercentage` = 25 (FORGE is the creator).
7. **Launch of $MOON**: a creator wallet dedicated to MoonPad creates the pool. Hugo pays and signs his first buy in the same transaction and receives his $MOON.
8. **Go live**: the site goes to production on Vercel, on a subdomain of the client sites domain.

**Failure**: 2 attempts included. If the agent fails twice, the payment is refunded automatically.

## Flow 2: modifications

- Hugo calls the agent again from his dashboard.
- $FORGE is rechecked.
- **2 modifications included** with the creation, then **$5.50 per modification** (converted to SOL, ~0.05 SOL).
- API budget capped per request, same scan, same preview, same approval.
- Version history, rollback possible.
- On-chain parameters (fees, curve, recipient) do not change: a Meteora config is frozen.

## Flow 3: revenue

### Coin still on the curve (before graduation)

The trade goes through **our buy button**, which calls Meteora directly. Example: a $1,000 buy, Meteora fee 1% = $10, platform fee 0.3% = $3.

| | $MOON (launchpad coin) | $CAT (Lisa's coin) |
|---|---|---|
| Meteora | $1.60 | $1.60 |
| Referral → FORGE | $0.40 | $0.40 |
| Creator | $2 → FORGE (25% of the $8) | $2 → Lisa (25% of the $8) |
| Partner (Hugo) | $6 | $6 |
| Platform fee → FORGE | $3 | $3 |
| **FORGE total** | **$5.40** | **$3.40** |

If the trade goes through a bot or a terminal (not our button): FORGE only receives the creator share on $MOON, nothing on $CAT.

### Graduated coin (after migration)

The trade goes through the Jupiter plugin with our integrator fee of 30 bps; Jupiter keeps 20%. No more Meteora referral for us.

| | $MOON | $CAT |
|---|---|---|
| Integrator fee (0.3% − 20%) | $2.40 | $2.40 |
| Creator share (via pool liquidity, assumption) | ~$2 | $0 |
| **FORGE total** | **~$4.40** | **$2.40** |

### Where the money goes

- **Creation price and modifications** → operating cashbox (pays for AI and servers).
- **All trading revenue** → multisig, then **$FORGE buyback**. No burn: bought-back tokens stay in the treasury.
- **Fallback rule**: if creations no longer cover fixed costs, 10 to 20% of trading revenue goes to the cashbox (manual team decision).

## Key figures

| Item | Value |
|---|---|
| Creation price | $33 in SOL (~0.3 SOL) |
| Included modifications | 2, then $5.50 each |
| Attempts before refund | 2 |
| Token-gating threshold | fixed amount of $FORGE (~$100), reviewed weekly |
| FORGE creator share on the launchpad coin | 25% |
| Platform fee | 30 bps (our button); 30 bps Jupiter integrator fee after graduation |
| Trading fees offered to clients | between 50 and 200 bps |
| Migration threshold | 10 SOL |
| Sleep mode | 30 days without a trade |
| Margin per creation | ~$15 |
| Fixed costs | ~$110/month after public launch |

## $FORGE

- Launched on **the FORGE launchpad, built by our own agent**, once the MVP is validated on mainnet.
- FORGE is the creator of $FORGE: the creator share of its trades also feeds the buyback.
- Team share: first buy of 3 to 5% of the supply, publicly announced, locked for a period.
- Before its launch, token-gating uses a fake $FORGE on devnet.

## Out of scope for the MVP

- The agent's X account (after launch).
- Quote currency other than SOL.
- Custom client domains (subdomains only at first).
