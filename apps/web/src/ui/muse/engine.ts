import {
  COOL,
  Ease,
  INK,
  PI,
  TAU,
  WHITE,
  clamp,
  damp,
  drawSpark,
  hexRGB,
  lerp,
  luminance,
  mixC,
  mulC,
  rgba,
  sparkPath,
  type Easing,
  type RGB,
} from './paint';
import {
  EYE_REST,
  MOODS,
  SMOOTH_KEYS,
  type EyePose,
  type MoodConfig,
  type MuseState,
  type SmoothPose,
} from './moods';

/** FORGE's own Muse colors: brushed metal and copper. */
export const FORGE_PRIMARY = '#8C9DA1';
export const FORGE_ACCENT = '#B78970';

export interface MuseOptions {
  /** Small instance (avatars, cards): fewer details, bigger features. */
  mini?: boolean;
  /** Number of four-point sparks on the orbit. */
  sparks?: number;
  /** Number of drifting motes around the body. */
  motes?: number;
  primary?: string;
  accent?: string;
  /** Gentle static pose: no time flow, tweens or particles. */
  reduced?: boolean;
  /** Random source in [0, 1), injectable for tests. */
  random?: () => number;
}

/** A normalized look target, each axis in -1..1 (positive y is down). */
export interface Look {
  x: number;
  y: number;
}

type TweenProp = 'blink' | 'hop' | 'spin' | 'happy';
type Key = readonly [value: number, ms: number, ease?: Easing];
interface Tween {
  prop: TweenProp;
  keys: readonly Key[];
  i: number;
  from: number;
  start: number;
  dead?: boolean;
}
interface Particle {
  type: 'spark' | 'ember' | 'ring' | 'z';
  x: number;
  y: number;
  vx: number;
  vy: number;
  drag: number;
  g: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  vr: number;
  col: RGB;
  r0?: number;
  grow?: number;
}
interface Mote {
  a: number;
  r: number;
  s: number;
  size: number;
  ph: number;
  tw: number;
  f: number;
}
interface OrbitSpark {
  x: number;
  y: number;
  z: number;
  r: number;
  a: number;
  rot: number;
}

export interface RenderOptions {
  cx?: number;
  cy?: number;
  /** Body radius as a fraction of `size`. */
  rf?: number;
  /** Largest radius the aura may reach, so it never clips at the canvas edge. */
  maxR?: number;
}

/** What a poke did, for callers that react to it. */
export type PokeResult = 'poke' | 'wake' | 'dizzy';

/**
 * The FORGE Muse, direction A "Nebula": a soft plasma orb with eyes placed on a sphere, an
 * orbit of four-point sparks and a cloud of motes. One instance per canvas view; the state is
 * advanced with `update(dt)` (seconds, any frame rate) and drawn with `render`.
 */
export class Muse {
  readonly mini: boolean;
  readonly reduced: boolean;
  private readonly random: () => number;
  private readonly nSparks: number;
  base1: RGB = [0, 0, 0];
  base2: RGB = [0, 0, 0];
  c1: RGB = [0, 0, 0];
  c2: RGB = [0, 0, 0];
  eyeLight = true;
  moodName: MuseState = 'idle';
  baseMood: MuseState = 'idle';
  cfg: MoodConfig = MOODS.idle;
  readonly cur: SmoothPose;
  readonly eye: EyePose = { ...EYE_REST };
  t: number;
  clock = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;
  private prevYaw = 0;
  private yawVel = 0;
  /** Squash and stretch spring. */
  q = 0;
  private qv = 0;
  readonly p: Record<TweenProp, number> = { blink: 1, hop: 0, spin: 0, happy: 0 };
  private tweens: Tween[] = [];
  private nextBlink: number;
  private doubleBlink = 0;
  private orbitPhase: number;
  particles: Particle[] = [];
  private readonly motes: Mote[];
  private clicks: number[] = [];
  private dizzyUntil = 0;
  private readonly timers = { beat: 0.3, zz: 0.5, ripple: 0.2, sparkle: 0, think: 0.4 };
  private beatGlow = 0;
  private flick = 1;
  private bounceY = 0;
  private prevBounceS = 0;
  private readonly wander = { t: 0, x: 0, y: 0 };
  /** Last rendered body center and radius, in canvas CSS pixels. */
  lastR = 0;
  lastCx = 0;
  lastCy = 0;

