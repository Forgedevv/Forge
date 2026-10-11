/** Measured interaction cadence, expressed separately from the visual treatment. */
export const CAPTION_REVEAL_MS = 1000;
export const CAPTION_HOLD_MS = 3500;
export const CAPTION_FADE_MS = 500;
export const CAPTION_TICK_MS = 40;
export const MANIFESTO_LINE_SECONDS = 0.2;
export const MANIFESTO_GROUP_SECONDS = 0.4;

const GLYPHS = 'FORGE CREATE YOUR WORLD';

/** A short moving noise frontier follows the readable part of the caption. */
export function captionAt(text: string, elapsed: number) {
  const time = Math.max(0, elapsed);
  const characters = Array.from(text);
  const count = Math.min(characters.length, Math.floor(characters.length * time / CAPTION_REVEAL_MS));
  const noise = Array.from({ length: Math.min(3, characters.length - count) }, (_, index) =>
    GLYPHS[(Math.floor(time / CAPTION_TICK_MS) * 7 + index * 5) % GLYPHS.length],
  ).join('');
  return {
    text: characters.slice(0, count).join('') + noise,
    visible: elapsed < CAPTION_REVEAL_MS + CAPTION_HOLD_MS,
    complete: elapsed >= CAPTION_REVEAL_MS + CAPTION_HOLD_MS + CAPTION_FADE_MS,
  };
}

export function manifestoDelays(groups: readonly (readonly string[])[]) {
  let start = 0.1;
  return groups.map((group) => {
    const delays = group.map((_, index) => start + index * MANIFESTO_LINE_SECONDS);
    start += group.length * MANIFESTO_LINE_SECONDS + MANIFESTO_GROUP_SECONDS;
    return delays;
  });
}
