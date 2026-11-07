import type { ComponentType } from 'react';
import type { LibraryMood, LibraryWeight } from '@/components/library/types';
import { CoinRainBanner } from './coin/CoinRainBanner';
import { CoinSpotlight } from './coin/CoinSpotlight';
import { CoinTicker } from './coin/CoinTicker';
import { CoinTorus } from './coin/CoinTorus';
import { ClosingFilaments } from './closing/ClosingFilaments';
import { ClosingGrid } from './closing/ClosingGrid';
import { ClosingMagnetic } from './closing/ClosingMagnetic';
import { ClosingMarquee } from './closing/ClosingMarquee';
import { FaqAccordion } from './faq/FaqAccordion';
import { FaqCards } from './faq/FaqCards';
import { FaqSplit } from './faq/FaqSplit';
import { FooterColumns } from './footer/FooterColumns';
import { FooterMarquee } from './footer/FooterMarquee';
import { FooterMinimal } from './footer/FooterMinimal';
import { FooterWordmark } from './footer/FooterWordmark';
import { HeroDotField } from './hero/HeroDotField';
import { HeroHalo } from './hero/HeroHalo';
import { HeroParticleField } from './hero/HeroParticleField';
import { HeroPosterType } from './hero/HeroPosterType';
import { HeroRetroGrid } from './hero/HeroRetroGrid';
import { HeroSculpture } from './hero/HeroSculpture';
import { HeroSplitCoin } from './hero/HeroSplitCoin';
import { HeroTerminal } from './hero/HeroTerminal';
import { StepsRings } from './steps/StepsRings';
import { StepsScrollStory } from './steps/StepsScrollStory';
import { StepsStack } from './steps/StepsStack';
import { StepsTimeline } from './steps/StepsTimeline';
import { ValuesEditorial } from './values/ValuesEditorial';
import { ValuesMarquee } from './values/ValuesMarquee';
import { ValuesSpotlight } from './values/ValuesSpotlight';
import { ValuesTilt } from './values/ValuesTilt';

/**
 * Catalogue of the section variants (FREE ZONE). A site picks one variant per slot of its home
 * page and footer; every variant reads its copy from `content` and follows the theme. The builder
 * agent reads the same catalogue as text in `CATALOGUE.md` (kept in sync by a test).
 */

/** Slots of the home page and footer, in page order. */
export const SECTION_SLOTS = [
  'hero',
  'values',
  'steps',
  'coin',
  'faq',
  'closing',
  'footer',
] as const;
export type SectionSlot = (typeof SECTION_SLOTS)[number];

export const SLOT_LABELS: Record<SectionSlot, string> = {
  hero: 'Hero (top of the home page)',
  values: 'Selling points (under the hero)',
  steps: 'How it works',
  coin: 'The launchpad coin',
  faq: 'Questions',
  closing: 'Closing call to action',
  footer: 'Footer (every page)',
};

/** What the template ships in each slot, replaced by a variant. */
export const SLOT_DEFAULTS: Record<SectionSlot, string> = {
  hero: 'src/components/home/HomeHero.tsx',
  values: 'src/components/home/ValueStrip.tsx',
  steps: 'src/components/home/HowItWorks.tsx',
  coin: 'src/components/home/LaunchpadCoin.tsx',
  faq: 'src/components/home/Faq.tsx',
  closing: 'src/components/home/ClosingCta.tsx',
  footer: 'src/components/SiteFooter.tsx',
};

export interface SectionEntry {
  /** Stable id, kebab-case, unique across the catalogue. */
  id: string;
  name: string;
  slot: SectionSlot;
  /** One sentence: what it looks like and which brief it fits. */
  description: string;
  moods: readonly LibraryMood[];
  /** Cost of the heaviest effect it uses. */
  weight: LibraryWeight;
  /** Ids of the library effects it is built on. */
  effects: readonly string[];
  importPath: string;
  exportName: string;
  /** Props beyond the copy (which every variant takes from `content` by default). */
  options?: string;
  Component: ComponentType;
}

const P = '@/components/sections';

