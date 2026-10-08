import { describe, expect, it } from 'vitest';
import {
  boostAt,
  boostCameraAt,
  CHAPTER_COUNT,
  ChapterMotion,
  DWELL,
  DWELL_SECONDS,
  jumpAt,
  MAX_QUEUE_AHEAD,
  MAX_TRANSITION_SPEED,
  NAVIGATION_DURATION,
  plateau,
  sigmoid,
  TOUCH_CHAPTERS_PER_SCREEN,
  TOUCH_INERTIA_TIME_CONSTANT,
  TOUCH_MAX_VELOCITY,
  WHEEL_SENSITIVITY,
  wheelPixels,
} from './motion';

const LAST = CHAPTER_COUNT - 1;
const SCREEN = 800;
const NOTCH = 100;
const FRAME = 1 / 60;
/** Raw scroll that carries the journey from the centre of one chapter's plateau to the next chapter. */
const TO_NEXT = 1 - DWELL / 2;
const onChapter = (value: number) => Math.abs(value - Math.round(value)) < 0.01;

function advance(motion: ChapterMotion, seconds: number, hz = 60) {
  for (let frame = 0; frame < Math.round(seconds * hz); frame++) motion.tick(1 / hz);
}

/** Ticks until `done` holds, returning the elapsed seconds (Infinity when it never does). */
function until(motion: ChapterMotion, done: (value: number) => boolean, limit = 30) {
  for (let frame = 1; frame <= limit * 60; frame++) {
    motion.tick(FRAME);
    if (done(motion.value)) return frame * FRAME;
  }
  return Infinity;
}

/** Wheel pixels for `notches` mouse notches, enough to reach the next chapter when `notches` is 0. */
const notchesToNext = Math.ceil(TO_NEXT / (NOTCH * WHEEL_SENSITIVITY));
function scrollNotches(motion: ChapterMotion, notches = notchesToNext) {
  for (let i = 0; i < notches; i++) motion.wheel(NOTCH);
}

/** Drags in even steps over `seconds`, sampling the pointer at 60 Hz from `start` (ms). */
function swipe(motion: ChapterMotion, pixels: number, seconds: number, start = 0) {
  const steps = Math.max(1, Math.round(seconds * 60));
  motion.grab(start);
  for (let i = 1; i <= steps; i++) {
    motion.drag(pixels / steps, SCREEN, start + (i * 1000) / 60);
    motion.tick(FRAME);
  }
  return start + (steps * 1000) / 60;
}

describe('plateau mapping', () => {
  it('holds every chapter across its plateau and eases symmetrically between them', () => {
    for (let chapter = 0; chapter <= LAST; chapter++) {
      expect(plateau(chapter)).toBe(chapter);
      if (chapter < LAST) expect(plateau(chapter + DWELL / 2 - 1e-6)).toBe(chapter);
      if (chapter > 0) expect(plateau(chapter - DWELL / 2 + 1e-6)).toBe(chapter);
    }
    expect(plateau(0.5)).toBeCloseTo(0.5, 9);
    for (const x of [0.2, 0.3, 0.45]) expect(plateau(2 + x) + plateau(3 - x)).toBeCloseTo(5, 9);
    let previous = -1;
    for (let raw = 0; raw <= LAST; raw += 0.01) {
      expect(plateau(raw)).toBeGreaterThanOrEqual(previous);
      previous = plateau(raw);
    }
    expect(plateau(-3)).toBe(0);
    expect(plateau(LAST + 3)).toBe(LAST);
  });
});

