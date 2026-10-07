import { describe, expect, it } from 'vitest';
import { boostAt, boostCameraAt, ChapterMotion, jumpAt, sigmoid } from './motion';

function advance(motion: ChapterMotion, seconds: number, hz = 60) {
  for (let frame = 0; frame < seconds * hz; frame++) motion.tick(1 / hz);
}

describe('chapter navigation', () => {
  it('keeps the initial chapter stationary without input', () => {
    const motion = new ChapterMotion();
    advance(motion, 20);
    expect(motion.value).toBe(0);
  });

  it('uses a two-second reversible navigation transition', () => {
    const motion = new ChapterMotion();
    motion.to(5);
    advance(motion, 1);
    expect(motion.value).toBeCloseTo(2.5, 5);
    advance(motion, 1.1);
    expect(motion.value).toBe(5);
    motion.to(0);
    advance(motion, 2.1);
    expect(motion.value).toBe(0);
  });

  it('clamps timeline targets and supports instantaneous reduced-motion navigation', () => {
    const motion = new ChapterMotion();
    motion.to(99, 0);
    expect(motion.value).toBe(5);
    motion.to(-4, 0);
    expect(motion.value).toBe(0);
  });

  it('allows a touch gesture to leave the first chapter and settle', () => {
    const motion = new ChapterMotion();
    motion.grab();
    motion.drag(-240);
    expect(motion.value).toBeCloseTo(0.12);
    motion.release(-20);
    advance(motion, 12);
    expect(motion.chapter).toBe(1);
    expect(motion.value).toBeCloseTo(1, 2);
  });

  it('ignores a decaying wheel tail and rejects invalid wheel input', () => {
    const first = new ChapterMotion(),
      second = new ChapterMotion();
    first.wheel(600, 0);
    second.wheel(600, 0);
    first.wheel(300, 30);
    first.wheel(Number.NaN, 60);
    advance(first, 0.3);
    advance(second, 0.3);
    expect(first.value).toBe(second.value);
  });

  it('has the same spring response at 60 Hz and 120 Hz', () => {
    const standard = new ChapterMotion(),
      fast = new ChapterMotion();
    standard.to(2, 0);
    fast.to(2, 0);
    standard.wheel(1200, 0);
    fast.wheel(1200, 0);
    advance(standard, 4, 60);
    advance(fast, 4, 120);
    expect(standard.value).toBeCloseTo(fast.value, 7);
  });

  it.each([120, 144])('updates every moving frame on a %i Hz display', (hz) => {
    const motion = new ChapterMotion();
    motion.to(2, 0);
    motion.wheel(1200, 0);
    advance(motion, 0.05, hz);
    for (let i = 0; i < 20; i++) {
      const before = motion.value;
      motion.tick(1 / hz);
      expect(motion.value).toBeGreaterThan(before);
    }
  });

  it('accepts a smaller reverse wheel gesture immediately after a larger one', () => {
    const forward = new ChapterMotion(),
      reversed = new ChapterMotion();
    for (const motion of [forward, reversed]) {
      motion.to(2, 0);
      motion.wheel(600, 0);
      advance(motion, 0.05);
    }
    reversed.wheel(-300, 50);
    advance(forward, 0.1);
    advance(reversed, 0.1);
    expect(reversed.value).toBeLessThan(forward.value);
  });

  it('discards old wheel momentum when a touch gesture takes over', () => {
    const interrupted = new ChapterMotion(),
      fresh = new ChapterMotion();
    interrupted.to(2, 0);
    interrupted.wheel(1200, 0);
    advance(interrupted, 0.08, 120);
    fresh.to(interrupted.value, 0);
    for (const motion of [interrupted, fresh]) {
      motion.grab();
      motion.drag(80);
      motion.release(8);
      advance(motion, 0.5, 120);
    }
    expect(interrupted.value).toBeCloseTo(fresh.value, 10);
  });

  it('leaves no interpolation jump after an instantaneous chapter change', () => {
    const motion = new ChapterMotion();
    motion.wheel(1200, 0);
    advance(motion, 0.08, 144);
    motion.to(4, 0);
    advance(motion, 1, 144);
    expect(motion.value).toBe(4);
  });

  it('never escapes the first or last chapter under extreme input', () => {
    const motion = new ChapterMotion();
    for (let i = 0; i < 500; i++) {
      motion.wheel(-1e8, i * 17);
      motion.tick(1 / 60);
    }
    expect(motion.value).toBe(0);
    motion.to(5, 0);
    for (let i = 0; i < 500; i++) {
      motion.wheel(1e8, 10000 + i * 17);
      motion.tick(1 / 60);
    }
    expect(motion.value).toBe(5);
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
