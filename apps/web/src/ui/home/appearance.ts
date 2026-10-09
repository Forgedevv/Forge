/**
 * Brightness, glow, and material settings for the homepage scene, kept together so the
 * overall exposure can be tuned in one place.
 */

/** Post-processing bloom. A high threshold keeps the pilot and screens from blooming. */
export const BLOOM = {
  /** Initial strength; the per-chapter values below override it every frame. */
  strength: 0.18,
  radius: 0.34,
  threshold: 1.5,
  /** Per-chapter strength, from ignition to liftoff. */
  chapterStrength: [0.06, 0.07, 0.1, 0.06, 0.08, 0.1],
  /** Extra strength added at the peak of the liftoff boost. */
  boost: 0.035,
} as const;

/** Scene lighting. The key is noticeably stronger than the fill to keep the pilot modeled. */
export const LIGHTING = {
  exposure: 0.72,
  environmentIntensity: 0.42,
  fillIntensity: 0.78,
  fillGroundColor: '#3d3366',
  keyIntensity: 1.2,
  /** Per-chapter intensity of the pointer-following light near the pilot. */
  pointerIntensity: [0.7, 0.7, 1.2, 0.7, 0.7, 0.9],
  /** Per-chapter strength of the soft accent glow in the backdrop behind the pilot. */
  backdropGlow: [0.05, 0.018, 0.018, 0.025, 0.015, 0.03],
} as const;

/** The pilot's shell: a lavender white with enough roughness to show its shading. */
export const PILOT_SHELL = {
  color: '#d0cedb',
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
