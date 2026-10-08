import { describe, expect, it } from 'vitest';
import {
  boostAt,
  boostCameraAt,
  CHAPTER_COUNT,
  ChapterMotion,
  FOLLOW_TIME_CONSTANT,
  jumpAt,
  sigmoid,
  WHEEL_SENSITIVITY,
  wheelPixels,
} from './motion';

const LAST = CHAPTER_COUNT - 1;
const SCREEN = 800;

function advance(motion: ChapterMotion, seconds: number, hz = 60) {
  for (let frame = 0; frame < Math.round(seconds * hz); frame++) motion.tick(1 / hz);
}

/** Drags in even steps over `seconds`, sampling the pointer at 60 Hz from `start` (ms). */
function swipe(motion: ChapterMotion, pixels: number, seconds: number, start = 0) {
  const steps = Math.max(1, Math.round(seconds * 60));
  motion.grab(start);
  for (let i = 1; i <= steps; i++) {
    motion.drag(pixels / steps, SCREEN, start + (i * 1000) / 60);
    motion.tick(1 / 60);
  }
  return start + (steps * 1000) / 60;
}

describe('continuous scroll progress', () => {
  it('keeps the initial chapter stationary without input', () => {
    const motion = new ChapterMotion();
    advance(motion, 20);
    expect(motion.value).toBe(0);
    expect(motion.moving).toBe(false);
  });

  it('maps a mouse notch to a fraction of a chapter and normalizes line and page deltas', () => {
    expect(100 * WHEEL_SENSITIVITY).toBeGreaterThanOrEqual(0.12);
    expect(100 * WHEEL_SENSITIVITY).toBeLessThanOrEqual(0.18);
    expect(wheelPixels(3, 1, SCREEN)).toBe(48);
    expect(wheelPixels(1, 2, SCREEN)).toBe(SCREEN);
    expect(wheelPixels(-40, 0, SCREEN)).toBe(-40);
    const motion = new ChapterMotion();
    motion.wheel(100);
    advance(motion, 2);
    expect(motion.value).toBeCloseTo(100 * WHEEL_SENSITIVITY, 6);
    expect(motion.chapter).toBe(0);
  });

  it('accumulates many small wheel events progressively without gestures or cooldowns', () => {
    const motion = new ChapterMotion();
    let previous = motion.value;
    // A trackpad swipe: 40 events of 16 px, one per frame.
    for (let i = 0; i < 40; i++) {
      motion.wheel(16);
      motion.tick(1 / 60);
      expect(motion.value).toBeGreaterThan(previous);
      previous = motion.value;
    }
    advance(motion, 2);
    expect(motion.value).toBeCloseTo(40 * 16 * WHEEL_SENSITIVITY, 6);
    expect(motion.value).toBeGreaterThan(0.8);
    expect(motion.value).toBeLessThan(1.2);
  });

  it('follows the target smoothly and rests between chapters without snapping', () => {
    const motion = new ChapterMotion();
    motion.wheel(300);
    motion.tick(FOLLOW_TIME_CONSTANT / 2);
    motion.tick(FOLLOW_TIME_CONSTANT / 2);
    expect(motion.value).toBeCloseTo(300 * WHEEL_SENSITIVITY * (1 - Math.exp(-1)), 6);
    advance(motion, 10);
    expect(motion.value).toBeCloseTo(300 * WHEEL_SENSITIVITY, 6);
    expect(motion.chapter).toBe(0);
    expect(motion.moving).toBe(false);
  });

  it('never ignores wheel input during a navigation transition', () => {
    const motion = new ChapterMotion();
    motion.to(3);
    advance(motion, 1);
    const during = motion.value;
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(3);
    motion.wheel(-200);
    advance(motion, 3);
    expect(motion.value).toBeCloseTo(during - 200 * WHEEL_SENSITIVITY, 6);
  });

  it('accepts every event of a continuous stream, including immediate reversals', () => {
    const motion = new ChapterMotion();
    motion.wheel(400);
    advance(motion, 0.05);
    motion.wheel(-400);
    advance(motion, 3);
    expect(motion.value).toBeCloseTo(0, 6);
    for (let i = 0; i < 10; i++) {
      motion.wheel(100);
      advance(motion, 0.03);
    }
    advance(motion, 3);
    expect(motion.value).toBeCloseTo(1000 * WHEEL_SENSITIVITY, 6);
  });

  it('produces the same smoothing at 60 Hz and 144 Hz', () => {
    const standard = new ChapterMotion(),
      fast = new ChapterMotion();
    standard.wheel(300);
    fast.wheel(300);
    advance(standard, 0.25, 60);
    advance(fast, 0.25, 144);
    expect(standard.value).toBeCloseTo(fast.value, 4);
  });

  it.each([120, 144])('updates every moving frame on a %i Hz display', (hz) => {
    const motion = new ChapterMotion();
    motion.to(2, 0);
    motion.wheel(400);
    for (let i = 0; i < 20; i++) {
      const before = motion.value;
      motion.tick(1 / hz);
      expect(motion.value).toBeGreaterThan(before);
    }
  });

  it('stays within bounds and leaves the ends without a dead zone under extreme input', () => {
    const motion = new ChapterMotion();
    for (let i = 0; i < 500; i++) {
      motion.wheel(-1e8);
      motion.tick(1 / 60);
      expect(motion.value).toBeGreaterThanOrEqual(0);
    }
    expect(motion.value).toBe(0);
    for (let i = 0; i < 500; i++) {
      motion.wheel(1e8);
      motion.tick(1 / 60);
      expect(motion.value).toBeLessThanOrEqual(LAST);
    }
    expect(motion.value).toBe(LAST);
    motion.wheel(-100);
    advance(motion, 0.1);
    expect(motion.value).toBeLessThan(LAST);
    motion.wheel(Number.NaN);
    advance(motion, 2);
    expect(Number.isFinite(motion.value)).toBe(true);
  });
});

