# 08 — FRONTEND (agent 6)

**You own**: in `apps/web`: `app/**` except `app/api/**`, `src/ui/**`, `public/**`, global styles and Tailwind config. In `apps/launchpad-template`: `src/theme/**`, `src/content/**`, `src/components/**`, layout of `src/pages/**`.
**You read**: the whole `docs/frontend/` folder (it is self-sufficient), then `PLANEXECUTE.md`.

You build the entire FORGE site interface and the base design of the client sites, with no money logic whatsoever. The details (scope, screens, contract with the backend, mocks, definition of done) are in `docs/frontend/README.md`.

## Steps

- [ ] Design system `apps/web/src/ui/` (tokens as CSS variables, base components, dark/light mode).
- [ ] Mocks of `docs/frontend/CONTRACT.md` in `src/ui/mocks/` + `/dev/states` page.
- [ ] Screens A1 to A11 of `docs/frontend/SCREENS.md`, in all their states.
- [ ] Base template design (B1 to B7), entirely driven by the theme variables; `src/theme/README.md`.
- [ ] Switch from the mocks to the real `src/client/` once agent 3 has delivered it (import change only).
- [ ] Component tests listed in `docs/frontend/README.md`.

## Dependencies

Agent 3 (`src/client/`), agent 2 (`src/forge/` components and `SiteConfig`). Meanwhile: mocks with the same signatures.

## Report

### 2026-10-06 — Reference changed to Loanmeme

**Done**
- Removed the rejected Helion implementation at the user's explicit request, including its renderer, styles, content, tests, and provisional Terms page.
- Restored the original homepage, layout, and global styles. All application files now match the branch baseline.
- Read the public text of `https://loanmeme.io/`. The requested replacement must reproduce its layout, scroll progression, animation timing, and transitions with different characters, artwork, and content appropriate to FORGE.
- Production build, its TypeScript step, and the original homepage test pass after removal. `git diff --check` passes.

**Not done / blocking input**
- The replacement has not been implemented. Browser inventory is empty; creating an in-app browser or Chrome tab returns "Browser is not available". Direct public-resource downloads also fail. The text-only web reader does not reveal the visual choreography.
- A recording of Loanmeme from initial load through a slow full-page scroll, including relevant hover and click interactions, is needed to inspect the requested motion accurately. No claim of having seen its animations has been made.
- Full frontend task 08, backend client integration, contract mocks, and template implementation remain outstanding. The template still contains only its README.

**Requests / notes**
- The earlier placeholder-test change request is superseded by removal of that design; the original test passes again.
- No dependency added, backend logic changed, commit created, or remote action performed.
- Restoring the three application files succeeded, but the existing global post-checkout hook reported missing `basename` and an invalid hook path afterward. The hook and Git configuration were not modified or bypassed.

### 2026-10-06 — Public reference access recovered

**Done**
- Confirmed branch `agent/frontend` before other repository work.
- Direct HTTP access now succeeds. Downloaded and inspected Loanmeme's HTML, styles, script, common scene, six chapter scenes, and animated character. Third-party downloads remain in the system temporary directory.
- Located the matching Junni engine source and compared its scroll-controller equations with the live reference bundle. The upstream code is MIT-licensed; its website content and model assets are expressly excluded.
- Saved a detailed source-based motion audit and machine-readable measurements in `apps/web/src/ui/reference/loanmeme/`, including chapter camera transforms, character transforms, clip bounds, timed transitions, responsive adjustments, pointer interactions, and outstanding visual checks.
- Verified the measurements contain all six scenes and seven character clips. Documentation formatting and `git diff --check` pass. No application runtime changed, so the earlier baseline build/test results were not presented as validation of a new renderer.

**Not done / uncertainty**
- The requested replacement homepage is not implemented. Live browser inventory still reports no apps or browsers, so visual equivalence and real gesture behavior remain unverified.
- Static source inspection is now possible; the earlier statement that public downloads fail is superseded. A user-supplied recording is no longer the sole way to investigate the motion.
- Source transforms include later runtime overrides; measurements alone are not a finished rendering implementation.
- A direct adaptation requires missing rendering dependencies, which this agent is not allowed to add. The dependency request is recorded below rather than bypassed by copying a bundled script into the app.
- Original FORGE character artwork, retargeted motion, scene assets, the complete operational frontend, contract mocks, and template work remain outstanding.

