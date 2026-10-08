export const CHAPTER_COUNT = 6;
export const INTRO_SECONDS = 0.85;

// Continuous scroll tuning. Progress is measured in chapters: 0 is the first, CHAPTER_COUNT - 1 the last.
// Wheel and touch accumulate a raw progress; the scene shows its plateau (see `plateau`).
/**
 * Chapters of raw progress per wheel pixel: a ~100 px mouse notch adds 0.17, still inside the
 * plateau, and five notches carry the journey to the next chapter; a ~500 px trackpad swipe about one.
 */
export const WHEEL_SENSITIVITY = 0.0017;
/** Pixels per wheel line when the browser reports `deltaMode` 1. Page mode uses the viewport height. */
export const WHEEL_LINE_HEIGHT = 16;
/** Largest raw progress change one wheel event can request, so a single huge event cannot skip chapters. */
export const WHEEL_MAX_STEP = 0.5;
/**
 * Share of each chapter's raw scroll range that is a plateau, half before and half after the chapter:
 * input inside it leaves the scene exactly on the chapter, so the first notches only build up the move.
 */
export const DWELL = 0.35;
/** Minimum time (s) the scene stays on a chapter it has just reached. Input keeps queuing meanwhile. */
export const DWELL_SECONDS = 1;
/** Highest speed of the displayed progress (chapters/s): a full chapter transition takes at least 1.2 s. */
export const MAX_TRANSITION_SPEED = 1 / 1.2;
/** Acceleration (chapters/s^2) that eases the displayed progress into and out of its speed. */
export const TRANSITION_ACCELERATION = 2.5;
/** Largest distance (chapters) the queued target may lead or trail the displayed progress. */
export const MAX_QUEUE_AHEAD = 1.5;
/** Time constant (s) of the final soft approach onto a stop. */
export const FOLLOW_TIME_CONSTANT = 0.18;
/** Tighter final approach (s) while a finger is down. */
export const TOUCH_FOLLOW_TIME_CONSTANT = 0.06;
/** Chapters of raw progress travelled by a vertical drag across the full viewport height. */
export const TOUCH_CHAPTERS_PER_SCREEN = 1;
/** Time constant (s) of the post-release coast; a release at v chapters/s travels v times this. */
export const TOUCH_INERTIA_TIME_CONSTANT = 0.3;
/** Release speed cap (chapters/s), limiting a flick's coast to about 0.6 chapter of raw progress. */
export const TOUCH_MAX_VELOCITY = 2;
/** A release this long (ms) after the last finger movement carries no inertia. */
export const TOUCH_RELEASE_IDLE_MS = 100;
/** Default duration (s) of explicit keyboard, dot, and button navigation. */
export const NAVIGATION_DURATION = 2;

const LAST = CHAPTER_COUNT - 1;
const SETTLE_EPSILON = 0.0002;
/** Distance from a chapter under which the displayed progress counts as having arrived on it. */
const ARRIVAL_EPSILON = 0.01;
/** Largest integration step (s), so the motion is the same at any frame rate. */
const STEP = 1 / 240;
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const cubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const cubicSlope = (t: number) => (t < 0.5 ? 12 * t * t : 3 * Math.pow(-2 * t + 2, 2));
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const smootherstep = (t: number) => {
  const x = clamp(t);
  return x * x * x * (x * (6 * x - 15) + 10);
};
export const sigmoid = (t: number) => 0.5 + Math.tanh(6 * (clamp(t) - 0.5)) / (2 * Math.tanh(3));

/** Converts a WheelEvent's `deltaY` to pixels for any `deltaMode` (0 pixels, 1 lines, 2 pages). */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number) {
  return deltaY * (deltaMode === 1 ? WHEEL_LINE_HEIGHT : deltaMode === 2 ? pageHeight : 1);
}

const toProgress = (value: number) => clamp(value, 0, LAST);

/**
 * Maps raw scroll progress to displayed chapter progress with a plateau around every chapter:
 * within DWELL / 2 of a chapter the result is exactly that chapter, and between plateaus it eases
 * (smootherstep) to the next one. Monotonic and symmetric, so reversing retraces the same curve.
 */
