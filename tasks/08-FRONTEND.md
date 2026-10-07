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
- Next's development server generated ignored `apps/web/AGENTS.md` and `CLAUDE.md`; their instruction to commit generated files is overridden by the user's explicit prohibition. Neither is staged or committed.
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