**Requests / notes**
- Appended the rendering-dependency request to `docs/CHANGE_REQUESTS.md`, signed `Agent 6 — Frontend`.
- No dependencies, package manifests, lockfile, backend, API, money logic, Git settings, or remote state changed. No commit, push, or deployment.

### 2026-10-07 — Rendering dependencies reviewed and installed

**Done**
- Confirmed `agent/frontend`. The user authorized the previously requested dependency additions and the necessary manifest/lockfile edits.
- Installed exact versions of Three `0.186.1`, Cannon ES `0.20.0`, Lethargy `1.0.9`, and Three declarations `0.186.0`. Added a local Lethargy CommonJS declaration. Existing dependency versions were preserved.
- Checked licenses and lifecycle scripts, verified all ten archive SHA-512 values, and checked each new direct/transitive version against deps.dev: no known advisories reported. Read Lethargy's runtime and performed targeted Three/Cannon source checks. Installed with scripts disabled using a temporary offline store, then imported the verified packages into the worktree's existing local installation.
- Frozen lockfile validation, app typecheck, lint, the existing homepage test, and production build pass. Additional runtime and strict TypeScript checks cover animation, GLTF parsing, postprocessing imports, visual physics, wheel directions, and library declarations.
- Recorded evidence, maintenance considerations, compatibility requirements, and the offline installation method in `apps/web/src/ui/reference/loanmeme/dependencies.md`.

**Not done / uncertainty**
- The renderer and replacement homepage are not implemented. Original FORGE assets, shader migration, real gesture checks, GPU rendering, mobile performance, and visual comparison remain outstanding.
- Cannon ES and Lethargy have older release dates; the absence of known advisories is not a security guarantee. The full existing workspace could not be audited because the registry audit endpoint failed with `EACCES`.
- Full task 08, client integration, contract mocks, and template work remain outstanding as previously reported.

**Requests / notes**
- Appended the accepted dependency decision to `docs/CHANGE_REQUESTS.md`. The prior missing-dependency authorization blocker is resolved. Old `cannon` and beta `ore-three` were not installed.
- No backend, API, money logic, credentials, global settings, or remote state changed. No commit, push, or deployment.


### 2026-10-07 — First immersive FORGE implementation

**Done**
- Replaced the placeholder homepage with six overlapping Three.js scenes, an original articulated workshop pilot, a new ember/ivory/graphite identity, and centralized English copy. Added the product details drawer, FAQ route, and provisional Terms information.
- Implemented the measured camera path, adapted character transforms, spring scroll response, wheel filtering, touch navigation, two-second timeline transitions, first-scroll navigation, ignition and physics reveal, refractive materials, planar reflection, grid/makers, manifesto, particles, pointer trail, and final flight/boost sequence.
- Preserved the measured jump and boost schedules and authored new character poses using the reference loop cadences. Retained Junni's MIT notice for adapted spring code. No reference artwork, model, font, animation tracks, or bundled script was incorporated.
- Added keyboard controls, chapter announcements, reduced motion, a pause control, 800 px responsive behavior, portrait camera offsets, mobile rendering limits, a simple-view fallback, modal focus handling, and lifecycle cleanup.
- Production build, app typecheck, and lint pass. Nineteen new interaction/motion tests pass. The full suite has one failure in the untouched placeholder test; a change request identifies the exact needed update.
- Started a local preview at `http://127.0.0.1:3007/` and checked the returned homepage HTML. Detailed implementation and fidelity limits are in `apps/web/src/ui/home/IMPLEMENTATION.md`.

**Not done / uncertainty**
- Exact visual equivalence is not certified. Browser inventory is empty and creating an in-app browser still returns `Browser is not available: iab`. GPU rendering, real pointer/touch comparison, mobile screenshots, and frame-rate profiling remain unverified.
- The geometric character and its poses are original, with measured timing but different limb trajectories. Modern physical materials and five-level bloom/renderer antialiasing replace the reference's custom shaders and seven-level bloom/SMAA. These differences are explicitly documented.
- The wallet/session and production feature flags remain unwired because the client is absent. The shared paused-signups prop is supported and tested; creation actions show an availability message and do not simulate financial operations.
- Remaining task 08 screens, full contract mocks/state gallery, backend integration, and the template remain outstanding. The template was not created or modified.