export function plateau(raw: number) {
  const r = toProgress(raw);
  const chapter = Math.min(LAST, Math.floor(r));
  return toProgress(chapter + smootherstep((r - chapter - DWELL / 2) / (1 - DWELL)));
}

/** Smallest (side -1) or largest (side 1) raw progress whose plateau is `progress`, by bisection. */
function rawBound(progress: number, side: -1 | 1) {
  let low = 0,
    high = LAST;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (side < 0 ? plateau(mid) < progress : plateau(mid) <= progress) low = mid;
    else high = mid;
  }
  return side < 0 ? high : low;
}

/** A raw progress showing `progress`: the plateau centre for a chapter, the exact inverse otherwise. */
function rawFor(progress: number) {
  const p = toProgress(progress);
  return Number.isInteger(p) ? p : (rawBound(p, -1) + rawBound(p, 1)) / 2;
}

/**
 * Continuous journey progress with a rhythm. Wheel and touch move a raw target that is never
 * discarded; the displayed `value` heads for the target's plateau through a speed- and
 * acceleration-limited follower that stops on every chapter it reaches and holds there for at
 * least DWELL_SECONDS. Input arriving meanwhile stays queued (up to MAX_QUEUE_AHEAD) and plays
 * afterwards. Nothing locks or snaps: the value rests wherever the input leaves it. Explicit
 * navigation (`to`) tweens to an exact chapter, skips the hold, and yields to new wheel or touch.
 */