describe('continuous scroll progress', () => {
  it('keeps the initial chapter stationary without input', () => {
    const motion = new ChapterMotion();
    advance(motion, 20);
    expect(motion.value).toBe(0);
    expect(motion.moving).toBe(false);
  });

  it('needs four to six mouse notches per chapter and normalizes line and page deltas', () => {
    expect(notchesToNext).toBeGreaterThanOrEqual(4);
    expect(notchesToNext).toBeLessThanOrEqual(6);
    expect(wheelPixels(3, 1, SCREEN)).toBe(48);
    expect(wheelPixels(1, 2, SCREEN)).toBe(SCREEN);
    expect(wheelPixels(-40, 0, SCREEN)).toBe(-40);
    const motion = new ChapterMotion();
    scrollNotches(motion);
    advance(motion, 6);
    expect(motion.value).toBe(1);
    expect(motion.moving).toBe(false);
  });

  it('leaves the scene exactly on the chapter for a small scroll inside the plateau', () => {
    const motion = new ChapterMotion();
    const notches = Math.floor(DWELL / 2 / (NOTCH * WHEEL_SENSITIVITY));
    expect(notches).toBeGreaterThanOrEqual(1);
    scrollNotches(motion, notches);
    for (let i = 0; i < 180; i++) expect(motion.tick(FRAME)).toBe(0);
    // The scroll is kept: continuing from there plays the transition.
    motion.wheel(DWELL / 2 / WHEEL_SENSITIVITY);
    advance(motion, 1);
    expect(motion.value).toBeGreaterThan(0);
  });

  it('moves a trackpad swipe progressively to the next chapter', () => {
    const motion = new ChapterMotion();
    let previous = motion.value;
    const pixels = TO_NEXT / WHEEL_SENSITIVITY + 20;
    for (let i = 0; i < 40; i++) {
      motion.wheel(pixels / 40);
      motion.tick(FRAME);
      expect(motion.value).toBeGreaterThanOrEqual(previous);
      previous = motion.value;
    }
    advance(motion, 4);
    expect(motion.value).toBe(1);
  });

  it('caps the transition speed, so one chapter takes at least 1 / MAX_TRANSITION_SPEED s', () => {
    const motion = new ChapterMotion();
    let previous = 0,
      started = -1,
      elapsed = 0;
    while (motion.value < 1 && elapsed < 10) {
      motion.wheel(1e8);
      motion.tick(FRAME);
      elapsed += FRAME;
      expect(motion.value - previous).toBeLessThanOrEqual(MAX_TRANSITION_SPEED * FRAME + 1e-9);
      if (started < 0 && motion.value > 0) started = elapsed - FRAME;
      previous = motion.value;
    }
    expect(motion.value).toBe(1);
    expect(elapsed - started).toBeGreaterThanOrEqual(1 / MAX_TRANSITION_SPEED);
  });

  it('accelerates and decelerates smoothly instead of moving linearly', () => {
    const motion = new ChapterMotion();
    scrollNotches(motion);
    const steps: number[] = [];
    let previous = 0;
    for (let i = 0; i < 300; i++) {
      motion.tick(FRAME);
      steps.push(motion.value - previous);
      previous = motion.value;
    }
    const moving = steps.filter((step) => step > 0);
    const peak = Math.max(...moving);
    expect(peak).toBeCloseTo(MAX_TRANSITION_SPEED * FRAME, 6);
    expect(moving[0]!).toBeLessThan(peak / 4);
    expect(moving.at(-1)!).toBeLessThan(peak / 4);
  });

  it('holds a reached chapter for DWELL_SECONDS and plays the input queued meanwhile', () => {
    const motion = new ChapterMotion();
    scrollNotches(motion);
    expect(until(motion, (value) => Math.abs(value - 1) < 0.01)).toBeLessThan(Infinity);
    expect(motion.holding).toBeGreaterThan(0);
    // Scroll on during the hold: it must not move the scene yet, and must not be dropped.
    scrollNotches(motion);
    const held = until(motion, (value) => Math.abs(value - 1) >= 0.01);
    expect(held).toBeGreaterThanOrEqual(DWELL_SECONDS - FRAME);
    advance(motion, 6);
    expect(motion.value).toBeCloseTo(plateau(2 * notchesToNext * NOTCH * WHEEL_SENSITIVITY), 6);
    expect(motion.value).toBeGreaterThan(1.5);
  });

  it('stops and holds on every chapter during fast continuous scrolling', () => {
    const motion = new ChapterMotion();
    const arrivals: number[] = [];
    const departures: number[] = [];
    let wasOn = true;
    for (let frame = 1; frame <= 15 * 60; frame++) {
      motion.wheel(NOTCH);
      motion.tick(FRAME);
      const on = onChapter(motion.value);
      if (on && !wasOn) arrivals.push(frame * FRAME);
      if (!on && wasOn) departures.push(frame * FRAME);
      wasOn = on;
    }
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    expect(arrivals.length).toBeLessThanOrEqual(LAST);
    for (let i = 0; i < arrivals.length; i++) {
      expect(arrivals[i]! - departures[i]!).toBeGreaterThanOrEqual(0.99 / MAX_TRANSITION_SPEED);
      if (departures[i + 1] !== undefined)
        expect(departures[i + 1]! - arrivals[i]!).toBeGreaterThanOrEqual(DWELL_SECONDS - FRAME);
    }
  });

  it('caps the queued distance at MAX_QUEUE_AHEAD chapters', () => {
    const motion = new ChapterMotion();
    for (let i = 0; i < 200; i++) motion.wheel(1e8);
    expect(motion.goal - motion.value).toBeLessThanOrEqual(MAX_QUEUE_AHEAD + 1e-9);
    expect(motion.goal - motion.value).toBeGreaterThan(MAX_QUEUE_AHEAD - 0.01);
    for (let i = 0; i < 600; i++) {
      motion.tick(FRAME);
      expect(motion.goal - motion.value).toBeLessThanOrEqual(MAX_QUEUE_AHEAD + 1e-9);
    }
    expect(motion.value).toBeCloseTo(MAX_QUEUE_AHEAD, 3);
  });

  it('never ignores wheel input during a navigation transition', () => {
    const motion = new ChapterMotion();
    motion.to(3);
    advance(motion, 1);
    const during = motion.value;
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(3);
    motion.wheel(-NOTCH * notchesToNext);
    advance(motion, 6);
    expect(motion.value).toBeLessThan(during);
  });

  it('reverses naturally, retracing the same curve', () => {
    const motion = new ChapterMotion();
    motion.wheel(0.5 / WHEEL_SENSITIVITY);
    advance(motion, 3);
    expect(motion.value).toBeCloseTo(0.5, 6);
    motion.wheel(-0.5 / WHEEL_SENSITIVITY);
    advance(motion, 3);
    expect(motion.value).toBe(0);
    // A reversal mid-transition turns around without a hold and returns to the chapter.
    scrollNotches(motion);
    advance(motion, 0.6);
    const turned = motion.value;
    expect(turned).toBeGreaterThan(0);
    for (let i = 0; i < notchesToNext + 2; i++) motion.wheel(-NOTCH);
    advance(motion, 4);
    expect(motion.value).toBe(0);
  });

  it('produces the same motion at 60 Hz and 144 Hz', () => {
    const standard = new ChapterMotion(),
      fast = new ChapterMotion();
    scrollNotches(standard);
    scrollNotches(fast);
    advance(standard, 0.75, 60);
    advance(fast, 0.75, 144);
    expect(standard.value).toBeGreaterThan(0.1);
    expect(standard.value).toBeCloseTo(fast.value, 2);
  });

  it.each([120, 144])('updates every moving frame on a %i Hz display', (hz) => {
    const motion = new ChapterMotion();
    motion.to(2, 0);
    scrollNotches(motion);
    for (let i = 0; i < 20; i++) {
      const before = motion.value;
      motion.tick(1 / hz);
      expect(motion.value).toBeGreaterThan(before);
    }
  });

  it('stays within bounds under extreme input and leaves the end once the plateau is crossed', () => {
    const motion = new ChapterMotion();
    for (let i = 0; i < 300; i++) {
      motion.wheel(-1e8);
      motion.tick(FRAME);
      expect(motion.value).toBe(0);
    }
    for (let i = 0; i < 30 * 60; i++) {
      motion.wheel(1e8);
      motion.tick(FRAME);
      expect(motion.value).toBeLessThanOrEqual(LAST);
    }
    expect(motion.value).toBe(LAST);
    advance(motion, DWELL_SECONDS + 0.1);
    // No backlog piles up past the end: just over half a plateau of reverse scroll leaves it.
    motion.wheel(-(DWELL / 2 + 0.05) / WHEEL_SENSITIVITY);
    advance(motion, 0.5);
    expect(motion.value).toBeLessThan(LAST);
    motion.wheel(Number.NaN);
    advance(motion, 2);
    expect(Number.isFinite(motion.value)).toBe(true);
  });
});