**Requests / notes**
- Appended requests for the obsolete homepage test and missing session/flags integration. No other agent's source was changed.
- Files generated by the Next development server are ignored and were not committed.
- No backend, API, money logic, global settings, credential, Git configuration, or remote change. No commit, push, or deployment.

### 2026-10-07 — Softer palette and motion corrections

**Done**
- Responded to the user's visual feedback with a sage, stone, graphite, and muted-copper palette across the immersive scenes, interface, and fallback illustration. Reduced exposure, bloom, emissive lighting, specular highlights, camera shake, flight FOV changes, wind streaks, and chromatic separation.
- Interpolated the fixed-step scroll simulation for continuous presentation at higher refresh rates. Removed duplicate wheel filtering, accepted immediate direction reversals, cleared stale momentum on touch capture, and synchronized instantaneous navigation with the spring state.
- Replaced elapsed-session-time rotation formulas with integrated yaw/bank so revisiting a chapter does not cause accelerated spinning. Preserved each scene's animation clock through overlapping fades, blended lighting/effects continuously, removed the cloud's periodic position jump, and made the pointer trail time-based with a correct starting position.
- Kept blending shader variants stable during scenery fades, reduced transmission render resolution, avoided duplicate resize allocations, and reused per-frame light-offset vectors.
- App typecheck, lint, production build, and all 26 current UI/motion tests pass. The complete suite reports 26 passing tests and the single pre-existing obsolete-placeholder assertion failure. Checked HTTP 200 on the local preview and readable contrast for the main static UI color pairs.

**Not done / uncertainty**
- No live browser is connected; browser inventory still returns no browsers. Actual GPU frame rates, visual polish on the user's display, and trackpad/touch behavior have not been observed by the agent. No claim of eliminating every possible rendering hitch is made.
- The out-of-scope placeholder test and remaining task 08 deliverables remain as documented above.

**Requests / notes**
- No new dependency or backend change. No additional request is needed; the earlier obsolete-test request remains open. No Git configuration change, commit, push, or deployment.

### 2026-10-10 — Graphite workshop and editorial client template

**Done**
- Reworked the homepage scenery with an engraved metallic portal, individually composed example-site displays, a matte drafting floor, and distant liftoff gates. Removed the foreground ribbon behind the final action and the additional full-scene reflection render.
- Unified the homepage, workspace, and default Muse finishes around graphite, ivory, brushed metal, and muted copper, following the user's request for softer colors. Kept supplied monochrome logo assets. Reduced the dashboard figure's rim emission and added an engraved drafting dial.
- Synchronized chapter-copy opacity with journey progress so text fades out before the chapter changes and returns as the next scene arrives. Existing capped transition speed, acceleration, and chapter dwell remain intact.
- Rebuilt the dashboard as a responsive portfolio with theme-driven identity covers, concise labels, search/status filters, current job activity, and separate site/detail/edit actions. Fee amounts still come directly from the WebClient. Covers are identity artwork, not screenshots of deployed sites.
- Added `/dev/workshop` for a direct three-launchpad design preview. Both it and `/dev/states` remain unavailable in production; previews use exact-signature development mocks and no real wallet or funds.
- Rebuilt the client template's home composition around its configured name and tagline, locally authored animated engraved medallions, three compact market columns, clearer empty/error states, accessible token links, and theme-driven header/footer/create/about layouts. Documented the new theme variables and respected reduced motion.
- Reframed the existing token page with a chart/table column and a sticky trade rail. Mobile places trading between the chart and transaction list. Its existing data subscriptions, chart, and Jupiter trading components are unchanged.
- Web typecheck, lint, build, and 192 tests pass, including search/filter recovery and disabled-site actions. Template typecheck, lint, build, and five tests pass. `git diff --check` passes.
- Local HTTP checks return 200 with expected markup for the homepage, workshop preview, state gallery, template homepage, About, and Create pages. Development servers are available on ports 3000 and 3001.

