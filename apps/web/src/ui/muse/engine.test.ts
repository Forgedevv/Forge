import { afterEach, describe, expect, it, vi } from 'vitest';
import { Muse } from './engine';
import { museColorsFor, museMoodForJob } from './context';
import { MUSE_MOODS } from './moods';
import { hexRGB, isHexColor } from './paint';

/** A small deterministic random source, so two Muses can be compared. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function run(muse: Muse, seconds: number, fps: number) {
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) muse.update(1 / fps);
}

/** A 2D context stand-in that accepts every call. */
function fakeContext() {
  const gradient = { addColorStop: vi.fn() };
  const calls: string[] = [];
  return {
    calls,
    ctx: new Proxy(
      {},
      {
        get: (_target, key: string) =>
          key === 'createRadialGradient' || key === 'createLinearGradient'
            ? () => gradient
            : (...args: unknown[]) => {
                calls.push(key);
                return args;
              },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Muse engine', () => {
  it('reaches the same pose at 30 and 120 frames per second', () => {
    const slow = new Muse({ random: seeded() }),
      fast = new Muse({ random: seeded() });
    slow.setMood('building');
    fast.setMood('building');
    run(slow, 2, 30);
    run(fast, 2, 120);
    expect(slow.cur.orbit).toBeCloseTo(fast.cur.orbit, 2);
    expect(slow.cur.glow).toBeCloseTo(fast.cur.glow, 2);
    slow.c1.forEach((value, i) => expect(Math.abs(value - fast.c1[i]!)).toBeLessThan(1));
    expect(Math.abs(slow.q)).toBeLessThan(0.36);
  });

  it('gets dizzy after five fast clicks, then returns to its mood', () => {
    const muse = new Muse({ random: seeded() });
    muse.setMood('listening');
    const results = Array.from({ length: 5 }, () => {
      muse.update(0.1);
      return muse.poke();
    });
    expect(results.slice(0, 4)).toEqual(['poke', 'poke', 'poke', 'poke']);
    expect(results[4]).toBe('dizzy');
    expect(muse.moodName).toBe('dizzy');
    run(muse, 3, 60);
    expect(muse.moodName).toBe('listening');
  });

  it('wakes up when poked while sleeping', () => {
    const muse = new Muse({ random: seeded() });
    muse.setMood('sleeping');
    expect(muse.poke()).toBe('wake');
    expect(muse.moodName).toBe('idle');
  });

  it('holds a gentle static pose under reduced motion', () => {
    const muse = new Muse({ reduced: true, random: seeded() });
    const t = muse.t;
    muse.setMood('success');
    expect(muse.eye.star).toBe(1);
    muse.poke();
    run(muse, 2, 60);
    expect(muse.t).toBe(t);
    expect(muse.particles).toHaveLength(0);
    expect(muse.p.hop).toBe(0);
  });

  it('takes custom colors and keeps glowing eyes on dark bodies only', () => {
    expect(new Muse({ primary: '#0E9F76', accent: '#B8F5A0' }).base1).toEqual([14, 159, 118]);
    expect(new Muse({ primary: '#3A6BFF' }).eyeLight).toBe(true);
    expect(new Muse({ primary: '#F4F2FB' }).eyeLight).toBe(false);
    expect(new Muse({ primary: 'not a color' }).base1).toEqual([155, 92, 255]);
  });

  it('renders every mood at avatar and stage sizes', () => {
    vi.stubGlobal(
      'Path2D',
      class {
        arc() {}
      },
    );
    for (const mood of MUSE_MOODS)
      for (const mini of [true, false]) {
        const muse = new Muse({ mini, random: seeded() });
        muse.setMood(mood);
        run(muse, 0.5, 60);
        const { ctx, calls } = fakeContext();
        muse.render(ctx, mini ? 70 : 240, { rf: mini ? 0.2 : 0.25 });
        expect(calls).toContain('ellipse');
        expect(Number.isFinite(muse.lastCx) && Number.isFinite(muse.lastCy)).toBe(true);
      }
  });
});

describe('Muse context helpers', () => {
  it('maps job steps to moods', () => {
    expect(museMoodForJob('building')).toBe('building');
    expect(museMoodForJob('deploying')).toBe('building');
    expect(museMoodForJob('preview_ready')).toBe('waiting_approval');
    expect(museMoodForJob('awaiting_owner_signature')).toBe('waiting_approval');
    expect(museMoodForJob('live')).toBe('success');
    expect(museMoodForJob('failed')).toBe('error');
    expect(museMoodForJob('spec_ready')).toBe('idle');
  });

  it('reads launchpad theme colors and ignores invalid ones', () => {
    expect(museColorsFor({ theme: { primaryColor: '#827bdf', accentColor: 'magenta' } })).toEqual({
      primary: '#827bdf',
      accent: null,
    });
    expect(museColorsFor(null)).toEqual({ primary: null, accent: null });
    expect(isHexColor('#abc')).toBe(true);
    expect(hexRGB('#abc')).toEqual([170, 187, 204]);
  });
});