describe('touch', () => {
  it('maps one full-screen swipe to TOUCH_CHAPTERS_PER_SCREEN chapters of raw progress', () => {
    const motion = new ChapterMotion();
    const end = swipe(motion, -SCREEN, 1);
    motion.release(end + 500);
    advance(motion, 4);
    expect(motion.value).toBeCloseTo(plateau(TOUCH_CHAPTERS_PER_SCREEN), 6);
  });

  it('caps the speed while a finger drags quickly', () => {
    const motion = new ChapterMotion();
    motion.grab(0);
    let previous = 0;
    for (let i = 1; i <= 60; i++) {
      motion.drag(-SCREEN / 10, SCREEN, (i * 1000) / 60);
      motion.tick(FRAME);
      expect(motion.value - previous).toBeLessThanOrEqual(MAX_TRANSITION_SPEED * FRAME + 1e-9);
      expect(motion.goal - motion.value).toBeLessThanOrEqual(MAX_QUEUE_AHEAD + 1e-9);
      previous = motion.value;
    }
    motion.release();
  });

  it('rests where the finger leaves it, without snapping back to the previous chapter', () => {
    const motion = new ChapterMotion();
    motion.to(1, 0);
    const raw = 1 + 0.4 / TOUCH_CHAPTERS_PER_SCREEN;
    const end = swipe(motion, -SCREEN * 0.4, 1);
    motion.release(end + 500);
    for (let i = 0; i < 300; i++) expect(motion.tick(FRAME)).toBeGreaterThanOrEqual(1);
    expect(motion.value).toBeCloseTo(plateau(raw), 6);
    expect(Number.isInteger(motion.value)).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('coasts with capped, decaying inertia after a flick', () => {
    const motion = new ChapterMotion();
    const pixels = SCREEN * 0.3;
    const end = swipe(motion, -pixels, 0.1);
    motion.release(end);
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) samples.push(motion.tick(FRAME));
    for (let i = 1; i < samples.length; i++)
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    const rest = samples.at(-1)!;
    const dragged = (pixels / SCREEN) * TOUCH_CHAPTERS_PER_SCREEN;
    expect(rest).toBeGreaterThan(plateau(dragged));
    expect(rest).toBeLessThanOrEqual(
      plateau(dragged + TOUCH_MAX_VELOCITY * TOUCH_INERTIA_TIME_CONSTANT) + 1e-6,
    );
    expect(motion.moving).toBe(false);
  });

  it('discards queued wheel motion when a finger takes over', () => {
    const motion = new ChapterMotion();
    scrollNotches(motion);
    advance(motion, 0.6);
    const caught = motion.value;
    expect(caught).toBeGreaterThan(0);
    motion.grab(0);
    advance(motion, 2);
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
    for (let i = 0; i < 300; i++) {
      motion.tick(FRAME);
      expect(motion.value).toBeLessThanOrEqual(LAST);
    }
    expect(motion.value).toBe(LAST);
  });
});

describe('explicit navigation', () => {
  it('tweens exactly to a chapter and back', () => {
    const motion = new ChapterMotion();
    motion.to(5);
    advance(motion, NAVIGATION_DURATION / 2);
    expect(motion.value).toBeCloseTo(2.5, 5);
    advance(motion, NAVIGATION_DURATION / 2 + 0.1);
    expect(motion.value).toBe(5);
    motion.to(2);
    advance(motion, NAVIGATION_DURATION + 0.1);
    expect(motion.value).toBe(2);
    expect(motion.moving).toBe(false);
  });

  it('chains repeated key presses from the destination', () => {
    const motion = new ChapterMotion();
    motion.to(1);
    advance(motion, 0.2);
    motion.to(motion.destination + 1);
    advance(motion, NAVIGATION_DURATION + 0.1);
    expect(motion.value).toBe(2);
  });

  it('reaches an exact chapter after free scrolling left the value between chapters', () => {
    const motion = new ChapterMotion();
    motion.wheel(0.5 / WHEEL_SENSITIVITY);
    advance(motion, 0.8);
    motion.to(3);
    advance(motion, NAVIGATION_DURATION + 0.1);
    expect(motion.value).toBe(3);
  });

  it('skips the dwell hold', () => {
    const motion = new ChapterMotion();
    scrollNotches(motion);
    until(motion, (value) => Math.abs(value - 1) < 0.01);
    expect(motion.holding).toBeGreaterThan(0);
    const start = motion.value;
    motion.to(2);
    expect(motion.holding).toBe(0);
    advance(motion, 0.1);
    expect(motion.value).toBeGreaterThan(start);
    advance(motion, NAVIGATION_DURATION);
    expect(motion.value).toBe(2);
    // Arriving by navigation does not hold either: the next scroll moves on at once.
    scrollNotches(motion);
    advance(motion, 0.3);
    expect(motion.value).toBeGreaterThan(2);
  });

  it('can be interrupted by touch at any moment', () => {
    const motion = new ChapterMotion();
    motion.to(4);
    advance(motion, 0.7);
    const caught = motion.value;
    motion.grab(0);
    advance(motion, 3);
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

  it('shows a reduced-motion drag at once when settled, without a hold', () => {
    const motion = new ChapterMotion();
    motion.grab(0);
    motion.drag(-SCREEN / 2, SCREEN, 16);
    motion.settle();
    expect(motion.value).toBeCloseTo(plateau(0.5 * TOUCH_CHAPTERS_PER_SCREEN), 9);
    expect(motion.holding).toBe(0);
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