describe('touch', () => {
  it('maps one full-screen swipe to about one chapter', () => {
    const motion = new ChapterMotion();
    const end = swipe(motion, -SCREEN, 1);
    motion.release(end + 500);
    advance(motion, 3);
    expect(motion.value).toBeCloseTo(1, 4);
  });

  it('does not snap to a chapter after release', () => {
    const motion = new ChapterMotion();
    const end = swipe(motion, -SCREEN * 0.3, 1);
    motion.release(end + 500);
    advance(motion, 5);
    expect(motion.value).toBeCloseTo(0.3, 4);
    expect(motion.moving).toBe(false);
  });

  it('coasts with decaying inertia after a flick, then rests off-chapter', () => {
    const motion = new ChapterMotion();
    const end = swipe(motion, -SCREEN * 0.4, 0.2);
    const atRelease = motion.value;
    motion.release(end);
    const samples: number[] = [];
    for (let i = 0; i < 180; i++) samples.push(motion.tick(1 / 60));
    for (let i = 1; i < samples.length; i++)
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    const rest = samples.at(-1)!;
    expect(rest).toBeGreaterThan(atRelease);
    expect(rest).toBeGreaterThan(0.6);
    expect(Number.isInteger(rest)).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('discards in-flight wheel motion when a finger takes over', () => {
    const motion = new ChapterMotion();
    motion.wheel(500);
    advance(motion, 0.1);
    const caught = motion.value;
    motion.grab(0);
    advance(motion, 1);
    expect(motion.value).toBeCloseTo(caught, 6);
    motion.release();
    advance(motion, 1);
    expect(motion.value).toBeCloseTo(caught, 6);
  });

  it('keeps a coasting flick inside the last chapter', () => {
    const motion = new ChapterMotion();
    motion.to(4, 0);
    const end = swipe(motion, -SCREEN, 0.1);
    motion.release(end);
    for (let i = 0; i < 240; i++) {
      motion.tick(1 / 60);
      expect(motion.value).toBeLessThanOrEqual(LAST);
    }
    expect(motion.value).toBeCloseTo(LAST, 3);
  });
});

describe('explicit navigation', () => {
  it('tweens exactly to a chapter and back', () => {
    const motion = new ChapterMotion();
    motion.to(5);
    advance(motion, 1);
    expect(motion.value).toBeCloseTo(2.5, 5);
    advance(motion, 1.1);
    expect(motion.value).toBe(5);
    motion.to(2);
    advance(motion, 2.1);
    expect(motion.value).toBe(2);
    expect(motion.moving).toBe(false);
  });

  it('chains repeated key presses from the destination', () => {
    const motion = new ChapterMotion();
    motion.to(1);
    advance(motion, 0.2);
    motion.to(motion.destination + 1);
    advance(motion, 2.1);
    expect(motion.value).toBe(2);
  });

  it('reaches an exact chapter after free scrolling left the value between chapters', () => {
    const motion = new ChapterMotion();
    motion.wheel(250);
    advance(motion, 0.1);
    motion.to(3);
    advance(motion, 2.1);
    expect(motion.value).toBe(3);
  });

  it('can be interrupted by touch at any moment', () => {
    const motion = new ChapterMotion();
    motion.to(4);
    advance(motion, 0.7);
    const caught = motion.value;
    motion.grab(0);
    advance(motion, 2);
    expect(motion.value).toBeCloseTo(caught, 6);
    motion.release();
  });

  it('clamps targets and jumps instantly for reduced motion', () => {
    const motion = new ChapterMotion();
    motion.to(99, 0);
    expect(motion.value).toBe(LAST);
    motion.to(-4, 0);
    expect(motion.value).toBe(0);
    motion.to(3, 0);
    expect(motion.value).toBe(3);
    expect(motion.moving).toBe(false);
  });

  it('shows a reduced-motion drag at once when settled', () => {
    const motion = new ChapterMotion();
    motion.grab(0);
    motion.drag(-SCREEN / 2, SCREEN, 16);
    motion.settle();
    expect(motion.value).toBeCloseTo(0.5, 6);
    motion.release();
  });
});

describe('reference event timing', () => {
  it('reaches the camera boost and shake on their independent schedules', () => {
    expect(boostCameraAt(1).fov).toBe(15);
    expect(boostCameraAt(0.8).shake).toBe(0.15);
    expect(boostCameraAt(4).shake).toBe(0);
    expect(boostCameraAt(6).fov).toBe(0);
    expect(sigmoid(0)).toBeCloseTo(0);
    expect(sigmoid(0.5)).toBeCloseTo(0.5);
    expect(sigmoid(1)).toBeCloseTo(1);
  });
  it('accelerates for two seconds and recovers over four seconds', () => {
    expect(boostAt(0)).toBe(0);
    expect(boostAt(2)).toBe(1);
    expect(boostAt(4)).toBeCloseTo(0.5);
    expect(boostAt(6)).toBe(0);
    expect(boostAt(20)).toBe(0);
  });

  it('switches the word at 0.7 seconds into the 3.5-second jump cycle', () => {
    expect(jumpAt(0.69).word).toBe(0);
    expect(jumpAt(0.71).word).toBe(1);
    expect(jumpAt(0.7).impact).toBeCloseTo(1);
    expect(jumpAt(1.01).impact).toBe(0);
    expect(jumpAt(3.5).height).toBeCloseTo(jumpAt(0).height);
  });
});
