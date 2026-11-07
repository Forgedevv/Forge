import type { LibraryEntry } from '../types';
import * as demos from './demos';

const PATH = '@/components/library/backgrounds';

/** Effects of the `backgrounds` family, listed in the showcase and in the catalogue the builder reads. */
export const entries: LibraryEntry[] = [
  {
    id: 'dot-grid',
    name: 'Dot grid glow',
    family: 'backgrounds',
    description:
      'A quiet grid of small dots that swell and light up in the theme colours around the pointer, with a soft ripple; a hero, features grid or footer.',
    moods: ['tech', 'calm', 'premium'],
    weight: 'medium',
    importPath: `${PATH}/DotGrid`,
    exportName: 'DotGrid',
    Demo: demos.DotGridDemo,
    demoHeight: 320,
  },
  {
    id: 'ascii-monogram',
    name: 'ASCII monogram',
    family: 'backgrounds',
    description:
      'A character (the coin initial, a symbol) drawn as a flickering ASCII glyph field with a sweeping light, pulsing rings and a pointer wake; a retro-tech hero visual.',
    moods: ['retro', 'tech', 'playful', 'dark'],
    weight: 'medium',
    importPath: `${PATH}/AsciiMonogram`,
    exportName: 'AsciiMonogram',
    Demo: demos.AsciiMonogramDemo,
    demoHeight: 360,
  },
  {
    id: 'filament-strands',
    name: 'Filament strands',
    family: 'backgrounds',
    description:
      'A sheaf of fine glowing fibres rising, pinching and fanning out, with sparks travelling along them and parting around the pointer; a hero visual or a horizontal divider.',
    moods: ['organic', 'premium', 'tech', 'calm'],
    weight: 'medium',
    importPath: `${PATH}/FilamentStrands`,
    exportName: 'FilamentStrands',
    Demo: demos.FilamentStrandsDemo,
    demoHeight: 380,
  },
  {
    id: 'woven-torus',
    name: 'Woven torus',
    family: 'backgrounds',
    description:
      'A ring woven from dozens of fine threads turning slowly in perspective, front threads glowing and the weave flowing; a hypnotic hero visual beside the headline.',
    moods: ['premium', 'tech', 'calm', 'dark'],
    weight: 'medium',
    importPath: `${PATH}/WovenTorus`,
    exportName: 'WovenTorus',
    Demo: demos.WovenTorusDemo,
    demoHeight: 360,
  },
  {
    id: 'perspective-grid',
    name: 'Perspective grid',
    family: 'backgrounds',
    description:
      'A glowing grid floor gliding towards a bright horizon, with an optional striped retro sun, in pure CSS; a retro, arcade or tech hero and footer band.',
    moods: ['retro', 'tech', 'bold', 'playful'],
    weight: 'light',
    importPath: `${PATH}/PerspectiveGrid`,
    exportName: 'PerspectiveGrid',
    Demo: demos.PerspectiveGridDemo,
    demoHeight: 360,
  },
  {
    id: 'conic-glow',
    name: 'Conic glow',
    family: 'backgrounds',
    description:
      'A soft halo of the theme colours turning slowly around a calm centre, with a thin spinning ring, in pure CSS; frames a headline, countdown or mint button.',
    moods: ['premium', 'bold', 'calm'],
    weight: 'light',
    importPath: `${PATH}/ConicGlow`,
    exportName: 'ConicGlow',
    Demo: demos.ConicGlowDemo,
    demoHeight: 340,
  },
];