  constructor(o: MuseOptions = {}) {
    this.mini = Boolean(o.mini);
    this.reduced = Boolean(o.reduced);
    this.random = o.random ?? Math.random;
    this.nSparks = o.sparks ?? (this.mini ? 3 : 5);
    this.setColors(o.primary ?? FORGE_PRIMARY, o.accent ?? FORGE_ACCENT, true);
    const { glow, orbit, orbitR, sag, breathe, breatheRate, float, roll, sink, bounce } =
      MOODS.idle;
    this.cur = { glow, orbit, orbitR, sag, breathe, breatheRate, float, roll, sink, bounce };
    this.t = this.reduced ? 0.6 : this.rand(0, 100);
    this.nextBlink = this.rand(1, 3);
    this.orbitPhase = this.reduced ? 0.9 : this.rand(0, TAU);
    const nm = o.motes ?? (this.mini ? 6 : 26);
    this.motes = Array.from({ length: nm }, () => ({
      a: this.rand(0, TAU),
      r: this.rand(1.1, 1.85),
      s: this.rand(0.12, 0.42) * (this.random() < 0.5 ? -1 : 1),
      size: this.rand(0.6, 1.4),
      ph: this.rand(0, TAU),
      tw: this.rand(1.2, 3.2),
      f: this.rand(0.6, 1.4),
    }));
  }

  private rand(a: number, b: number) {
    return a + this.random() * (b - a);
  }

  setColors(primary: string | RGB, accent: string | RGB, instant = false) {
    this.base1 = typeof primary === 'string' ? hexRGB(primary) : [...primary];
    this.base2 = typeof accent === 'string' ? hexRGB(accent, [183, 137, 112]) : [...accent];
    if (instant || this.reduced) {
      this.c1 = this.target(this.base1, 1);
      this.c2 = this.target(this.base2, 0.75);
    }
    // Glowing light eyes on dark-ish bodies, ink eyes on very light ones.
    this.eyeLight = luminance(this.base1) < 0.45;
  }

  /* ---------- tweens ---------- */
  private anim(prop: TweenProp, keys: readonly Key[]) {
    if (this.reduced) return;
    this.tweens = this.tweens.filter((tw) => tw.prop !== prop);
    this.tweens.push({ prop, keys, i: 0, from: this.p[prop], start: this.clock });
  }
  private runTweens() {
    for (const tw of this.tweens) {
      let el = (this.clock - tw.start) * 1000,
        k = tw.keys[tw.i];
      while (k && el >= k[1]) {
        this.p[tw.prop] = k[0];
        tw.from = k[0];
        tw.start += k[1] / 1000;
        el -= k[1];
        tw.i++;
        k = tw.keys[tw.i];
      }
      if (!k) {
        tw.dead = true;
        continue;
      }
      this.p[tw.prop] = lerp(tw.from, k[0], (k[2] ?? Ease.inOut)(clamp(el / k[1])));
    }
    this.tweens = this.tweens.filter((tw) => !tw.dead);
  }

  /* ---------- actions ---------- */
  blink() {
    this.anim('blink', [
      [0.04, 70, Ease.in],
      [1, 150, Ease.out],
    ]);
  }
  kick(v: number) {
    if (!this.reduced) this.qv += v * 6;
  }
  hop(h = 0.14, ms = 520) {
    this.anim('hop', [
      [-h, 150, Ease.out],
      [0, ms, Ease.bounce],
    ]);
  }

  setMood(name: MuseState) {
    if (name === this.moodName) return;
    const prev = this.moodName;
    if (name !== 'dizzy') this.baseMood = name;
    this.moodName = name;
    this.cfg = MOODS[name];
    if (this.reduced) {
      this.snap();
      return;
    }
    this.kick(name === 'error' || name === 'sleeping' ? 0.3 : -0.45);
    if (name === 'success') {
      this.burst(18, 1);
      this.ring(1.1);
      this.hop(0.22, 640);
    }
    if (name === 'error')
      this.anim('spin', [
        [-0.13, 90, Ease.out],
        [0.1, 120, Ease.inOut],
        [-0.05, 120, Ease.inOut],
        [0, 260, Ease.out],
      ]);
    if (name === 'listening') this.ring(0.6);
    if (prev === 'sleeping') this.burst(5, 0.5);
    if (name !== 'sleeping') this.blink();
  }

