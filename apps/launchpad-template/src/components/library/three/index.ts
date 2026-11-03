import type { LibraryEntry } from '../types';
import * as demos from './demos';

const PATH = '@/components/library/three';

/** Effects of the `three` family, listed in the showcase and in the catalogue the builder reads. */
export const entries: LibraryEntry[] = [
  {
    id: 'floating-coin',
    name: 'Floating coin',
    family: 'three',
    description:
      'A polished 3D metal coin with the ticker monogram embossed, spinning and floating under a soft studio light with sparkles; the signature object beside a hero headline or on a mint section.',
    moods: ['premium', 'playful', 'bold'],
    weight: 'heavy',
    importPath: `${PATH}/FloatingCoin`,
    exportName: 'FloatingCoin',
    Demo: demos.FloatingCoinDemo,
    demoHeight: 380,
  },
  {
    id: 'particle-blob',
    name: 'Particle blob',
    family: 'three',
    description:
      'Thousands of glowing particles forming a breathing, swirling blob in the theme colours that swells towards the pointer; an AI, community or countdown hero centrepiece.',
    moods: ['tech', 'organic', 'dark', 'premium'],
    weight: 'heavy',
    importPath: `${PATH}/ParticleBlob`,
    exportName: 'ParticleBlob',
    Demo: demos.ParticleBlobDemo,
    demoHeight: 380,
  },
  {
    id: 'orb-mascot',
    name: 'Orb mascot',
    family: 'three',
    description:
      'A friendly glossy orb with glowing eyes that follow the pointer and blink, bobbing with orbiting sparks; a playful hero companion or empty-state character.',
    moods: ['playful', 'bold', 'premium'],
    weight: 'heavy',
    importPath: `${PATH}/OrbMascot`,
    exportName: 'OrbMascot',
    Demo: demos.OrbMascotDemo,
    demoHeight: 380,
  },
  {
    id: 'glossy-sculpture',
    name: 'Glossy sculpture',
    family: 'three',
    description:
      'An abstract iridescent object (torus knot, ring or faceted gem) turning slowly in a soft studio light with theme-coloured reflections; a premium hero or features centrepiece.',
    moods: ['premium', 'bold', 'calm'],
    weight: 'heavy',
    importPath: `${PATH}/GlossySculpture`,
    exportName: 'GlossySculpture',
    Demo: demos.GlossySculptureDemo,
    demoHeight: 380,
  },
  {
    id: 'coin-rain',
    name: 'Coin rain',
    family: 'three',
    description:
      'Dozens of small embossed metal coins tumbling down at different depths in the theme tints; a festive launch-success moment, closing call to action or meme-coin hero.',
    moods: ['playful', 'bold'],
    weight: 'heavy',
    importPath: `${PATH}/CoinRain`,
    exportName: 'CoinRain',
    Demo: demos.CoinRainDemo,
    demoHeight: 360,
  },
];