export class ChapterMotion {
  value = 0;
  private target = 0;
  private speed = 0;
  private velocity = 0;
  private hold = 0;
  private arrived = true;
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
    return this.tween ? this.tween.to : Math.round(plateau(this.target));
  }
  /** The displayed progress the queued input leads to. */
  get goal() {
    return this.tween ? this.tween.to : plateau(this.target);
  }
  /** Seconds left before the scene may leave the chapter it has just reached. */
  get holding() {
    return this.hold;
  }
  get moving() {
    return (
      this.tween !== null ||
      this.touching ||
      this.velocity !== 0 ||
      this.speed !== 0 ||
      Math.abs(plateau(this.target) - this.value) > SETTLE_EPSILON
    );
  }

  /** Explicit navigation to an exact chapter, skipping any hold; a non-positive duration jumps. */
  to(chapter: number, duration = NAVIGATION_DURATION) {
    const destination = toProgress(Math.round(chapter));
    this.touching = false;
    this.velocity = this.touchVelocity = this.speed = this.hold = 0;
    if (duration <= 0 || destination === this.value) {
      this.value = this.target = destination;
      this.arrived = true;
      this.tween = null;
      return;
    }
    this.target = rawFor(this.value);
    this.tween = { from: this.value, to: destination, time: 0, duration };
  }

  /** Shows the queued target at once, without smoothing or holds (reduced motion). */
  settle() {
    this.tween = null;
    this.value = plateau(this.target);
    this.speed = this.hold = 0;
    this.arrived = this.onChapter();
  }

  /** Adds a wheel delta in pixels to the raw target. Every event counts, including during holds. */
  wheel(pixels: number) {
    if (!Number.isFinite(pixels) || pixels === 0) return;
    this.interrupt();
    this.velocity = 0;
    const step = clamp(pixels * WHEEL_SENSITIVITY, -WHEEL_MAX_STEP, WHEEL_MAX_STEP);
    this.queue(this.target + step);
  }

  grab(now = 0) {
    this.interrupt();
    // Catch the scene where it is shown, discarding wheel or coast motion still queued.
    this.target = rawFor(this.value);
    this.velocity = this.touchVelocity = 0;
    this.touching = true;
    this.lastMove = now;
  }

  /** Moves the raw target by a finger delta in pixels; positive (downward) moves backward. */
  drag(pixels: number, viewportHeight: number, now: number) {
    if (!this.touching || !Number.isFinite(pixels)) return;
    const step = (-pixels / Math.max(1, viewportHeight)) * TOUCH_CHAPTERS_PER_SCREEN;
    this.queue(this.target + step);
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
      const tween = this.tween;
      tween.time += dt;
      const t = clamp(tween.time / tween.duration);
      this.value = tween.from + (tween.to - tween.from) * cubic(t);
      if (t === 1) {
        this.value = this.target = tween.to;
        this.tween = null;
        this.arrived = true;
      }
      return this.value;
    }
    if (this.velocity !== 0) {
      // Exact integral of an exponentially decaying velocity over this frame.
      const decay = Math.exp(-dt / TOUCH_INERTIA_TIME_CONSTANT);
      const next = this.target + this.velocity * TOUCH_INERTIA_TIME_CONSTANT * (1 - decay);
      this.queue(next);
      this.velocity *= decay;
      if (next !== this.target || Math.abs(this.velocity) < 0.001) this.velocity = 0;
    }
    const goal = plateau(this.target);
    const tail = this.touching ? TOUCH_FOLLOW_TIME_CONSTANT : FOLLOW_TIME_CONSTANT;
    const steps = Math.ceil(dt / STEP - 1e-9);
    for (let i = 0; i < steps; i++) this.step(goal, dt / steps, tail);
    return this.value;
  }

  private step(goal: number, h: number, tail: number) {
    const on = this.onChapter();
    // Head for the next chapter in the direction of travel at most; stay put while holding.
    const here = on ? Math.round(this.value) : null;
    let stop = goal;
    if (here !== null && this.hold > 0) stop = here;
    else if (goal > this.value) stop = Math.min(goal, (here ?? Math.floor(this.value)) + 1);
    else if (goal < this.value) stop = Math.max(goal, (here ?? Math.ceil(this.value)) - 1);
    this.hold = Math.max(0, this.hold - h);

    const distance = stop - this.value;
    const reach = Math.abs(distance);
    // Braking curve: the fastest speed that still stops softly on `stop`, within the speed cap.
    const desired =
      Math.sign(distance) *
      Math.min(MAX_TRANSITION_SPEED, Math.sqrt(2 * TRANSITION_ACCELERATION * reach), reach / tail);
    const braking =
      Math.sign(desired) === Math.sign(this.speed) && Math.abs(desired) < Math.abs(this.speed);
    const change = TRANSITION_ACCELERATION * h;
    this.speed = braking ? desired : this.speed + clamp(desired - this.speed, -change, change);
    this.value = toProgress(this.value + this.speed * h);
    if (Math.abs(stop - this.value) < SETTLE_EPSILON && Math.abs(this.speed) < 0.05) {
      this.value = stop;
      this.speed = 0;
    }
    // Arriving on a chapter starts its hold; leaving it ends any hold.
    const arrived = this.onChapter();
    if (!arrived) this.hold = 0;
    else if (!this.arrived) this.hold = DWELL_SECONDS;
    this.arrived = arrived;
  }

  private onChapter() {
    return Math.abs(this.value - Math.round(this.value)) < ARRIVAL_EPSILON;
  }

  /** Sets the raw target within the journey and within MAX_QUEUE_AHEAD of the displayed value. */
  private queue(raw: number) {
    const low = rawBound(toProgress(this.value - MAX_QUEUE_AHEAD), -1);
    const high = rawBound(toProgress(this.value + MAX_QUEUE_AHEAD), 1);
    this.target = clamp(toProgress(raw), low, high);
  }

  private interrupt() {
    if (!this.tween) return;
    const { from, to, time, duration } = this.tween;
    // Carry the tween's speed into the follower, within the scroll speed cap.
    const t = clamp(time / duration);
    this.speed = clamp(
      ((to - from) * cubicSlope(t)) / duration,
      -MAX_TRANSITION_SPEED,
      MAX_TRANSITION_SPEED,
    );
    this.tween = null;
    this.target = rawFor(this.value);
    this.arrived = this.onChapter();
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
