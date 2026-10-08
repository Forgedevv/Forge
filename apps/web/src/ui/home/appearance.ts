/**
 * Brightness, glow, and material settings for the homepage scene, kept together so the
 * overall exposure can be tuned in one place.
 */

/** Post-processing bloom. A high threshold keeps the pilot and screens from blooming. */
export const BLOOM = {
  /** Initial strength; the per-chapter values below override it every frame. */
  strength: 0.3,
  radius: 0.42,
  threshold: 1.3,
  /** Per-chapter strength, from ignition to liftoff. */
  chapterStrength: [0.12, 0.13, 0.2, 0.12, 0.17, 0.2],
  /** Extra strength added at the peak of the liftoff boost. */
  boost: 0.07,
} as const;

/** Scene lighting. The key is noticeably stronger than the fill to keep the pilot modeled. */
export const LIGHTING = {
  exposure: 0.82,
  environmentIntensity: 0.6,
  fillIntensity: 1.05,
  fillGroundColor: '#3d3366',
  keyIntensity: 1.7,
  /** Per-chapter intensity of the pointer-following light near the pilot. */
  pointerIntensity: [1.1, 1.1, 2.4, 1.1, 1.1, 1.4],
  /** Per-chapter strength of the soft accent glow in the backdrop behind the pilot. */
  backdropGlow: [0.05, 0.018, 0.018, 0.025, 0.015, 0.03],
} as const;

/** The pilot's shell: a lavender white with enough roughness to show its shading. */
export const PILOT_SHELL = {
  color: '#e6e3f2',
  roughness: 0.55,
  /** Roughness removed while the shell turns to glass. */
  glassSmoothing: 0.45,
  metalness: 0.08,
  clearcoat: 0.25,
  clearcoatRoughness: 0.45,
} as const;

/** The pilot's eyes and chest light. */
export const PILOT_EMISSIVE = {
  intensity: 0.4,
  /** Extra intensity in the dark manifesto chapter. */
  darkBoost: 0.15,
} as const;

/** Dust points drifting around the pilot. */
export const PILOT_HALO_OPACITY = 0.26;

/** Glowing cables on the launchpad wall and the liftoff road. */
export const CABLE_GLOW = {
  emissiveIntensity: 0.3,
  /** Multiplier applied to the cable color to obtain its emissive color. */
  emissiveTint: 0.75,
} as const;