  /** Jumps straight to the current mood's pose, with no transition or burst. */
  snap() {
    this.particles.length = 0;
    for (const k of SMOOTH_KEYS) this.cur[k] = this.cfg[k];
    Object.assign(this.eye, this.cfg.eye);
    this.c1 = this.target(this.base1, 1);
    this.c2 = this.target(this.base2, 0.75);
  }

  /** A click: a happy squash, a wake-up, or after five fast clicks, a dizzy spell. */
  poke(): PokeResult {
    const now = this.clock;
    this.clicks = this.clicks.filter((c) => now - c < 1.4);
    this.clicks.push(now);
    if (this.moodName === 'sleeping') {
      this.setMood('idle');
      this.hop(0.2);
      this.p.happy = 0;
      return 'wake';
    }
    if (this.moodName === 'dizzy') {
      this.kick(-0.5);
      this.dizzyUntil = Math.max(this.dizzyUntil, now + 0.9);
      return 'dizzy';
    }
    if (this.clicks.length >= 5) {
      this.clicks = [];
      this.setMood('dizzy');
      this.dizzyUntil = now + 2.6;
      this.kick(-1);
      this.anim('spin', [
        [TAU, 700, Ease.out],
        [TAU, 1],
        [0, 1],
      ]);
      this.burst(10, 0.9);
      return 'dizzy';
    }
    this.kick(-0.95);
    this.hop(0.12, 460);
    this.anim('happy', [
      [1, 90, Ease.out],
      [1, 650],
      [0, 320, Ease.inOut],
    ]);
    this.burst(8, 0.75);
    this.ring(0.7);
    return 'poke';
  }

  /* ---------- particles (positions in body radii, relative to the center) ---------- */
  private pal(): RGB[] {
    return [mixC(this.c2, WHITE, 0.45), mixC(this.c1, WHITE, 0.4), COOL];
  }
  burst(n: number, power: number) {
    if (this.reduced) return;
    const pal = this.pal();
    for (let i = 0; i < n; i++) {
      const a = this.rand(0, TAU),
        sp = this.rand(1.1, 2.9) * power;
      this.particles.push({
        type: 'spark',
        x: Math.cos(a) * 0.9,
        y: Math.sin(a) * 0.9,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        drag: 2.6,
        g: 0.5,
        age: 0,
        life: this.rand(0.7, 1.25),
        size: this.rand(0.06, 0.12),
        rot: this.rand(-0.4, 0.4),
        vr: this.rand(-2, 2),
        col: pal[i % 3]!,
      });
    }
  }
  ring(power: number) {
    if (this.reduced) return;
    this.particles.push({
      type: 'ring',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      drag: 0,
      g: 0,
      age: 0,
      life: 0.75,
      size: 0,
      r0: 1,
      grow: 0.9 * power,
      col: mixC(this.c2, WHITE, 0.4),
      rot: 0,
      vr: 0,
    });
  }
  private emit(dt: number) {
    const cfg = this.cfg,
      T = this.timers,
      pal = this.pal();
    const still = { drag: 0, g: 0, age: 0, rot: 0, vr: 0 };
    if (cfg.beat) {
      T.beat -= dt;
      if (T.beat <= 0) {
        T.beat = 0.48;
        this.kick(-0.34);
        this.beatGlow = 1;
        for (let i = 0; i < (this.mini ? 1 : 3); i++)
          this.particles.push({
            ...still,
            type: 'ember',
            x: this.rand(-0.5, 0.5),
            y: this.rand(-0.75, -0.55),
            vx: this.rand(-0.6, 0.6),
            vy: this.rand(-1.7, -0.9),
            drag: 1.4,
            g: 1.2,
            life: this.rand(0.6, 1),
            size: this.rand(0.025, 0.05),
            col: pal[i % 2]!,
          });
      }
    }
    if (cfg.zz) {
      T.zz -= dt;
      if (T.zz <= 0) {
        T.zz = 1.6;
        this.particles.push({
          ...still,
          type: 'z',
          x: 0.55,
          y: -0.7,
          vx: 0.28,
          vy: -0.42,
          drag: 0.2,
          life: 2.6,
          size: this.mini ? 0.32 : 0.22,
          col: [201, 178, 255],
          rot: 0.15,
        });
      }
    }
    if (cfg.ripple) {
      T.ripple -= dt;
      if (T.ripple <= 0) {
        T.ripple = 1.15;
        this.particles.push({
          ...still,
          type: 'ring',
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          life: 1.3,
          size: 0,
          r0: 1.05,
          grow: 0.7,
          col: mixC(this.c1, WHITE, 0.5),
        });
      }
    }
    if (cfg.sparkle) {
      T.sparkle -= dt;
      if (T.sparkle <= 0) {
        T.sparkle = this.rand(0.15, 0.4);
        const a = this.rand(0, TAU),
          r = this.rand(1.2, 1.9);
        this.particles.push({
          ...still,
          type: 'spark',
          x: Math.cos(a) * r,
          y: Math.sin(a) * r * 0.9,
          vx: 0,
          vy: -0.15,
          life: this.rand(0.6, 1.1),
          size: this.rand(0.05, 0.1),
          col: pal[Math.floor(this.random() * 3)]!,
          vr: this.rand(-1, 1),
        });
      }
    }
    if (cfg.think) {
      T.think -= dt;
      if (T.think <= 0) {
        T.think = 0.85;
        this.particles.push({
          ...still,
          type: 'ember',
          x: 0.72,
          y: -0.82,
          vx: 0.18,
          vy: -0.4,
          drag: 0.6,
          life: 1.4,
          size: this.rand(0.035, 0.06),
          col: pal[1]!,
        });
      }
    }
  }

