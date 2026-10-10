import { describe, expect, it } from 'vitest';
import { captionAt, CAPTION_REVEAL_MS, CAPTION_HOLD_MS, CAPTION_FADE_MS, manifestoDelays } from './choreography';

describe('chapter captions', () => {
  it('keeps at most three noise glyphs ahead of the readable text', () => {
    const text = 'Build your world.';
    expect(captionAt(text, 0).text).toHaveLength(3);
    const halfway = captionAt(text, CAPTION_REVEAL_MS / 2).text;
    const prefix = text.slice(0, Math.floor(text.length / 2));
    expect(halfway.startsWith(prefix)).toBe(true);
    expect(halfway.length).toBe(prefix.length + 3);
    expect(captionAt(text, CAPTION_REVEAL_MS).text).toBe(text);
  });

  it('holds the readable caption before fading it and ending its timer', () => {
    const end = CAPTION_REVEAL_MS + CAPTION_HOLD_MS;
    expect(captionAt('FORGE', end - 1).visible).toBe(true);
    expect(captionAt('FORGE', end).visible).toBe(false);
    expect(captionAt('FORGE', end).complete).toBe(false);
    expect(captionAt('FORGE', end + CAPTION_FADE_MS).complete).toBe(true);
  });

  it('reveals complete Unicode characters and handles empty captions', () => {
    expect(captionAt('🌍 FORGE', CAPTION_REVEAL_MS).text).toBe('🌍 FORGE');
    expect(captionAt('', 0).text).toBe('');
    expect(captionAt('FORGE', -100).text).toHaveLength(3);
  });
});

describe('manifesto choreography', () => {
  it('stages lines within each group and leaves a gap before the next group', () => {
    const delays = manifestoDelays([['First', 'Second'], ['Third'], ['Fourth', 'Fifth']]);
    expect(delays[0]).toEqual([.1, .1 + .2]);
    expect(delays[1]![0]! - delays[0]![1]!).toBeCloseTo(.6);
    expect(delays[2]![1]! - delays[2]![0]!).toBeCloseTo(.2);
  });
});
