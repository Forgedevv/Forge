# @forge/builder

The builder worker (VPS 1): it picks up jobs, has the site-coding agent work in a sandbox,
scans its changes, builds the site, pushes to the client repository, deploys previews on Vercel
and asks the signer to wire up Meteora. Task sheet: `tasks/04-BUILDER.md`; sandbox and images:
`docker/README.md`; threat model: `docs/SECURITY.md`; configuration: `.env.example`.

## Visual review (`BUILDER_VISUAL_REVIEW=on`)

Off by default. When on (and `FORGE_SANDBOX_REVIEW_IMAGE` is set), a new site gets a second
agent pass after the first one has been scanned and built: the built site is rendered in a
headless browser with no network (`/`, `/create-pool`, `/about`, `/creator-fees`, desktop
1440x900 and mobile 390x844 with real device emulation), the screenshots and a measured layout
report (horizontal overflow per element) go to the agent in `.forge-review/`, and its result goes
through the same scan and build. Any failure keeps the first pass. Code:
`src/pipeline/review/`, prompt: `src/prompts/review.ts`.

## Local site test tool

A development tool, never used in production, that reproduces the building step on a laptop
without Docker, GitHub, Vercel, the chain or payments: the same template
(`prepare-template-repo.mjs`), `forge.config.json`, prompts, agent argv, scan and capture script
as the pipeline.

Needs: `pnpm install`, `pnpm --filter @forge/shared --filter @forge/core build`, the agent CLI
installed and logged in (for `agent`, `review`, `all`), and Chrome or Edge (for `capture`;
`--browser <path>` if it is not found). Use absolute paths, and an output folder outside the
repository (the tool refuses one inside).

Quick start, with a brief such as
`{"name": "Neko Pad", "slug": "neko-pad", "theme": {"primaryColor": "#FF2D95", "accentColor": "#00E5FF", "darkMode": true, "tagline": "...", "designNotes": "..."}, "launchpadCoin": {"name": "Neko", "symbol": "NEKO", "description": "..."}}`:

```
pnpm --filter @forge/builder site-test prepare --brief /abs/briefs/neko.json --out /abs/sitetest/neko
pnpm --filter @forge/builder site-test agent --out /abs/sitetest/neko
pnpm --filter @forge/builder site-test capture --out /abs/sitetest/neko
```

Or everything at once: `site-test all --brief <file> --out <new folder>` (prepare, agent, scan,
capture, review, scan, capture again, then prints where to look).

| Command   | What it does                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare` | Standalone template into `<out>/site`, `forge.config.json` from the brief (other spec fields get valid dummies, a random owner key), baseline and prompts (`<out>/prompts`). The output folder must be empty. |
| `agent`   | First pass with the local CLI, exact production argv (file tools only), model `claude-sonnet-5-5` (`--model`). Prints turns, cost, duration and summary; raw result in `<out>/agent-pass1.json`.              |
| `scan`    | The production gate (`gateTree`: scan, `forge.config.json` check, file modes) against the baseline. It leaves out only what the tool itself created, and says so.                                              |
| `serve`   | Links the template's installed dependencies into the site, writes a devnet `.env.local` whose RPC relay is a local proxy to `https://api.devnet.solana.com`, runs `next dev` (port 3100) until Ctrl+C.     |
| `capture` | Runs the pipeline's capture script with a local Chrome or Edge on the site (starting `serve` if needed) into `<out>/capture-<time>/`, and checks the output like the pipeline.                              |
| `review`  | Copies the latest capture into `.forge-review/`, runs the second pass with the review prompt, then removes `.forge-review/`.                                                                                  |

Options: `--port` (default 3100), `--rpc-port` (default 3101), `--model`, `--agent-bin`,
`--max-turns`, `--browser`, `--capture <dir>`. Ports 3001, 3002 and 8899 are always refused.

Differences with production, on purpose: the agent runs with your local CLI login and no
container (file tools only, but run only briefs you trust); the site runs in `next dev` on the
template's installed dependencies instead of a frozen install and `next build`, with public devnet
values in `.env.local`; the browser is your Chrome or Edge instead of the review image's Chromium.
