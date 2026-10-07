# FORGE immersive homepage

Implemented on 2026-10-07 in the `agent/frontend` worktree. This replaces the original placeholder homepage with a six-chapter, full-viewport Three.js experience. The earlier rejected Helion implementation remains removed.

## Included

- An original articulated workshop pilot, created from geometry in `character.ts`, with a matching original SVG illustration for the simple view. No downloaded character, scene model, animation track, font, or reference bundle is used.
- Six scenes: ignition and floating hardware; glass and moving typography; eight launchpad displays with a planar reflection; a drafting grid with 26 instanced makers and jumping type; an orbital manifesto; a luminous flight path with accelerating wind.
- An original FORGE camera journey in `camera-path.ts`: per-chapter camera position, roll and field of view, look-at target, character transform, and portrait field-of-view offset, all authored for this scene composition. The path starts low in front of the pilot, slides right for the glass chapter, drops to the launchpad wall, rises over it onto the drafting table, climbs into orbit, and banks away behind the pilot for liftoff. Camera movement and character orientation interpolate continuously across chapters.
- Fixed-duration wheel navigation: one gesture advances one chapter over 1.8 seconds, regardless of wheel magnitude or tail length, following the user's revised direction. Timeline buttons retain their explicit target navigation. Junni's adapted touch spring uses an interpolated 60 Hz simulation; touch capture clears stale momentum.
- A 0.85-second ignition sequence; a physics-based wall reveal; one-second material transitions; independent particle, FOV, and shake timing for the final boost; the 3.5-second jump cycle and 0.7-second word switch.
- Newly authored character poses using the inspected loop durations and playback rates. The poses themselves are not the reference's authored skeletal animation.
- Glass transmission, wire overlays, lighting, environment reflections, a reflective floor, bloom, vignette, chromatic separation during acceleration, particle fields, and a desktop pointer trail.
- Keyboard, wheel, and touch navigation; chapter announcements; visible focus; reduced-motion preferences; a pause control; modal focus restoration; suspension in hidden tabs; disposal on unmount; and a readable fallback after a rendering failure.
- Responsive styles at the reference's 800 px breakpoint, portrait camera offsets, lower mobile render resolution, and a mobile omission of the pointer trail.
- Centralized English copy in `content.ts`: promise, four creation steps, the approved marketing prices, an illustrative launchpad, FAQ, and provisional product information at `/terms`.

## Integration boundaries

`apps/web/src/client/` still contains only `.gitkeep`. With development mocks explicitly enabled, the homepage consumes shared session/flags hooks, opens the global login modal, and links connected users to the workshop and dashboard. Without mocks, creation actions show the existing unavailable-service message. No real wallet or payment is simulated as a live operation. The real client request remains open.

The associated A2–A11 interface, contract mocks, gallery, validation and integration limits are documented in `../workspace/README.md`. The real backend client and client template remain outstanding.

## Verification

- The app's production build, TypeScript check, and lint pass.
- Twenty-six new tests pass, covering navigation timing, wheel/touch boundaries, continuous high-refresh presentation, wheel reversal, touch takeover, rotation after prolonged idle, independent boost timing, jump timing, chapter controls, reduced motion, paused signups, availability messaging, modal dismissal/focus, and rendering-failure cleanup.
- The full app suite reports 26 passing tests and one failure in the untouched `apps/web/tests/home.test.tsx`, which still asserts `FORGE — coming soon`. That file is outside the frontend edit zone; its update is requested in `docs/CHANGE_REQUESTS.md`. No obsolete text was hidden in the interface to make the assertion pass.
- The development server serves the new homepage at `http://127.0.0.1:3007/`; the returned HTML contains the new promise and no placeholder. HTTP checks are not browser rendering checks.
- Browser inventory returned no browsers. An attempt to create an in-app browser returned `Browser is not available: iab`. GPU shader execution, screenshots, real trackpad/touch behavior, 375 px layout inspection, and frame-rate profiling remain unverified.

## Fidelity limits

The user's subsequent comfort feedback takes precedence over the original effect amplitudes. The current palette uses midnight ink, cool stone, and periwinkle, shared with the workshop controls. The latest feedback also shortened the intro, replaced momentum-driven wheel input with complete chapter transitions, and moved a thinner final flight path behind the subject to avoid near-camera clipping. Exposure, emission, bloom, specular highlights, wind streaks, camera shake, boost FOV, and chromatic separation have been reduced. Chapter lighting and postprocessing now blend continuously instead of switching when the selected chapter changes. The six scenes and interaction timing remain; the camera path has since been replaced by the original FORGE path described above.

Character yaw/bank integrate elapsed frame time instead of multiplying chapter weights by total session time. Chapter animation clocks survive overlapping transitions, cloud drift no longer wraps abruptly, and the pointer trail starts at the pointer with time-based smoothing. Scenery keeps a stable transparent shader variant during fades; duplicate size notifications no longer reallocate targets. Transmission renders at 50% viewport resolution on smaller screens and 75% on desktop, using Three's documented `transmissionResolutionScale` option. These changes are code-level improvements, not a measured GPU performance claim.

Static UI token contrast checks give 7.19:1 for the first light scene, 7.74:1 for the brightest dark-scene background, 6.58:1 for the primary action, and 4.79:1 for muted text on the details panel. These checks do not certify every animated/background combination.

This is a source-informed reconstruction with a new art direction, not a certified identical reproduction. The new geometric character and scene artwork intentionally differ. Its procedural poses preserve measured cadence but do not reproduce every limb trajectory. Modern Three physical materials replace the reference's custom glass and outline shaders. `UnrealBloomPass` uses five bloom levels, and renderer antialiasing replaces the reference's seven-level bloom/SMAA pipeline. Lighting and mobile framing still require a rendered comparison.

The implementation can be reviewed locally now. Pixel accuracy and motion equivalence must remain open until a browser can render both sites for comparison. No push, deployment, Git configuration change, or backend modification was performed.

The retained upstream notice is in `THIRD_PARTY_NOTICES.md`. No third-party camera, scene, or character data is stored in the repository.


## Workshop integration and review refinements

On 2026-10-07, the homepage baseline was committed locally before A2–A11 work. Subsequent revisions integrate the shared development session, shorten ignition to 0.85 seconds, lock wheel transitions to 1.8 seconds, and update the palette/buttons. The final road is thinner and remains behind the subject, avoiding the near-camera tube seen in the user's screenshot. The renderer now requests PCFShadowMap directly, resolving the deprecation warning forwarded by the preview server. These changes intentionally revise the earlier reference amplitudes and scrolling behavior.

The old palette contrast figures and test counts above describe the earlier committed revision; the final task report records the latest checks. No visual or frame-rate guarantee is made from HTTP or component tests.
