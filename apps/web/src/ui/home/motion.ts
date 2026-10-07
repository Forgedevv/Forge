// Spring equations adapted from Junni's Scroller. See THIRD_PARTY_NOTICES.md.
export const CHAPTER_COUNT = 6;
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const cubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const sigmoid = (t: number) => 0.5 + Math.tanh(6 * (clamp(t) - 0.5)) / (2 * Math.tanh(3));

export class ChapterMotion {
  value = 0;
  private velocity = 0;
  private acceleration = 0;
  private remainder = 0;
  private position = 0;
  private previousPosition = 0;
  private wheelTime = -Infinity;
  private previousWheel = 0;
  private touching = false;
  private touchOrigin = 0;
  private touchMove = 0;
  private touchDifference = 0;
  private touchChapter: number | null = null;
  private tween: { from: number; to: number; time: number; duration: number } | null = null;

  get chapter() {
    return Math.round(this.value);
  }
  get moving() {
    return (
      this.tween !== null ||
      this.touching ||
      Math.abs(this.velocity) + Math.abs(this.acceleration) > 0.00001
    );
  }

  private synchronize() {
    this.position = this.previousPosition = this.value;
    this.remainder = 0;
  }

  to(chapter: number, duration = 2) {
    const target = clamp(chapter, 0, CHAPTER_COUNT - 1);
    this.touching = false;
    this.touchChapter = null;
    this.velocity = this.acceleration = 0;
    this.wheelTime = -Infinity;
    this.synchronize();
    if (duration <= 0) {
      this.value = target;
      this.synchronize();
      this.tween = null;
      return;
    }
    this.tween = { from: this.value, to: target, time: 0, duration };
  }

  wheel(delta: number, now: number) {
    if (!Number.isFinite(delta) || delta === 0) return;
    const decaying =
      Math.sign(delta) === Math.sign(this.previousWheel) &&
      now - this.wheelTime < 100 &&
      Math.abs(delta) < Math.abs(this.previousWheel);
    this.wheelTime = now;
    this.previousWheel = delta;
    if (decaying) return;
    if (this.tween) this.synchronize();
    this.tween = null;
    this.acceleration += clamp(delta, -1600, 1600) * 0.00005;
  }

  grab() {
    this.tween = null;
    this.velocity = this.acceleration = 0;
    this.wheelTime = -Infinity;
    this.synchronize();
    this.touching = true;
    this.touchOrigin = this.value;
    this.touchChapter = this.chapter;
    this.touchMove = this.touchDifference = 0;
  }

  drag(delta: number) {
    if (!this.touching) return;
    this.touchMove -= delta * 0.0005;
    this.touchDifference -= delta * 0.0025;
    this.value = clamp(this.touchOrigin + this.touchMove, 0, CHAPTER_COUNT - 1);
  }

  release(delta: number) {
    if (!this.touching) return;
    this.touching = false;
    this.synchronize();
    this.velocity -= clamp(delta, -300, 300) * 0.001;
  }

  tick(delta: number) {
    const dt = clamp(delta, 0, 0.1);
    if (this.tween) {
      this.tween.time += dt;
      const t = clamp(this.tween.time / this.tween.duration);
      this.value = this.tween.from + (this.tween.to - this.tween.from) * cubic(t);
      this.synchronize();
      if (t === 1) this.tween = null;
      return this.value;
    }
    if (this.touching) return this.value;
    // Keep the measured spring response, interpolating its presentation at every refresh rate.
    this.remainder += dt;
    while (this.remainder >= 1 / 60) {
      this.remainder -= 1 / 60;
      const step = 1 / 60;
      this.previousPosition = this.position;
      let target = Math.round(this.position + (this.velocity > 0 ? 0.45 : -0.45));
      if (this.touchChapter !== null) {
        if (target === this.touchChapter && Math.abs(this.touchDifference) > 0.05) {
          target += Math.sign(this.touchDifference);
        }
        this.touchChapter = null;
      }
      target = clamp(target, 0, CHAPTER_COUNT - 1);
      this.acceleration += (target - this.position) * step * 0.3;
      this.acceleration *= 0.86 * (1 - step * 2);
      this.velocity += this.acceleration * 10 * step;
      this.velocity *= 1 - step * 8;
      this.position = clamp(this.position + this.velocity, 0, CHAPTER_COUNT - 1);
      if (
        (this.position === 0 && this.velocity < 0) ||
        (this.position === 5 && this.velocity > 0)
      ) {
        this.velocity = this.acceleration = 0;
      }
    }
    this.value =
      this.previousPosition + (this.position - this.previousPosition) * (this.remainder * 60);
    return this.value;
  }
}

export function boostAt(elapsed: number) {
  const rise = smooth(elapsed / 2);
  const recovery = 1 - smooth((elapsed - 2) / 4);
  return elapsed < 0 || elapsed > 6 ? 0 : rise * recovery;
}

export function boostCameraAt(elapsed: number) {
  if (elapsed < 0 || elapsed > 6) return { fov: 0, shake: 0 };
  return {
    fov: 15 * smooth(elapsed) * (1 - smooth((elapsed - 2) / 4)),
    shake: 0.15 * smooth(elapsed / 0.8) * (1 - smooth((elapsed - 2) / 2)),
  };
}

export function jumpAt(elapsed: number) {
  const phase = ((elapsed % 3.5) + 3.5) % 3.5;
  return {
    height: phase < 1.4 ? Math.sin((phase / 1.4) * Math.PI) * 0.18 : 0,
    impact: phase >= 0.7 && phase < 1 ? 1 - (phase - 0.7) / 0.3 : 0,
    word: Math.floor((elapsed + 2.8) / 3.5) % 3,
  };
}