  private target(base: RGB, tintScale: number): RGB {
    const cfg = this.cfg;
    return mulC(cfg.tint ? mixC(base, cfg.tint, cfg.tintAmt * tintScale) : base, cfg.dim);
  }

  /* ---------- simulation ---------- */
  /** Advances the simulation by `dt` seconds. `look` is the pointer direction, if any. */
  update(dt: number, look: Look | null = null) {
    dt = clamp(dt, 0, 0.1);
    const reduced = this.reduced;
    this.clock += dt;
    if (!reduced) this.t += dt;
    const t = this.t,
      cfg = this.cfg,
      c = this.cur;
    this.runTweens();

    const k = damp(4, dt);
    for (const key of SMOOTH_KEYS) c[key] = lerp(c[key], cfg[key], k);
    const ke = damp(7, dt);
    for (const key of Object.keys(this.eye) as (keyof EyePose)[])
      this.eye[key] = lerp(this.eye[key], cfg.eye[key], ke);
    const kc = damp(3.5, dt);
    this.c1 = mixC(this.c1, this.target(this.base1, 1), kc);
    this.c2 = mixC(this.c2, this.target(this.base2, 0.75), kc);

    // Where to look: the pointer, else an idle wander; moods bias it.
    let tx: number, ty: number;
    if (look) {
      tx = look.x;
      ty = look.y;
    } else if (reduced) {
      tx = 0.12;
      ty = 0.06;
    } else {
      this.wander.t -= dt;
      if (this.wander.t <= 0) {
        this.wander.t = this.rand(1.2, 3.4);
        this.wander.x = this.rand(-0.55, 0.55);
        this.wander.y = this.rand(-0.35, 0.35);
        if (this.random() < 0.3) this.wander.x = this.wander.y = 0;
      }
      tx = this.wander.x;
      ty = this.wander.y;
    }
    if (cfg.look) {
      tx = lerp(tx, cfg.look[0], 0.78);
      ty = lerp(ty, cfg.look[1], 0.78);
      if (cfg.think) {
        tx += Math.sin(t * 0.9) * 0.1;
        ty += Math.sin(t * 1.4) * 0.05;
      }
    }
    if (cfg.wobble) {
      tx = Math.cos(t * 5.5) * 0.7;
      ty = Math.sin(t * 5.5) * 0.5;
    }
    let tPitch = -ty * 0.46;
    if (this.moodName === 'listening') tPitch += Math.sin(t * 2.4) * 0.06;
    const kl = reduced ? 1 : damp(this.mini ? 7 : 6, dt);
    this.yaw = lerp(this.yaw, tx * 0.62, kl);
    this.pitch = lerp(this.pitch, tPitch, kl);
    const yv = dt > 0 ? (this.yaw - this.prevYaw) / dt : 0;
    this.prevYaw = this.yaw;
    this.yawVel = lerp(this.yawVel, yv, damp(10, dt));

    // Lean into turns, plus the mood's own tilt.
    let rT = c.roll + clamp(this.yawVel * 0.07, -0.2, 0.2);
    if (cfg.wobble) rT += Math.sin(t * 6.5) * 0.22;
    if (this.moodName === 'waiting_approval') rT += Math.sin(t * 1.3) * 0.05;
    this.roll = reduced ? c.roll : lerp(this.roll, rT, damp(5, dt));

    // Curious hop: a bounce with a squash on each contact.
    const s = Math.sin(t * PI * 1.5);
    this.bounceY = -Math.abs(s) * 0.09 * c.bounce;
    if (c.bounce > 0.2 && s < 0 !== this.prevBounceS < 0) this.kick(-0.17 * c.bounce);
    this.prevBounceS = s;

    // Jelly spring, sub-stepped for stability at any frame rate.
    let rem = dt;
    while (rem > 1e-6) {
      const h = Math.min(rem, 1 / 240);
      this.qv += (-180 * this.q - 10 * this.qv) * h;
      this.q += this.qv * h;
      rem -= h;
    }
    this.q = clamp(this.q, -0.35, 0.35);

    if (!reduced) {
      // Blinks every 3 to 6 seconds, sometimes twice.
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) {
        if (this.eye.closed < 0.5 && !cfg.wobble) {
          this.blink();
          if (this.random() < 0.22) this.doubleBlink = 0.3;
        }
        this.nextBlink = this.rand(3, 6);
      }
      if (this.doubleBlink > 0) {
        this.doubleBlink -= dt;
        if (this.doubleBlink <= 0) this.blink();
      }
      this.orbitPhase += dt * c.orbit;
      for (const m of this.motes) m.a += m.s * dt * (0.35 + c.orbit * 0.22);
      if (cfg.flicker && this.random() < dt * 1.4) this.flick = 0.55;
      this.emit(dt);
    }
    this.beatGlow *= Math.exp(-6 * dt);
    this.flick = lerp(this.flick, 1, damp(9, dt));

