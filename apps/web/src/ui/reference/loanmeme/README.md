# Loanmeme motion reference

Inspection date: 2026-10-06. Target: https://loanmeme.io/.

This is a source inspection, not a recording or a browser-verified reproduction. Public HTTP downloads now work. The connected computer/browser inventory is still empty. The FORGE homepage has not been replaced by this document.

## Evidence and reusable source

Downloaded and inspected the public HTML, CSS, JavaScript, common scene, six chapter scenes, character scene, and social preview image. The downloaded third-party files remain in the system temporary directory, outside the application. No reference model, texture, script bundle, or font has been incorporated into the product.

The reference contains the same scene architecture, object names, and scroll equations as [Junni's published source](https://github.com/junni-inc/next.junni.co.jp). The original [Scroller](https://github.com/junni-inc/next.junni.co.jp/blob/master/src/ts/MainScene/Scroller/index.ts) was fetched and compared with the reference bundle. This supports a shared codebase; it does not establish the provenance of every Loanmeme-specific modification.

Junni's [README](https://github.com/junni-inc/next.junni.co.jp#license) grants MIT licensing to source code, but explicitly excludes website content, including images, SVGs, 3D models, and text. Preserve the [MIT notice](https://github.com/junni-inc/next.junni.co.jp/blob/master/LICENSE) for adapted code. Create FORGE's own character, scene artwork, logos, textures, and copy. Do not transfer the downloaded Loanmeme bundle into the app as a shortcut.

## Architecture

- A viewport-sized WebGL canvas contains the experience. The six chapters are overlapping scenes, not six conventional vertically stacked marketing sections.
- One floating, skinned character persists across the journey. Position and scale interpolate linearly between chapter transforms; orientation uses quaternion interpolation. Camera position, target, and field of view also interpolate.
- The scroll controller maintains a continuous value from chapter 0 through chapter 5. Selection controls scene visibility, lighting, material transitions, subtitles, and footer progress.
- Mouse wheel input adds velocity. A spring attracts the camera to a chapter. Touch drag and release have their own gain. Clicking a timeline marker animates to its chapter over two seconds; the initial scroll button advances over one second.
- Continuous animation runs independently of scroll: character clips, rotating objects, moving typography, snowfall, particles, and pointer trails.
- Pointer position changes camera framing with smoothing. It also interacts with logo pieces, transparent props, and a light in the dark display scene. The pointer trail changes material per chapter and is disabled on the site's mobile-device path.
- Postprocessing includes seven bloom levels, multiple blur passes, SMAA antialiasing, vignette, and compositing. Character transparency samples the rendered scene behind it. Ground reflections and character shadows are separate rendering concerns.

## Chapter inventory

| Chapter | Scene structure found in code/assets | Motion and appearance changes |
| --- | --- | --- |
| Intro | Logo, reveal line, secondary text, geometric props, a separate camera and render target | The active logo sequence lasts about 4.8 seconds after readiness. A loading subtitle is scheduled during the reveal. The intro image then becomes a breakable wall. |
| 1 | Character, multipart logo, crosses, slashes, dots, curved lines, gradient objects, snowfall | Character moves forward from behind the wall over one second. Physics uses downward gravity of 2 scene units/s². Hero elements begin appearing after 0.5 seconds; wall resources are disposed after 1.5 seconds. The background is an animated ice-blue gradient with a passing lime accent. |
| 2 | Character, repeated slanted background type, rotating title, transparent cube/cylinder/torus, flexible type | Character becomes glass over one second and rotates at -0.09 radians/s. Its chapter-5 clip is reused at 0.4 playback speed. Title rotates around X at 0.3 radians/s. Background is white with stronger vignette. |
| 3 | Eight display groups, emissive lights, cables, background text, particles, reflective ground | Camera travels downward into a dark scene. Character faces the displays, with solid material and a different Fresnel mode. Pointer controls a light. Bloom increases to 1.5; subtle camera drift is enabled. |
| 4 | Elevated camera, grid ground, large modeled lettering, falling/tiled words, 26 moving people, pointer pen | Character becomes outlined. Jump runs every 3.5 seconds. At 0.7 seconds into a jump, words switch and the camera shakes for about 0.3 seconds. Ground grid fades in over 1.5 seconds; illustration reveal starts 0.5 seconds later. |
| 5 | Dark character, procedural text ring and grid, three groups of manifesto text | Character rotates at 0.18 radians/s and uses its clip at 0.7 speed. A parent rotates around Z at -0.1 radians/s. Text reveals by groups, lines, then characters; the mobile version substitutes an image. |
| 6 | Flying character, wind streaks, particles, luminous curving road, central serif CTA | Entry triggers acceleration, wider camera field of view, and shake. Scrolling down retriggers the boost after it finishes. Final headline characters cycle through hues. Duplicate background characters exist in the asset but are disabled in the inspected Loanmeme code. |

The original introduction has three narrative-text objects and associated DOM nodes, but the inspected active start sequence calls only the logo routine before finishing. Do not infer that all three narrative paragraphs are currently played simply because they are present in the HTML.

## Timing measurements

| Behavior | Value read from the reference |
| --- | --- |
| Initial logo stages | 1.0 s, 1.0 s, 0.8 s, 1.5 s, 0.5 s |
| Loading-progress interpolation | 0.5 s |
| Intro wall reveal / disposal | 0.5 s / 1.5 s after splash |
| Initial scroll button appears | 1.0 s after splash |
| Initial scroll button movement | 1.0 s, cubic ease-in-out |
| Footer chapter navigation | 2.0 s, cubic ease-in-out |
| Usual material/visibility crossfade | 1.0 s |
| Character animation crossfade | 1.0 s |
| Chapter-4 jump interval | 3.5 s |
| Jump-to-text-switch delay | 0.7 s |
| Chapter-5 group delay | 0.2 s per preceding line plus 0.4 s |
| Chapter-5 line stagger | 0.2 s |
| Chapter-5 character stagger | 0.06 s, starting at 0.2 s |
| Chapter-5 character reveal | color 2.0 s; lateral offset 1.0 s |
| Chapter-5 text backing reveal | 1.5 s |
| Normal subtitle typing | 1.0 s; redraw every 40 ms |
| Normal subtitle hold | 3.5 s after typing |
| Subtitle cleanup after hiding | 0.5 s |
| Scroll-circle rotation | 2.0 s, continuous linear |
| Final boost | particle speed 1 to 10 over 2.0 s |
| Final boost camera | FOV offset +15 degrees over 1.0 s; shake 0.15 over 0.8 s |
| Boost recovery | FOV/particle speed recover over 4.0 s; shake over 2.0 s |
| Final CTA entrance | opacity 1.0 s after a 1.0 s delay |

The clip durations in `motion-measurements.json` are asset durations, not wall-clock playback durations. The runtime truncates most repeating clips at 100/30 seconds and the final flying clip at 4 seconds. Chapter 3 has separate playback behavior. Playback speed and crossfades must be accounted for when retargeting animation to a new character.

## Scroll and camera measurements

The reference wheel gain is 0.00005. Touch movement gain is 0.0005; the main scene doubles the final touch delta before release. The nearest chapter is biased by 0.45 in the direction of velocity. Inertia uses a 0.3 spring factor, 0.86 damping, an acceleration multiplier of 10, and velocity damping proportional to 8 times the frame delta. The main loop caps frame delta at 0.1 seconds.

The measured camera and character transforms are preserved separately in `motion-measurements.json`. They are measurements of the downloaded scene, not new FORGE art. Chapter 3 overrides character height and orientation after loading; chapter 4 and mobile layouts also modify loaded camera/scene transforms. Raw GLB coordinates alone do not reproduce the rendered result.

Most chapter transitions use the animator's default sigmoid easing, while navigation uses cubic ease-in-out and some light/bloom changes use cubic ease-out. Applying one easing to every effect would change the reference's feel.

## Responsive behavior

- The main layout breakpoint is 800 px; one language-toggle adjustment uses 768 px.
- Mobile camera field-of-view offsets vary by chapter: 25, 30, 18, 5, 30, and 30 degrees times the portrait weight.
- Additional offsets and scales reposition the hero decorations, flexible text, and final camera in portrait mode.
- The initial scroll button changes from 100 px to 72 px.
- Mobile disables the cursor trail and uses an image for the manifesto. FORGE needs an accessible text alternative, not a screenshot of the original copy.
- Device detection and portrait weighting both affect the result. Testing only a narrow desktop viewport is insufficient.

## FORGE adaptation boundaries

Keep the six-scene composition, transition paths, gesture response, per-effect timing, character continuity, typography motion, footer navigation, and final acceleration. Replace the character and all brand/content assets with a coherent FORGE workshop/launchpad identity. Recreate the animation on the new character; changing a material color alone does not constitute a new character.

FORGE copy must remain English and centralized. Wallet actions must consume the shared client contract. Do not wire the reference's lending application, social accounts, addresses, or external scripts into FORGE. The eventual interactive home must still meet A1's required content and paused-signups state. Reduced-motion, keyboard navigation, error fallback, and visible focus also remain required even where the reference does not provide them.

## Integration status

Updated on 2026-10-07: the user authorized the rendering dependencies. Three, Cannon ES, Lethargy, and Three declarations are installed at the exact versions recorded in `dependencies.md`.

A new FORGE homepage now implements six scenes, an original procedural character, the measured scroll response and camera path, and the corresponding visual effects. See [implementation status](../../home/IMPLEMENTATION.md) for validation, integration boundaries, and differences from the reference. No reference bundle or third-party artwork was copied into the application.

Browser validation remains unavailable. The previous rejected design remains removed. The implementation is source-informed; visual and gesture equivalence have not been verified in a rendered browser.

## Acceptance checks for the eventual implementation

1. Compare initial load, all six settled scenes, and transitions in both directions in a rendered browser.
2. Compare mouse wheel bursts, trackpad inertia, touch dragging, and all six timeline targets.
3. Compare pointer interactions separately from scroll animations and verify mobile omissions.
4. Match the jump/text/shake sequence and the final acceleration and recovery timings.
5. Validate at 375 px and desktop widths, including reduced motion, keyboard-only navigation, and WebGL failure.
6. Verify all assets are local and original or explicitly licensed, with required source notices retained.
7. Run the app's typecheck, lint, build, and relevant interaction tests once implementation exists. A successful baseline build does not validate this future renderer.