**Not done / uncertain**
- Visual equivalence to Loanmeme, real GPU frame rate, and actual pointer/touch behavior are not certified. Browser inventory is empty and opening the in-app browser returns `Browser is not available: iab`; no visual-browser test or external animation-service export was performed.
- Production WebClient integration and the missing template `TradePanel`, `ClaimCreatorFees`, launchpad-coin display data, and route decision remain the backend-owned requests recorded in `docs/CHANGE_REQUESTS.md`. The redesign does not fabricate these functions.
- Previous report entries describing an empty template, missing A2–A11 mocks, or obsolete failing homepage tests are historical. This branch now has those operational screen mocks and the state gallery; production integration is still pending.

**Requests / notes**
- No new dependency, transaction construction, amount calculation, API/database change, Git configuration change, remote change, or deployment. The mock flag is supplied only to the local web development process; no environment file or persistent environment setting was changed.
- Git author and committer identity were verified with read-only `git var`: `Forgedevv <ali.ben_yezza@proton.me>`.

### 2026-10-10 — Restore FORGE identity and refine reference details

**Done**
- Restored the preceding violet/magenta identity across the dashboard, workspace controls, Muse, and immersive homepage after the owner rejected the graphite/copper direction. Dark and light workspace tokens match the preceding identity. Restored the dashboard's typography, rounded controls, and colored logo while retaining gallery search, status filters, covers, and operational screens.
- Inspected Loanmeme's current public HTML, stylesheet, runtime, and chapter-camera JSON metadata. Recorded measured behavior and remaining differences in `apps/web/src/ui/home/REFERENCE_REVIEW.md`. Inspection downloads remain outside the repository; no downloaded bundle or reference artwork is embedded.
- Removed the added metallic portal. Added individual floating FORGE letters with spring return, crosses, slashes, and dotted fields. The glass chapter now has a continuous repeated-text marquee and a title that rotates with journey progress.
- Applied the measured camera sequence with continuous interpolation: opening dolly, dark descent, distant narrow-lens workshop, orbit, and diagonal flight. Adapted character facing and workshop height to the local pilot, verified its boots meet the grid, and capped portrait FOV.
- Added the pointer-origin circle fill, rotating gradient ring, one-second caption decoding with measured hold/fade timing, one-time grouped manifesto strips, per-letter final-word color motion, underlined final action, explicit timeline-dot states, and a continuous tapered cursor trail. Removed redundant visible corner headings and enlarged mobile captions.
- Preserved the earlier short intro, capped scroll speed, chapter dwell, reduced glow, reduced shake, accessible navigation, hidden-tab suspension, pause controls, and cleanup behavior.
- Web typecheck, lint, build, and 204 tests pass, including the cursor tube's exterior face winding. `git diff --check` passes. HTTP checks return 200 with expected markup for the homepage, `/dev/workshop`, and `/dev/states`. The local web preview remains on port 3000 with development mocks enabled only for that process.

**Not done / uncertain**
- Exact visual and motion equivalence, real pointer/touch comparison, 375 px rendered layout, and GPU frame rate remain unverified: browser inventory is empty and opening the in-app browser fails. No After Effects or Higgsfield export was performed.
- FORGE's character, poses, artwork, glass/outline materials, postprocessing, matte floor, and flight geometry remain locally authored. Camera measurements and matching schedules do not establish identical pixels or limb trajectories.
- Production client integration and the backend-owned template requests remain as recorded in `docs/CHANGE_REQUESTS.md`. The template was not changed in this correction; its prior checks are historical, not rerun for unchanged code.

**Requests / notes**
- No new dependency, backend/API/database change, transaction construction, amount calculation, environment-file edit, global setting, Git configuration change, remote change, push, or deployment.
- Changes are committed locally on `agent/frontend` with the verified `Forgedevv` identity. No new dependency or backend request is needed for this pass.

### 2026-10-10 — Open dashboard composition

**Done**
- Removed the dashboard Muse banner's enclosing border, rounded frame, solid surface, and rectangular stage background. Muse now sits directly on the page in the existing violet identity.
- Reduced the supporting heading and hid its repeated workshop label. Desktop places the short status copy beside Muse; mobile places Muse above centered copy. Existing scene interactions, launchpad satellites, state-driven actions, and fallback remain.
- Added an explicit open layout to the shared hero and selected it only in the dashboard; session panels retain their existing layout.
- Web typecheck, lint, production build, and all 204 tests pass. Local HTTP inspection confirms the open-layout markup and stylesheet are served by `/dev/workshop`.

