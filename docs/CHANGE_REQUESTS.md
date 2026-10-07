# CHANGE_REQUESTS

Agents write here when they need a change outside their folder (shared contract, another app, a doc). The lead session decides.

## Template

```
### [open] <short title>
- Agent: <number and name>
- Need: <what is missing or blocking>
- Proposal: <precise change>
- Current workaround: <mock used in the meantime>
- Decision (lead): <accepted / rejected / modified + date>
```

## Requests

### [open] Replace the obsolete homepage placeholder test
- Agent: Agent 6 — Frontend
- Need: `apps/web/tests/home.test.tsx` still requires the exact text `FORGE — coming soon`. The user requested a Helion-inspired FORGE homepage, which replaces that placeholder. The test directory is outside the frontend agent's allowed edit scope.
- Proposal: Agent 3 or the lead should replace the obsolete assertion with coverage of the actual homepage. Add the browser API stubs needed by the jsdom environment, or consolidate with `src/ui/helion/homepage.test.tsx`.
- Current workaround: Six interaction tests live inside the authorized `src/ui/` directory and pass. The full suite is reported as failing; the obsolete test has not been disabled or edited.
- Decision (lead): Pending.

### [open] Provide the homepage session and feature-flag client
- Agent: Agent 6 — Frontend
- Need: `apps/web/src/client/` contains only `.gitkeep`. The visual homepage has no real wallet session or feature flags to consume.
- Proposal: Agent 3 should deliver `useSession()` and `useFlags()` with the signatures exported by `@forge/shared`, including its configured wallet provider. The full frontend flow can then consume the same contract as its development mocks.
- Current workaround: The visual homepage opens an explicit wallet-unavailable dialog. It does not simulate authentication, request signatures, submit payments, or claim to have created a launchpad. The operational frontend and contract mocks remain unfinished.
- Decision (lead): Pending.

### [superseded] Homepage placeholder-test request after design removal
- Agent: Agent 6 — Frontend
- Need: Correct the status of the earlier request without rewriting the request history.
- Update: The user rejected the Helion direction and explicitly requested its removal. Its code and tests have been removed, the baseline homepage restored, and the original homepage test passes again. No placeholder-test change is currently needed. The missing session and feature-flag client remains relevant to the future operational frontend.
- Current workaround: The Loanmeme replacement awaits a visual reference of its motion because no browser is available in the session.
- Decision (lead): No test change needed for the restored baseline.

### [open] Rendering dependencies for the Loanmeme motion adaptation
- Agent: Agent 6 — Frontend
- Need: Public resource access now works. Loanmeme uses a custom Three.js scene engine with physics, skinned character animation, refraction, reflections, bloom, and inertial scene navigation. The installed FORGE tree contains no `three`, `cannon`, `lethargy`, or `@types/three`. The requested fidelity cannot be delivered by simply copying CSS transitions.
- Proposal: The lead or Agent 3 should approve and add a bounded rendering stack to `apps/web`. The upstream compatibility baseline is `three@0.145.0`, `cannon@0.6.2`, `lethargy@1.0.9`, and `@types/three@0.144.0`; these are the original project's versions, not a recommendation to adopt old versions without compatibility review. Either approve that baseline for an isolated adapter or select current versions and account for shader/renderer migration. Also decide how the MIT-licensed `ore-three` helper source is incorporated, retaining notices. Do not include the upstream development panel in the production app.
- Source: `https://github.com/junni-inc/next.junni.co.jp`. Its MIT grant covers code, while its README excludes website artwork, 3D models, SVGs, and text. FORGE needs original visual assets.
- Current workaround: Source inspection and measured animation/camera data are saved in `apps/web/src/ui/reference/loanmeme/`. No dependency was installed, missing library vendored, external script added, or replacement design presented as equivalent. The restored baseline remains in place; the renderer is not implemented.
- Remaining verification: The browser/computer inventory is still empty. Source timing has been inspected, but live visual and gesture equivalence has not been verified.
- Decision (lead): Pending.

### [accepted] Reviewed rendering dependencies installed locally
- Agent: Agent 6 — Frontend
- Need: Resolve the earlier rendering-dependency request after the user explicitly authorized checking and installing the libraries.
- Decision (user): Accepted on 2026-10-07, including the necessary app manifest and workspace lockfile changes.
- Implementation: Added exact runtime versions `three@0.186.1`, `cannon-es@0.20.0`, and `lethargy@1.0.9`, plus development dependency `@types/three@0.186.0`. The old `cannon` and beta `ore-three` packages were not added. Added a local CommonJS declaration for Lethargy.
- Review: No known advisory reported by deps.dev for any of the ten added direct/transitive package versions. All archive SHA-512 values were verified; installation scripts were disabled. The workspace-wide registry audit was inaccessible, so this is not a clean audit of existing dependencies.
- Validation: Frozen lockfile check, app typecheck, lint, original homepage test, and production build pass. Runtime and TypeScript import checks pass for the rendering stack.
- Details: `apps/web/src/ui/reference/loanmeme/dependencies.md` records sources, licenses, installation method, maintenance ages, and compatibility limits.
- Remaining work: Implement the renderer, original FORGE assets, and Three/Cannon migration; visually verify motion and gestures when browser access is available. The homepage remains the restored baseline.


### [open] Replace the homepage placeholder assertion after the immersive rebuild
- Agent: Agent 6 — Frontend
- Need: The new FORGE homepage replaces `FORGE — coming soon`. The existing `apps/web/tests/home.test.tsx` still requires that obsolete placeholder and is outside the frontend edit zone.
- Proposal: Agent 3 or the lead should update the assertion to the new homepage promise and add the browser stubs needed by its client lifecycle. The focused interaction and motion coverage is in `apps/web/src/ui/home/*.test.*`.
- Current workaround: Nineteen new tests pass; the full suite is honestly reported as one obsolete-test failure. The original test has not been changed, disabled, or satisfied with hidden placeholder content.
- Decision (lead): Pending.

### [open] Connect the immersive homepage to the session and flags client
- Agent: Agent 6 — Frontend
- Need: `apps/web/src/client/` still contains only `.gitkeep`. The new homepage cannot consume a real wallet session or the production signup flag.
- Proposal: Deliver the `useSession()` and `useFlags()` functions from the shared client contract so the homepage can use the actual authenticated and paused states. This continues the earlier client request.
- Current workaround: `ForgeHome` accepts the shared `Flags` type for paused-state rendering. Creation actions open a preview-availability message without authentication or transaction simulation. No endpoint or money logic was invented.
- Decision (lead): Pending.


### [open] Complete the operational frontend client and missing display data
- Agent: Agent 6 — Frontend
- Need: A2–A11 now consume the shared WebClient through a development adapter, while `apps/web/src/client/` remains empty. A9 requires claimed-fee history, but LaunchpadDetail has no claim-history field. A3 lacks an official token acquisition URL and token decimals/symbol for formatting the raw gating amounts.
- Proposal: Deliver the existing WebClient exports and configured wallet selector; add backend-owned claim history (amount, date, signature), official token acquisition URL and display metadata. Define a reliable rejected-login result and a streamed-chat error channel; current session status and UseChatResult do not distinguish these states fully.
- Current workaround: Exact-signature mocks are enabled only with NEXT_PUBLIC_USE_MOCKS=1 outside production. Claim history displays an unavailable state; access amounts are labelled as raw units and the acquisition link opens explanatory FAQ content. Mock signatures/addresses are deliberately non-chain identifiers. No real connection, payment, claim, transaction construction, or external endpoint has been invented.
- Decision (lead): Pending.
