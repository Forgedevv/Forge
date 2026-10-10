# Loanmeme reference review

Reviewed on 2026-10-10 after the owner rejected the graphite/copper redesign and requested the preceding FORGE identity with closer reference behavior.

## Sources inspected

- [Public homepage](https://loanmeme.io/): document structure, six canvas chapters, scroll cue, fixed launch action, subtitles, manifesto, final heading, and timeline.
- [Public stylesheet](https://loanmeme.io/css/style.css): responsive dimensions, pointer-origin fill, typography, reveal transitions, and timeline states.
- [Public runtime](https://loanmeme.io/js/script.js): camera interpolation, interaction schedules, caption timing, moving typography, jump/boost timing, and grouped manifesto reveal.
- Public chapter GLB JSON metadata: six camera positions, look-at points, character landmarks, field of view, and portrait offsets. Only technical metadata was inspected in this pass; no model is incorporated in the application.

Downloaded inspection files remain outside the repository in the system temporary directory. No downloaded bundle is executed or embedded in FORGE.

## Applied behavior

| Reference detail | FORGE implementation |
| --- | --- |
| Separate floating logo letters, spring return, crosses, slashes, dotted fields | Locally generated FORGE letter textures and geometry in `scenery.ts`; the added metallic portal is removed. |
| Opening dolly, descent to screens, distant narrow-lens workshop, orbit, diagonal flight | Rounded public camera landmarks in `camera-path.ts`, continuous interpolation, and a portrait FOV ceiling. Character facing and workshop height are adapted to local geometry; a geometry check verifies that the boots meet the grid. |
| Sliding repeated typography and a title that tips with scroll progress | Repeating UV marquee and progress-driven X rotation in the glass chapter. |
| 100 px scroll circle, 72 px below 800 px; 2-second ring; 0.2-second pointer-origin fill; 0.95 hover scale | `scroll-cue.tsx` and `home.css`; keyboard focus uses the center. Mobile omits the fill, following the reference. |
| Caption decoding: 1-second reveal, 40 ms ticks, 3.5-second hold, 0.5-second fade | `choreography.ts` and `caption.tsx`; complete readable text remains available to assistive technology. Timers pause in hidden tabs and clean up on unmount. |
| Manifesto groups reveal once: 0.2-second line cadence, 0.4-second group gap, 0.06-second letter stagger | Vertical text strips replace the previous cycling group. Background strips grow over 1.5 seconds and letters reveal over 2 seconds. |
| Final heading with independently colored letters | Per-letter 5-second color cycles use the existing violet/magenta identity. Final action is an underlined text action with an animated arrow. |
| Ready, passed, viewing timeline dots | Three explicit states, retaining accessible chapter labels and current-step semantics. |
| Continuous tapered pointer trail | Reused tube buffers replace separate beads. Parallel/stationary histories are covered by geometry tests. |

The dashboard, Muse, and homepage use the preceding violet FORGE colors. Gallery search, status filters, launchpad covers, and operational screens remain. Palette restoration does not remove functional improvements.

## Deliberate overrides and limits

The owner's earlier comfort requests still apply: 0.85-second intro, capped scroll speed, chapter dwell, lower glow/exposure, restrained shake, and a clear final-action foreground. These override a literal reproduction where necessary. The drafting floor remains matte instead of introducing another full-scene reflection render.

FORGE's character, artwork, poses, content, glass materials, floor, and flight scenery remain locally authored. Measured cadence and camera landmarks do not imply identical limb trajectories, shaders, lighting, or pixels. The runtime uses the installed Three.js postprocessing rather than the reference's custom glass/outline and bloom/SMAA pipeline.

The current browser inventory is empty and opening the in-app browser fails. No browser rendering comparison, screenshot review, GPU frame-rate measurement, or After Effects/Higgsfield export was performed. Exact visual and motion equivalence remain unverified; component tests and HTTP checks do not establish them.
