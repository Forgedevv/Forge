/// <reference types="node" />
import { readFileSync } from 'node:fs';

/**
 * Starting combination of section variants for a new launchpad. The launchpad template ships a
 * catalogue of ready-made sections (`src/components/sections/` in the template); left to itself,
 * the agent tends to pick the same few for every brief. The builder suggests one variant per slot
 * instead: among the variants whose moods match the words of the brief, rotated by the launchpad
 * slug, so two launchpads with the same mood still start from different layouts.
 *
 * `sections.json` is a copy of the template's `src/components/sections/catalogue.json` (ids, slots,
 * moods and weights only), kept in sync by a test.
 */

export type Weight = 'light' | 'medium' | 'heavy';

export interface SectionVariant {
  id: string;
  slot: string;
  moods: readonly string[];
  weight: Weight;
}

export interface SectionCatalogue {
  slots: readonly string[];
  sections: readonly SectionVariant[];
}

let cachedCatalogue: SectionCatalogue | undefined;

/** Contents of `sections.json`, read once. */
export function sectionCatalogue(): SectionCatalogue {
  cachedCatalogue ??= JSON.parse(
    readFileSync(new URL('./sections.json', import.meta.url), 'utf8'),
  ) as SectionCatalogue;
  return cachedCatalogue;
}

/** Words of a brief that suggest each mood of the catalogue. */
export const MOOD_WORDS: Readonly<Record<string, readonly string[]>> = {
  playful: [
    'meme',
    'memes',
    'fun',
    'funny',
    'cute',
    'cat',
    'cats',
    'dog',
    'dogs',
    'frog',
    'kawaii',
    'cartoon',
    'playful',
    'silly',
    'degen',
    'joke',
    'lol',
    'animal',
    'animals',
    'mascot',
  ],
  premium: [
    'luxury',
    'premium',
    'elegant',
    'gold',
    'golden',
    'refined',
    'exclusive',
    'classy',
    'high-end',
    'curated',
    'prestige',
    'sophisticated',
    'serious',
    'institutional',
    'finance',
  ],
  tech: [
    'tech',
    'technical',
    'ai',
    'agent',
    'agents',
    'dev',
    'developer',
    'developers',
    'infra',
    'infrastructure',
    'protocol',
    'data',
    'code',
    'builder',
    'builders',
    'robot',
    'robots',
    'cyber',
    'machine',
    'compute',
    'defi',
  ],
  calm: [
    'calm',
    'zen',
    'slow',
    'soft',
    'peaceful',
    'quiet',
    'wellness',
    'chill',
    'minimal',
    'minimalist',
  ],
  bold: [
    'bold',
    'loud',
    'strong',
    'aggressive',
    'hype',
    'power',
    'powerful',
    'energy',
    'brutal',
    'brutalist',
    'massive',
    'confident',
  ],
  retro: [
    'retro',
    'pixel',
    'pixels',
    'arcade',
    '80s',
    '90s',
    'vintage',
    'synthwave',
    'vaporwave',
    '8-bit',
    'game',
    'games',
    'gaming',
    'neon',
    'nostalgia',
    'nostalgic',
  ],
  organic: [
    'organic',
    'nature',
    'natural',
    'forest',
    'ocean',
    'sea',
    'earth',
    'green',
    'plant',
    'plants',
    'garden',
    'flow',
    'flowing',
    'water',
  ],
  dark: [
    'dark',
    'night',
    'space',
    'cosmic',
    'cosmos',
    'galaxy',
    'mystery',
    'mysterious',
    'shadow',
    'noir',
    'moon',
    'stars',
    'void',
  ],
};

/** Words that turn the next mood words around: "nothing loud", "no neon", "not too playful". */
const NEGATIONS = new Set(['no', 'not', 'nothing', 'without', 'never', 'avoid', 'none', 'nor']);

/** How many words after a negation it still applies to ("nothing too loud"). */
const NEGATION_REACH = 3;

/**
 * Moods read in a brief, most mentioned first (ties in catalogue order). A mood word shortly after
 * a negation is not counted: "nothing loud" is not a bold brief.
 */
export function briefMoods(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const counts = new Map<string, number>();
  let negatedUntil = -1;
  for (const [index, word] of words.entries()) {
    if (NEGATIONS.has(word)) {
      negatedUntil = index + NEGATION_REACH;
      continue;
    }
    if (index <= negatedUntil) continue;
    for (const [mood, list] of Object.entries(MOOD_WORDS)) {
      if (list.includes(word)) counts.set(mood, (counts.get(mood) ?? 0) + 1);
    }
  }
  const order = Object.keys(MOOD_WORDS);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([mood]) => mood);
}

/**
 * FNV-1a over the text, then the MurmurHash3 finaliser: similar slugs (`coin-1`, `coin-2`) must land
 * on unrelated variants, and FNV alone leaves the low bits correlated.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Most heavy effects (WebGL or 3D) suggested on one page. */
export const MAX_HEAVY_SECTIONS = 2;

export interface DesignDirection {
  /** Moods read in the brief, at most three. */
  moods: string[];
  /** Suggested variant id per slot, in page order. */
  picks: { slot: string; id: string }[];
}

/**
 * One variant per slot. Candidates are the variants sharing a mood with the brief (all of the slot
 * when none does, or when the brief names no mood); the slug picks among them; heavy variants stop
 * being candidates once `MAX_HEAVY_SECTIONS` are picked.
 */
export function designDirection(
  input: { slug: string; text: string },
  catalogue: SectionCatalogue = sectionCatalogue(),
): DesignDirection {
  const moods = briefMoods(input.text).slice(0, 3);
  let heavy = 0;
  const picks: { slot: string; id: string }[] = [];
  for (const slot of catalogue.slots) {
    const inSlot = catalogue.sections.filter((s) => s.slot === slot);
    if (inSlot.length === 0) continue;
    const fitting = inSlot.filter((s) => s.moods.some((m) => moods.includes(m)));
    let candidates = fitting.length > 0 ? fitting : inSlot;
    if (heavy >= MAX_HEAVY_SECTIONS) {
      const lighter = candidates.filter((s) => s.weight !== 'heavy');
      const lighterInSlot = inSlot.filter((s) => s.weight !== 'heavy');
      candidates =
        lighter.length > 0 ? lighter : lighterInSlot.length > 0 ? lighterInSlot : candidates;
    }
    const pick = candidates[hash(`${input.slug}:${slot}`) % candidates.length]!;
    if (pick.weight === 'heavy') heavy += 1;
    picks.push({ slot, id: pick.id });
  }
  return { moods, picks };
}

/** The direction as task-prompt lines (our own ids only: nothing from the client is echoed). */
export function designDirectionText(direction: DesignDirection): string {
  const reading =
    direction.moods.length > 0
      ? `among the variants that fit the moods read in the brief (${direction.moods.join(', ')})`
      : 'the brief names no clear mood, so judge its tone yourself';
  return [
    'Starting combination from the visual library (`src/components/sections/CATALOGUE.md`), rotated',
    `per launchpad so that two sites do not share a layout, ${reading}:`,
    ...direction.picks.map((p) => `- ${p.slot}: \`${p.id}\``),
    'Use these variants. Replace one only when it contradicts the brief, and then with another',
    'variant of the same slot that fits the brief, never with the template section. Make each one',
    "this brand's own: theme, fonts, copy, order and your own art where the brief needs it.",
  ].join('\n');
}
