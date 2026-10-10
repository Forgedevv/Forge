/** Small math, easing and color helpers shared by the Muse renderers. */

export const TAU = Math.PI * 2;
export const PI = Math.PI;

export type RGB = [number, number, number];
export type Easing = (t: number) => number;

export const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent smoothing factor for an exponential approach at `rate` per second. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export const Ease = {
  lin: (t: number) => t,
  in: (t: number) => t * t * t,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  bounce: (t: number) => {
    const n = 7.5625,
      d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
} satisfies Record<string, Easing>;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses `#rgb` or `#rrggbb`; returns `fallback` for anything else. */
export function hexRGB(hex: string, fallback: RGB = [155, 92, 255]): RGB {
  const match = HEX.exec(hex.trim());
  if (!match) return [...fallback];
  let h = match[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX.test(value.trim());

export const mixC = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export const mulC = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
export const rgba = (c: RGB, a = 1) =>
  `rgba(${clamp(c[0], 0, 255) | 0},${clamp(c[1], 0, 255) | 0},${clamp(c[2], 0, 255) | 0},${clamp(a).toFixed(3)})`;

/** WCAG relative luminance of an sRGB color (0 to 1). */
export function luminance(c: RGB) {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

export const WHITE: RGB = [255, 255, 255];
export const COOL: RGB = [242, 240, 255];
export const INK: RGB = [24, 12, 50];

/** The FORGE four-point spark, with concave sides. */
export function sparkPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rot = 0,
  pinch = 0.2,
) {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = rot + (i * PI) / 2,
      b = a + PI / 4,
      c = a + PI / 2;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.quadraticCurveTo(
      x + Math.cos(b) * r * pinch,
      y + Math.sin(b) * r * pinch,
      x + Math.cos(c) * r,
      y + Math.sin(c) * r,
    );
  }
  ctx.closePath();
}

/** A four-point spark with an optional additive halo. */
export function drawSpark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rot: number,
  col: RGB,
  alpha: number,
  glow = 1,
) {
  if (alpha <= 0.01 || r <= 0.2) return;
  if (glow > 0) {
    const gr = r * 2.3,
      g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, rgba(col, 0.5 * alpha * glow));
    g.addColorStop(1, rgba(col, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  sparkPath(ctx, x, y, r, rot, 0.2);
  ctx.fillStyle = rgba(mixC(col, WHITE, 0.7), alpha);
  ctx.fill();
}