export const SECTIONS: readonly SectionEntry[] = [
  {
    id: 'hero-split-coin',
    name: 'Split with 3D coin',
    slot: 'hero',
    description:
      'Name rising letter by letter beside a spinning 3D coin stamped with the monogram, tagline coming into focus.',
    moods: ['playful', 'premium', 'bold'],
    weight: 'heavy',
    effects: ['split-reveal', 'blur-words', 'floating-coin'],
    importPath: `${P}/hero/HeroSplitCoin`,
    exportName: 'HeroSplitCoin',
    options: 'monogram',
    Component: HeroSplitCoin,
  },
  {
    id: 'hero-particle-field',
    name: 'Particle field',
    slot: 'hero',
    description:
      'Centred headline over a breathing sphere of thousands of particles; the eyebrow decodes like a signal.',
    moods: ['tech', 'premium', 'dark'],
    weight: 'heavy',
    effects: ['particle-blob', 'blur-words', 'scramble-text'],
    importPath: `${P}/hero/HeroParticleField`,
    exportName: 'HeroParticleField',
    Component: HeroParticleField,
  },
  {
    id: 'hero-poster-type',
    name: 'Poster type',
    slot: 'hero',
    description:
      'The name in giant uppercase type, one word per line rising out of its mask, with a draggable ticker band below.',
    moods: ['bold', 'playful', 'retro'],
    weight: 'medium',
    effects: ['mask-lines', 'drag-marquee'],
    importPath: `${P}/hero/HeroPosterType`,
    exportName: 'HeroPosterType',
    options: 'tickerWords',
    Component: HeroPosterType,
  },
  {
    id: 'hero-terminal',
    name: 'Terminal',
    slot: 'hero',
    description:
      'The monogram drawn in live ASCII glyphs that ripple around the pointer, lines typing themselves under the name.',
    moods: ['tech', 'retro', 'dark'],
    weight: 'medium',
    effects: ['ascii-monogram', 'typewriter-text', 'scramble-text'],
    importPath: `${P}/hero/HeroTerminal`,
    exportName: 'HeroTerminal',
    options: 'phrases, monogram',
    Component: HeroTerminal,
  },
  {
    id: 'hero-retro-grid',
    name: 'Retro horizon',
    slot: 'hero',
    description:
      'A neon floor scrolling towards a striped sun, the name flipping up letter by letter with a glow.',
    moods: ['retro', 'playful', 'bold'],
    weight: 'light',
    effects: ['perspective-grid', 'split-reveal'],
    importPath: `${P}/hero/HeroRetroGrid`,
    exportName: 'HeroRetroGrid',
    options: 'sun',
    Component: HeroRetroGrid,
  },
  {
    id: 'hero-sculpture',
    name: 'Glossy sculpture',
    slot: 'hero',
    description:
      'A glossy 3D knot, ring or gem turning in studio light beside a name uncovered like a curtain.',
    moods: ['premium', 'calm', 'organic'],
    weight: 'heavy',
    effects: ['glossy-sculpture', 'mask-lines'],
    importPath: `${P}/hero/HeroSculpture`,
    exportName: 'HeroSculpture',
    options: "shape: 'knot' | 'torus' | 'gem', reverse",
    Component: HeroSculpture,
  },
  {
    id: 'hero-dot-field',
    name: 'Dot field',
    slot: 'hero',
    description:
      'A calm field of dots lighting up around the pointer, a big name and a line rotating through the selling points.',
    moods: ['tech', 'calm', 'premium'],
    weight: 'medium',
    effects: ['dot-grid', 'rotating-words'],
    importPath: `${P}/hero/HeroDotField`,
    exportName: 'HeroDotField',
    options: 'words',
    Component: HeroDotField,
  },
  {
    id: 'hero-halo',
    name: 'Halo',
    slot: 'hero',
    description:
      'A rotating halo of the brand colours behind a centred name in the flowing brand gradient, with a magnetic button.',
    moods: ['premium', 'bold', 'dark'],
    weight: 'light',
    effects: ['conic-glow', 'shimmer-text', 'magnetic-button'],
    importPath: `${P}/hero/HeroHalo`,
    exportName: 'HeroHalo',
    Component: HeroHalo,
  },
  {
    id: 'values-spotlight',
    name: 'Spotlight bento',
    slot: 'values',
    description: 'Selling points as a bento of cards lit by a soft light following the pointer.',
    moods: ['tech', 'premium', 'dark'],
    weight: 'medium',
    effects: ['spotlight-grid'],
    importPath: `${P}/values/ValuesSpotlight`,
    exportName: 'ValuesSpotlight',
    options: 'eyebrow, title (optional heading)',
    Component: ValuesSpotlight,
  },
  {
    id: 'values-tilt',
    name: 'Tilt cards',
    slot: 'values',
    description: 'Cards tilting towards the pointer with a glare and a big outlined number each.',
    moods: ['playful', 'bold', 'premium'],
    weight: 'medium',
    effects: ['tilt-card', 'section-reveal'],
    importPath: `${P}/values/ValuesTilt`,
    exportName: 'ValuesTilt',
    options: 'eyebrow, title (optional heading)',
    Component: ValuesTilt,
  },
  {
    id: 'values-marquee',
    name: 'Ticker bands',
    slot: 'values',
    description:
      'Two giant draggable ticker bands of the selling points drifting in opposite directions, details below.',
    moods: ['bold', 'playful', 'retro'],
    weight: 'medium',
    effects: ['drag-marquee', 'section-reveal'],
    importPath: `${P}/values/ValuesMarquee`,
    exportName: 'ValuesMarquee',
    Component: ValuesMarquee,
  },
  {
    id: 'values-editorial',
    name: 'Editorial list',
    slot: 'values',
    description:
      'Thin rules, big numbers and a highlighter stroke drawn behind each title as it enters.',
    moods: ['calm', 'premium', 'organic'],
    weight: 'light',
    effects: ['marker-highlight', 'section-reveal'],
    importPath: `${P}/values/ValuesEditorial`,
    exportName: 'ValuesEditorial',
    options: 'eyebrow, title (optional heading)',
    Component: ValuesEditorial,
  },
  {
    id: 'steps-stack',
    name: 'Stacking cards',
    slot: 'steps',
    description: 'Steps as cards that pin and stack on top of each other while the page scrolls.',
    moods: ['bold', 'premium', 'tech', 'playful'],
    weight: 'medium',
    effects: ['stack-cards'],
    importPath: `${P}/steps/StepsStack`,
    exportName: 'StepsStack',
    Component: StepsStack,
  },
  {
    id: 'steps-timeline',
    name: 'Timeline',
    slot: 'steps',
    description:
      'A vertical gradient line with glowing nodes beside a sticky heading, steps rising in turn.',
    moods: ['calm', 'premium', 'tech'],
    weight: 'medium',
    effects: ['section-reveal'],
    importPath: `${P}/steps/StepsTimeline`,
    exportName: 'StepsTimeline',
    Component: StepsTimeline,
  },
  {
    id: 'steps-rings',
    name: 'Progress rings',
    slot: 'steps',
    description:
      'Rings filling one more third each step, like a bonding curve reaching graduation.',
    moods: ['tech', 'playful'],
    weight: 'medium',
    effects: ['progress-ring', 'section-reveal'],
    importPath: `${P}/steps/StepsRings`,
    exportName: 'StepsRings',
    Component: StepsRings,
  },
  {
    id: 'steps-scroll-story',
    name: 'Scroll story',
    slot: 'steps',
    description:
      'Each step as a large sentence whose words light up one by one as the reader scrolls.',
    moods: ['calm', 'premium', 'organic'],
    weight: 'medium',
    effects: ['scroll-words'],
    importPath: `${P}/steps/StepsScrollStory`,
    exportName: 'StepsScrollStory',
    Component: StepsScrollStory,
  },
  {
    id: 'coin-spotlight',
    name: 'Coin on stage',
    slot: 'coin',
    description:
      'The launchpad coin as a spinning 3D coin in a pool of light, its ticker in the flowing brand gradient.',
    moods: ['playful', 'premium', 'bold'],
    weight: 'heavy',
    effects: ['floating-coin', 'shimmer-text'],
    importPath: `${P}/coin/CoinSpotlight`,
    exportName: 'CoinSpotlight',
    Component: CoinSpotlight,
  },
  {
    id: 'coin-rain-banner',
    name: 'Coin rain',
    slot: 'coin',
    description: '3D coins stamped with the ticker tumbling behind a centred celebration banner.',
    moods: ['playful', 'bold'],
    weight: 'heavy',
    effects: ['coin-rain'],
    importPath: `${P}/coin/CoinRainBanner`,
    exportName: 'CoinRainBanner',
    Component: CoinRainBanner,
  },
  {
    id: 'coin-torus',
    name: 'Woven ring',
    slot: 'coin',
    description:
      'The coin beside a ring woven from glowing threads that turns and tilts towards the pointer.',
    moods: ['tech', 'premium', 'dark'],
    weight: 'medium',
    effects: ['woven-torus'],
    importPath: `${P}/coin/CoinTorus`,
    exportName: 'CoinTorus',
    Component: CoinTorus,
  },
  {
    id: 'coin-ticker',
    name: 'Giant ticker',
    slot: 'coin',
    description:
      'The ticker in giant outlined letters dropping in one by one, name and description beneath.',
    moods: ['bold', 'retro'],
    weight: 'light',
    effects: ['split-reveal'],
    importPath: `${P}/coin/CoinTicker`,
    exportName: 'CoinTicker',
    Component: CoinTicker,
  },
  {
    id: 'faq-accordion',
    name: 'Accordion',
    slot: 'faq',
    description: 'Questions in a centred column, answers gliding open.',
    moods: ['calm', 'premium', 'tech', 'playful'],
    weight: 'medium',
    effects: ['smooth-accordion'],
    importPath: `${P}/faq/FaqAccordion`,
    exportName: 'FaqAccordion',
    Component: FaqAccordion,
  },
  {
    id: 'faq-split',
    name: 'Sticky split',
    slot: 'faq',
    description: 'A sticky heading on the left, answers opening on the right, the first one open.',
    moods: ['premium', 'tech', 'calm'],
    weight: 'medium',
    effects: ['smooth-accordion'],
    importPath: `${P}/faq/FaqSplit`,
    exportName: 'FaqSplit',
    options: 'intro',
    Component: FaqSplit,
  },
  {
    id: 'faq-cards',
    name: 'Question cards',
    slot: 'faq',
    description: 'All answers visible in a grid of cards marked with a big brand-coloured "?".',
    moods: ['playful', 'bold'],
    weight: 'medium',
    effects: ['section-reveal'],
    importPath: `${P}/faq/FaqCards`,
    exportName: 'FaqCards',
    Component: FaqCards,
  },
  {
    id: 'closing-grid',
    name: 'Neon floor',
    slot: 'closing',
    description:
      'The closing call to action in a card over a neon floor scrolling towards the viewer.',
    moods: ['retro', 'tech'],
    weight: 'light',
    effects: ['perspective-grid'],
    importPath: `${P}/closing/ClosingGrid`,
    exportName: 'ClosingGrid',
    Component: ClosingGrid,
  },
  {
    id: 'closing-filaments',
    name: 'Filaments',
    slot: 'closing',
    description:
      'Glowing filaments rising and parting around the pointer behind a title rising word by word.',
    moods: ['premium', 'organic', 'dark'],
    weight: 'medium',
    effects: ['filament-strands', 'split-reveal'],
    importPath: `${P}/closing/ClosingFilaments`,
    exportName: 'ClosingFilaments',
    Component: ClosingFilaments,
  },
  {
    id: 'closing-magnetic',
    name: 'Magnetic statement',
    slot: 'closing',
    description:
      'A big statement rising line by line beside a magnetic button glowing in a soft halo.',
    moods: ['bold', 'premium'],
    weight: 'light',
    effects: ['mask-lines', 'magnetic-button', 'conic-glow'],
    importPath: `${P}/closing/ClosingMagnetic`,
    exportName: 'ClosingMagnetic',
    Component: ClosingMagnetic,
  },
  {
    id: 'closing-marquee',
    name: 'Giant ticker',
    slot: 'closing',
    description:
      'The primary action repeating in huge type across a draggable band, title beneath.',
    moods: ['bold', 'playful', 'retro'],
    weight: 'medium',
    effects: ['drag-marquee'],
    importPath: `${P}/closing/ClosingMarquee`,
    exportName: 'ClosingMarquee',
    Component: ClosingMarquee,
  },
  {
    id: 'footer-wordmark',
    name: 'Giant wordmark',
    slot: 'footer',
    description: 'The site name in giant type across the full width, uncovered like a curtain.',
    moods: ['bold', 'premium'],
    weight: 'light',
    effects: ['mask-lines'],
    importPath: `${P}/footer/FooterWordmark`,
    exportName: 'FooterWordmark',
    options: 'links',
    Component: FooterWordmark,
  },
  {
    id: 'footer-columns',
    name: 'Three columns',
    slot: 'footer',
    description: 'Logo and tagline, the links stacked, the legal note: a quiet classic ending.',
    moods: ['calm', 'tech', 'premium'],
    weight: 'light',
    effects: [],
    importPath: `${P}/footer/FooterColumns`,
    exportName: 'FooterColumns',
    options: 'links',
    Component: FooterColumns,
  },
  {
    id: 'footer-marquee',
    name: 'Name ticker',
    slot: 'footer',
    description: 'A slow ticker of the site name in outlined giant type above the links.',
    moods: ['playful', 'retro', 'bold'],
    weight: 'medium',
    effects: ['drag-marquee'],
    importPath: `${P}/footer/FooterMarquee`,
    exportName: 'FooterMarquee',
    options: 'links',
    Component: FooterMarquee,
  },
  {
    id: 'footer-minimal',
    name: 'Minimal line',
    slot: 'footer',
    description: 'Logo, links and the legal note on a single centred line.',
    moods: ['calm', 'premium'],
    weight: 'light',
    effects: [],
    importPath: `${P}/footer/FooterMinimal`,
    exportName: 'FooterMinimal',
    options: 'links',
    Component: FooterMinimal,
  },
];
