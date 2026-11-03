import type { ComponentType } from 'react';

/** Families of the visual library, in the order the showcase lists them. */
export const LIBRARY_FAMILIES = ['backgrounds', 'text', 'motion', 'three'] as const;
export type LibraryFamily = (typeof LIBRARY_FAMILIES)[number];

export const FAMILY_LABELS: Record<LibraryFamily, string> = {
  backgrounds: 'Animated backgrounds',
  text: 'Text and numbers',
  motion: 'Scroll, cards and navigation',
  three: '3D scenes',
};

/**
 * Cost of an effect on the page:
 * - `light`: CSS or SVG only, no extra library;
 * - `medium`: motion, lenis or a small canvas;
 * - `heavy`: WebGL (ogl, three): loaded after the page, only on screens that can run it.
 */
export type LibraryWeight = 'light' | 'medium' | 'heavy';

/** Moods used to pick effects that fit a brief. */
export type LibraryMood =
  | 'playful'
  | 'premium'
  | 'tech'
  | 'calm'
  | 'bold'
  | 'retro'
  | 'organic'
  | 'dark';

export interface LibraryEntry {
  /** Stable id, kebab-case, unique across the library. */
  id: string;
  name: string;
  family: LibraryFamily;
  /** One sentence: what it looks like and where it fits on a launchpad site. */
  description: string;
  moods: readonly LibraryMood[];
  weight: LibraryWeight;
  /** Import path for site code, for example `@/components/library/backgrounds/Aurora`. */
  importPath: string;
  /** Exported component name. */
  exportName: string;
  /** Renders the effect in the showcase, inside a box of the given height. */
  Demo: ComponentType;
  /** Height of the showcase box, in pixels. */
  demoHeight?: number;
}