    for (const p of this.particles) {
      p.age += dt;
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr;
      p.vy = p.vy * dr + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    if (this.particles.length) this.particles = this.particles.filter((p) => p.age < p.life);

    if (this.moodName === 'dizzy' && this.clock > this.dizzyUntil) {
      this.setMood(this.baseMood === 'dizzy' ? 'idle' : this.baseMood);
      this.anim('spin', [
        [-0.12, 110, Ease.out],
        [0.08, 130],
        [0, 260, Ease.out],
      ]);
      this.doubleBlink = 0.35;
    }
  }

  /* ---------- rendering ---------- */
  /** Draws the Muse in a `size` CSS-pixel box of a context already scaled for the DPR. */
  render(ctx: CanvasRenderingContext2D, size: number, o: RenderOptions = {}) {
    const cx = o.cx ?? size / 2,
      cy = o.cy ?? size / 2;
    const Rb = size * (o.rf ?? (this.mini ? 0.24 : 0.27));
    const R = Rb;
    const c = this.cur,
      t = this.t;
    const bob = (Math.sin(t * 1.25) * 0.045 * c.float + this.p.hop + this.bounceY + c.sink) * Rb;
    const x0 = cx + this.yaw * 0.06 * Rb,
      y0 = cy + bob - this.pitch * 0.04 * Rb;
    this.lastR = R;
    this.lastCx = x0;
    this.lastCy = y0;
    const sb = 1 + Math.sin(t * c.breatheRate) * c.breathe;
    const sx = sb * (1 - this.q * 0.7),
      sy = sb * (1 + this.q);
    const glow = c.glow * (1 + this.beatGlow * 0.28) * this.flick;
    const maxR = o.maxR ?? Math.min(cx, cy, size - cx, size - cy);
    const rot = this.roll + this.p.spin;

    ctx.save();
    ctx.translate(x0, y0);
    this.drawAura(ctx, R, glow, maxR - Math.abs(x0 - cx) - Math.abs(y0 - cy) - 1);
    ctx.rotate(rot);
    const orbit = this.computeOrbit(R);
    this.drawOrbit(ctx, orbit, false, glow);
    ctx.save();
    ctx.scale(sx, sy);
    this.drawNebula(ctx, R, glow);
    ctx.restore();
    this.drawOrbit(ctx, orbit, true, glow);
    ctx.restore();
    if (this.particles.length) this.drawParticles(ctx, cx, cy + c.sink * Rb, Rb);
  }

