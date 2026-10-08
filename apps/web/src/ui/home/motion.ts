export const CHAPTER_COUNT = 6;
export const INTRO_SECONDS = 0.85;

// Continuous scroll tuning. Progress is measured in chapters: 0 is the first, CHAPTER_COUNT - 1 the last.
/** Chapters per wheel pixel: a ~100 px mouse notch moves 0.15 chapter; a ~650 px trackpad swipe about one. */
export const WHEEL_SENSITIVITY = 0.0015;
/** Pixels per wheel line when the browser reports `deltaMode` 1. Page mode uses the viewport height. */
export const WHEEL_LINE_HEIGHT = 16;
/** Largest progress change one wheel event can request, so a single huge event cannot skip chapters. */
export const WHEEL_MAX_STEP = 0.5;
/** Time constant (s) of the exponential approach from the displayed value to the scroll target. */
export const FOLLOW_TIME_CONSTANT = 0.15;
/** Tighter time constant (s) while a finger is down, so the scene stays under the finger. */
export const TOUCH_FOLLOW_TIME_CONSTANT = 0.06;
/** Chapters travelled by a vertical drag across the full viewport height. */
export const TOUCH_CHAPTERS_PER_SCREEN = 1;
/** Time constant (s) of the post-release coast; a release at v chapters/s travels v times this. */
export const TOUCH_INERTIA_TIME_CONSTANT = 0.3;
/** Release speed cap (chapters/s), limiting a flick's coast to about 1.2 chapters. */
export const TOUCH_MAX_VELOCITY = 4;
/** A release this long (ms) after the last finger movement carries no inertia. */
export const TOUCH_RELEASE_IDLE_MS = 100;
/** Default duration (s) of explicit keyboard, dot, and button navigation. */
export const NAVIGATION_DURATION = 2;

const LAST = CHAPTER_COUNT - 1;
const SETTLE_EPSILON = 0.0002;
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const cubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const sigmoid = (t: number) => 0.5 + Math.tanh(6 * (clamp(t) - 0.5)) / (2 * Math.tanh(3));

/** Converts a WheelEvent's `deltaY` to pixels for any `deltaMode` (0 pixels, 1 lines, 2 pages). */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number) {
  return deltaY * (deltaMode === 1 ? WHEEL_LINE_HEIGHT : deltaMode === 2 ? pageHeight : 1);
}

const toProgress = (value: number) => clamp(value, 0, LAST);

/**
 * Continuous journey progress. Wheel and touch input move a target; the displayed `value`
 * follows it with frame-rate-independent exponential smoothing. Nothing is ever locked or
 * ignored, and nothing snaps to a chapter: the value rests wherever the input leaves it.
 * Explicit navigation (`to`) tweens to an exact chapter and yields to any new wheel or touch.
 */
export class ChapterMotion {
  value = 0;
  private target = 0;
  private velocity = 0;
  private touching = false;
  private touchVelocity = 0;
  private lastMove = -Infinity;
  private tween: { from: number; to: number; time: number; duration: number } | null = null;

  /** The chapter the interface presents: the nearest one to the displayed progress. */
  get chapter() {
    return Math.round(this.value);
  }
  /** Where the motion is heading, so repeated key presses chain from the destination. */
  get destination() {
    return this.tween ? this.tween.to : Math.round(this.target);
  }
  get moving() {
    return (
      this.tween !== null ||
      this.touching ||
      this.velocity !== 0 ||
      Math.abs(this.target - this.value) > SETTLE_EPSILON
    );
  }

  /** Explicit navigation to an exact chapter; a non-positive duration jumps immediately. */
  to(chapter: number, duration = NAVIGATION_DURATION) {
    const destination = toProgress(Math.round(chapter));
    this.touching = false;
    this.velocity = this.touchVelocity = 0;
    if (duration <= 0 || destination === this.value) {
      this.value = this.target = destination;
      this.tween = null;
      return;
    }
    this.target = this.value;
    this.tween = { from: this.value, to: destination, time: 0, duration };
  }

  /** Shows the target at once, without smoothing (reduced motion). */
  settle() {
    this.tween = null;
    this.value = this.target;
  }

  /** Adds a wheel delta in pixels to the target. Every event counts, including during transitions. */
  wheel(pixels: number) {
    if (!Number.isFinite(pixels) || pixels === 0) return;
    this.interrupt();
    this.velocity = 0;
    const step = clamp(pixels * WHEEL_SENSITIVITY, -WHEEL_MAX_STEP, WHEEL_MAX_STEP);
    this.target = toProgress(this.target + step);
  }

  grab(now = 0) {
    this.interrupt();
    // Catch the scene where it is shown, discarding wheel or coast motion still in flight.
    this.target = this.value;
    this.velocity = this.touchVelocity = 0;
    this.touching = true;
    this.lastMove = now;
  }

  /** Moves the target by a finger delta in pixels; positive (downward) moves backward. */
  drag(pixels: number, viewportHeight: number, now: number) {
    if (!this.touching || !Number.isFinite(pixels)) return;
    const step = (-pixels / Math.max(1, viewportHeight)) * TOUCH_CHAPTERS_PER_SCREEN;
    this.target = toProgress(this.target + step);
    const elapsed = (now - this.lastMove) / 1000;
    if (elapsed > 0) {
      // Smooth the sampled speed so one uneven pointer event cannot dominate the release.
      const instant = step / elapsed;
      const weight = 1 - Math.exp(-elapsed / 0.05);
      this.touchVelocity += (instant - this.touchVelocity) * weight;
    }
    this.lastMove = now;
  }

  /** Ends a touch. Without a time (cancel, modal), or after a pause, there is no coast. */
  release(now?: number) {
    if (!this.touching) return;
    this.touching = false;
    const recent = now !== undefined && now - this.lastMove <= TOUCH_RELEASE_IDLE_MS;
    this.velocity = recent ? clamp(this.touchVelocity, -TOUCH_MAX_VELOCITY, TOUCH_MAX_VELOCITY) : 0;
    this.touchVelocity = 0;
  }

  tick(delta: number) {
    const dt = clamp(delta, 0, 0.1);
    if (this.tween) {
      this.tween.time += dt;
      const t = clamp(this.tween.time / this.tween.duration);
      this.value = this.target = this.tween.from + (this.tween.to - this.tween.from) * cubic(t);
      if (t === 1) this.tween = null;
      return this.value;
    }
    if (this.velocity !== 0) {
      // Exact integral of an exponentially decaying velocity over this frame.
      const decay = Math.exp(-dt / TOUCH_INERTIA_TIME_CONSTANT);
      const next = this.target + this.velocity * TOUCH_INERTIA_TIME_CONSTANT * (1 - decay);
      this.target = toProgress(next);
      this.velocity *= decay;
      if (next !== this.target || Math.abs(this.velocity) < 0.001) this.velocity = 0;
    }
    const constant = this.touching ? TOUCH_FOLLOW_TIME_CONSTANT : FOLLOW_TIME_CONSTANT;
    // Clamping the target keeps both ends soft: the value decelerates into them, never past.
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / constant));
    if (Math.abs(this.target - this.value) < SETTLE_EPSILON) this.value = this.target;
    return this.value;
  }

  private interrupt() {
    if (!this.tween) return;
    this.tween = null;
    this.target = this.value;
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
