'use client';

import { Muse } from './muse-view';
import { MOODS, MUSE_MOODS } from './moods';

/** Launchpad themes used to preview user Muses in the development gallery. */
const SAMPLE_THEMES = [
  ['FORGE', '#9B5CFF', '#FF4FD8'],
  ['Orbit', '#827bdf', '#c3caff'],
  ['Aurora', '#3A6BFF', '#3EE6C1'],
  ['Solar', '#E2442F', '#FFB938'],
  ['Mint', '#0E9F76', '#B8F5A0'],
  ['Bloom', '#D9367E', '#FFB3E1'],
] as const;

/** Every mood at avatar and stage sizes, plus themed user Muses (development gallery only). */
export function MuseSheet() {
  return (
    <div className="muse-sheet">
      <div className="muse-sheet-row">
        {MUSE_MOODS.map((mood) => (
          <figure key={mood}>
            <Muse mood={mood} size={120} label={MOODS[mood].label} />
            <figcaption>{MOODS[mood].label}</figcaption>
          </figure>
        ))}
      </div>
      <div className="muse-sheet-row">
        {MUSE_MOODS.map((mood) => (
          <figure key={mood}>
            <Muse mood={mood} size={40} />
            <Muse mood={mood} size={24} />
          </figure>
        ))}
      </div>
      <div className="muse-sheet-row">
        {SAMPLE_THEMES.map(([name, primary, accent]) => (
          <figure key={name}>
            <Muse size={64} primary={primary} accent={accent} label={`${name} Muse`} />
            <figcaption>{name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