  private drawAura(ctx: CanvasRenderingContext2D, R: number, glow: number, maxR: number) {
    const rr = Math.min(R * (this.mini ? 2.1 : 2.5), maxR);
    if (rr <= R * 0.8) return;
    const a = clamp(glow, 0, 2),
      mid = mixC(this.c1, this.c2, 0.45);
    const g = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, rr);
    g.addColorStop(0, rgba(mid, 0.3 * a));
    g.addColorStop(0.35, rgba(this.c1, 0.12 * a));
    g.addColorStop(1, rgba(this.c1, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  private computeOrbit(R: number): OrbitSpark[] {
    const out: OrbitSpark[] = [],
      c = this.cur;
    const a = R * (this.mini ? 1.45 : 1.62) * c.orbitR,
      b = R * 0.36 * c.orbitR,
      tl = -0.32;
    const ct = Math.cos(tl),
      st = Math.sin(tl);
    for (let i = 0; i < this.nSparks; i++) {
      const th =
        this.orbitPhase +
        (i * TAU) / this.nSparks +
        (this.cfg.wobble ? Math.sin(this.t * 3 + i) * 0.5 : 0);
      const ox = Math.cos(th) * a,
        oz = Math.sin(th),
        oy = oz * b;
      const x = ox * ct - oy * st;
      let y = ox * st + oy * ct;
      y += c.sag * R * (0.26 + 0.08 * Math.sin(th * 2));
      y += Math.sin(this.t * 2 + i * 1.7) * R * 0.035;
      const sc = 0.76 + 0.3 * oz;
      const tw = 0.86 + 0.14 * Math.sin(this.t * 4 + i * 2.1);
      out.push({
        x,
        y,
        z: oz,
        r: R * (this.mini ? 0.13 : 0.085) * sc * tw,
        a: 0.45 + 0.55 * (oz * 0.5 + 0.5),
        rot: Math.sin(this.t * 0.8 + i) * 0.25,
      });
    }
    return out;
  }
  private drawOrbit(
    ctx: CanvasRenderingContext2D,
    orbit: OrbitSpark[],
    front: boolean,
    glow: number,
  ) {
    const col = mixC(this.c2, WHITE, 0.3),
      ga = clamp(glow, 0.45, 1.3);
    for (const s of orbit) {
      if (s.z > 0 !== front) continue;
      drawSpark(ctx, s.x, s.y, s.r, s.rot, col, s.a * (front ? 1 : 0.6) * ga, 1);
    }
  }

  /** Direction A, Nebula: a soft plasma orb in a cloud of drifting motes. */
  private drawNebula(ctx: CanvasRenderingContext2D, R: number, glow: number) {
    const c1 = this.c1,
      c2 = this.c2,
      t = this.t;
    ctx.globalCompositeOperation = 'lighter';
    const mc = mixC(c2, WHITE, 0.35),
      ga = clamp(glow, 0.3, 1.6);
    for (const m of this.motes) {
      const x = Math.cos(m.a) * m.r * R,
        y = Math.sin(m.a) * m.r * R * 0.82 + Math.sin(t * m.f + m.ph) * R * 0.06;
      const al =
        (0.18 + 0.5 * Math.pow(Math.sin(t * m.tw + m.ph), 2)) * ga * clamp((1.95 - m.r) * 2.2);
      const rr = R * 0.016 * m.size * (this.mini ? 1.8 : 1);
      ctx.fillStyle = rgba(mc, al * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, rr * 2.4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(mc, al * 0.85);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    const body = new Path2D();
    body.arc(0, 0, R, 0, TAU);
    const fx = this.yaw * 0.3 * R,
      fy = -this.pitch * 0.3 * R;
    const g = ctx.createRadialGradient(fx, fy, 0, 0, 0, R * 1.02);
    g.addColorStop(0, rgba(mixC(c1, INK, 0.62)));
    g.addColorStop(0.5, rgba(mixC(c1, INK, 0.4)));
    g.addColorStop(0.8, rgba(mixC(c1, c2, 0.25)));
    g.addColorStop(1, rgba(mixC(c2, WHITE, 0.1)));
    ctx.fillStyle = g;
    ctx.fill(body);

    ctx.save();
    ctx.clip(body);
    ctx.globalCompositeOperation = 'lighter';
    // Swirling plasma, kept towards the rim so the face stays readable.
    for (let i = 0; i < 3; i++) {
      const a = t * (0.35 + i * 0.12) + i * 2.1,
        bx = Math.cos(a) * R * 0.78,
        by = Math.sin(a) * R * 0.78;
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, R * 0.6);
      bg.addColorStop(0, rgba(i === 1 ? c1 : c2, 0.13 * ga));
      bg.addColorStop(1, rgba(c2, 0));
      ctx.fillStyle = bg;
      ctx.fillRect(-R * 1.4, -R * 1.4, R * 2.8, R * 2.8);
    }
    // Fresnel rim.
    const rimGlow = clamp(glow, 0.4, 1.4);
    const rim = ctx.createRadialGradient(fx * 0.3, fy * 0.3, R * 0.62, 0, 0, R * 1.02);
    rim.addColorStop(0, rgba(c2, 0));
    rim.addColorStop(0.7, rgba(c2, 0.22 * rimGlow));
    rim.addColorStop(1, rgba(mixC(c2, WHITE, 0.4), 0.8 * rimGlow));
    ctx.fillStyle = rim;
    ctx.fillRect(-R * 1.4, -R * 1.5, R * 2.8, R * 2.9);
    // Bounce light from below.
    const bl = ctx.createRadialGradient(0, R * 0.9, 0, 0, R * 0.9, R * 0.95);
    bl.addColorStop(0, rgba(c2, 0.42 * ga));
    bl.addColorStop(1, rgba(c2, 0));
    ctx.fillStyle = bl;
    ctx.fillRect(-R * 1.4, -R * 0.2, R * 2.8, R * 1.6);
    // Specular highlight, drifting against the head turn.
    ctx.save();
    ctx.translate(-R * 0.38 - this.yaw * R * 0.2, -R * 0.46 + this.pitch * R * 0.15);
    ctx.rotate(-0.6);
    ctx.scale(1, 0.62);
    const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.28);
    hg.addColorStop(0, 'rgba(255,255,255,0.5)');
    hg.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.28, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    this.drawEyes(ctx, R, R * 0.9);
    ctx.restore();
  }

  /** Eyes placed on a sphere, so yaw and pitch shift and foreshorten them. */
  private drawEyes(ctx: CanvasRenderingContext2D, R: number, faceR: number) {
    const E = this.eye;
    const mul = (this.mini ? 1.45 : 1) * E.size;
    const eyeCol = this.eyeLight ? COOL : INK;
    const glowCol = mixC(WHITE, this.c2, 0.35);
    const open = clamp(this.p.blink);
    for (const side of [-1, 1]) {
      let ey = side * 0.35 + this.yaw * 0.95,
        ep = 0.04 + this.pitch * 0.9;
      if (E.ring > 0.05) {
        ey += Math.cos(this.t * 8 + side * 1.3) * 0.06 * E.ring;
        ep += Math.sin(this.t * 8 + side * 1.3) * 0.06 * E.ring;
      }
      const cyw = Math.cos(ey),
        cp = Math.cos(ep);
      if (cyw < 0.12) continue;
      const x = Math.sin(ey) * cp * faceR,
        y = -Math.sin(ep) * faceR;
      const sm = mul * (1 + side * E.asym);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(Math.max(0.2, cyw), Math.max(0.3, cp));
      this.drawEye(ctx, side, 0.2 * R * sm, 0.31 * R * sm, R, open, eyeCol, glowCol);
      ctx.restore();
    }
  }
  private drawEye(
    ctx: CanvasRenderingContext2D,
    side: number,
    w: number,
    h: number,
    R: number,
    open: number,
    eyeCol: RGB,
    glowCol: RGB,
  ) {
    const E = this.eye,
      t = this.t,
      light = this.eyeLight,
      m = Math.max(w, h);
    const happy = this.p.happy * (1 - E.star) * (1 - E.closed);
    if (light) {
      // A soft dark backing keeps glowing eyes readable on a bright body.
      const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, m * 1.3);
      bg.addColorStop(0, `rgba(16,6,44,${this.mini ? 0.3 : 0.2})`);
      bg.addColorStop(1, 'rgba(16,6,44,0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(0, 0, m * 1.3, 0, TAU);
      ctx.fill();
      const ga =
        0.38 * clamp(this.cur.glow, 0.3, 1.5) * (0.35 + 0.65 * open) * (1 - E.closed * 0.6);
      const gg = ctx.createRadialGradient(0, 0, 0, 0, 0, m * 1.5);
      gg.addColorStop(0, rgba(glowCol, ga));
      gg.addColorStop(1, rgba(glowCol, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(0, 0, m * 1.5, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    const lid = clamp(E.lid - happy * 0.4, 0, 0.9),
      smile = clamp(E.smile + happy * 0.8, 0, 1),
      tilt = E.tilt * side;
    const nA = (1 - E.star) * (1 - E.closed) * (1 - E.ring);
    const lw = R * (this.mini ? 0.085 : 0.055);
    if (nA > 0.01) {
      const hh = Math.max(h * 0.5 * open, R * 0.014);
      ctx.save();
      if (lid > 0.005 || Math.abs(tilt) > 0.005) {
        const top = -hh + lid * 2 * hh;
        ctx.beginPath();
        ctx.moveTo(-w * 2, top - tilt * w * 2);
        ctx.lineTo(w * 2, top + tilt * w * 2);
        ctx.lineTo(w * 2, h * 3);
        ctx.lineTo(-w * 2, h * 3);
        ctx.closePath();
        ctx.clip();
      }
      if (smile > 0.005) {
        const cr = w * 1.1;
        ctx.beginPath();
        ctx.rect(-w * 3, -h * 3, w * 6, h * 6);
        ctx.arc(0, hh + cr - smile * hh * 1.4, cr, 0, TAU, true);
        ctx.clip('evenodd');
      }
      ctx.globalAlpha = nA;
      if (light) {
        const eg = ctx.createRadialGradient(-w * 0.12, -hh * 0.3, 0, 0, 0, Math.max(w * 0.5, hh));
        eg.addColorStop(0, '#ffffff');
        eg.addColorStop(1, rgba(mixC(eyeCol, glowCol, 0.25)));
        ctx.fillStyle = eg;
      } else ctx.fillStyle = rgba(eyeCol);
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.5, hh, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.lineCap = 'round';
    if (E.closed > 0.01) {
      ctx.globalAlpha = E.closed;
      ctx.beginPath();
      ctx.arc(0, -h * 0.12, w * 0.62, PI * 0.18, PI * 0.82);
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(eyeCol);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (E.star > 0.01) {
      // Success: the eyes become four-point sparks.
      ctx.globalAlpha = E.star;
      const sr = m * 0.82 * (0.4 + 0.6 * E.star) * (1 + 0.07 * Math.sin(t * 5 + side));
      sparkPath(ctx, 0, 0, sr, Math.sin(t * 1.5 + side) * 0.12, 0.22);
      ctx.fillStyle = rgba(light ? WHITE : eyeCol);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (E.ring > 0.01) {
      ctx.globalAlpha = E.ring;
      const rr = m * 0.4,
        a0 = t * 9 * side;
      ctx.beginPath();
      ctx.arc(0, 0, rr, a0, a0 + PI * 1.45);
      ctx.lineWidth = lw * 0.9;
      ctx.strokeStyle = rgba(eyeCol);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, lw * 0.6, 0, TAU);
      ctx.fillStyle = rgba(eyeCol);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
    for (const p of this.particles) {
      const k = p.age / p.life,
        a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const x = cx + p.x * R,
        y = cy + p.y * R;
      if (p.type === 'spark')
        drawSpark(ctx, x, y, p.size * R * (1 - k * 0.4), p.rot, p.col, a, 0.8);
      else if (p.type === 'ember') {
        ctx.globalCompositeOperation = 'lighter';
        const er = p.size * R * 3,
          eg = ctx.createRadialGradient(x, y, 0, x, y, er);
        eg.addColorStop(0, rgba(mixC(p.col, WHITE, 0.5), a));
        eg.addColorStop(0.3, rgba(p.col, a * 0.45));
        eg.addColorStop(1, rgba(p.col, 0));
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(x, y, er, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      } else if (p.type === 'ring') {
        const rr = R * ((p.r0 ?? 1) + (p.grow ?? 0) * Ease.out(k));
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TAU);
        ctx.lineWidth = Math.max(0.6, R * 0.025 * (1 - k));
        ctx.strokeStyle = rgba(p.col, (1 - k) * 0.45);
        ctx.stroke();
      } else {
        const s = p.size * R * (0.6 + k * 0.7);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot + Math.sin(p.age * 2) * 0.15);
        ctx.beginPath();
        ctx.moveTo(-s / 2, -s / 2);
        ctx.lineTo(s / 2, -s / 2);
        ctx.lineTo(-s / 2, s / 2);
        ctx.lineTo(s / 2, s / 2);
        ctx.lineWidth = Math.max(1, s * 0.17);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(p.col, a * 0.9);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}