**Not done / uncertain**
- The supplied screenshot informed the correction. Final desktop/mobile rendering remains unverified; inspecting HTML and CSS is not a rendered visual check.

**Requests / notes**
- No new dependency, backend change, financial logic, palette change, global setting, push, or deployment. No new request is needed.

### 2026-10-10 - Compact dashboard introduction

**Done**
- Combined the page title, state-driven status, creation/build actions, and Muse into one compact introduction. Reduced the title scale and removed the second large heading and repeated supporting sentence for populated workshops.
- Moved the four overview counts into the introduction as a compact definition list. Removed the tall metric columns and their vertical dividers so the site collection starts sooner.
- Kept the established violet palette, animated Muse, search/status filtering, site actions, and paused-signup behavior. Mobile places Muse beside the copy and stacks each count above its label; the smaller 2D fallback and wrapping satellite row fit the narrower stage.
- Web typecheck, lint, and production build pass. The full 204-test suite passed, and the seven dashboard/hero tests were rerun successfully after the fallback adjustment. Local HTTP inspection returns 200 and confirms the integrated heading, summary, site grid, and updated stylesheet at `/dev/workshop`.

**Not done / uncertain**
- The user's screenshot guided this change. Rendered desktop/mobile layout is still unverified: browser inventory is empty and opening the in-app browser returns `Browser is not available: iab`.

**Requests / notes**
- No new dependency or backend request. The preview remains local on port 3000. No financial logic, global setting, Git configuration, push, or deployment was changed.

### 2026-10-10 - Connect the real web client

**Done**
- Replaced the old unavailable adapter in the application provider with the delivered backend-owned `realClient` and `ForgeClientProvider`. The homepage and A2-A11 now share the real session, flags, data hooks and existing client actions outside development previews.
- Loaded the live wallet stack separately from mock previews. Production ignores both the public mock flag and supplied preview controllers; development mock screens mount no live wallet provider or API hooks.
- Added a wallet-login continuation step because opening the selector does not create an authenticated session. Kept protected screens locked until the real session exists and made failed access checks show a retryable unavailable state.
- Replaced the native top-layer login dialog with an accessible overlay below the wallet picker. Added keyboard wrapping, Escape dismissal, focus restoration and focus handoff to the adapter's body portal, so the picker is not blocked by an inert native-modal background.
- Added eleven integration tests using the real hooks with simulated HTTP and wallet adapters. They cover login/logout, authentication errors, access-check failure/retry, flags, production mock rejection, development isolation and dialog focus behavior, including the connected view. No private key, real signature or chain transaction was used.
- Web typecheck, lint, build and all 215 tests pass. `git diff --check` passes. Production HTTP inspection confirms session gates on workshop routes and not-found/noindex results with no mock content on all three development routes, even with a mock flag supplied to the server process. These streamed not-found responses carry HTTP 200; no literal 404-status claim is made.
- Documented actual route availability and client limitations in `apps/web/src/ui/workspace/INTEGRATION.md`. Kept the established design and palette.

**Not done / uncertain**
- Backend route/service assembly and integration of `w3/integration` remain pending. Chat/spec/payment routes exist there but not on this branch; flags, gating, RPC, owner-transaction, approval, modification, reactivation and claim routes are still absent. Real database policies and the complete devnet flow have not been verified here.
- Current flag hooks retain an open default on failed reads. Job/list/detail hooks have no shared error channel and may wait indefinitely or disguise failed reads as an empty list. These backend-owned behaviors cannot be resolved by fabricating frontend results. Earlier claim-history, acquisition/display metadata, rejected-login and chat-error requests remain open.
- No rendered-browser or physical-wallet test was possible; browser inventory is empty. Existing jsdom canvas and unset `metadataBase` warnings remain. The client template was unchanged.

**Requests / notes**
- Appended the route/contract handoff request signed `Agent 6 — Frontend` in `docs/CHANGE_REQUESTS.md`; earlier missing-client requests are resolved only in their client-delivery portion.
- Changes remain inside the frontend zone and are committed locally on `agent/frontend` with the verified `Forgedevv` identity. No dependency, backend/API/database implementation, financial logic, environment file, persistent environment setting, Git configuration, remote, push or deployment was changed.
