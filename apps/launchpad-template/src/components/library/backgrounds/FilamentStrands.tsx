import { useRef } from 'react';
import { EffectLayer, FillCanvas } from './lib/CanvasLayer';
import { isDarkColor, mixRgb, rgbCss, useEffectColors, type EffectColors } from './lib/color';
import { easeFactor } from './lib/pointer';
import type { BackgroundProps } from './lib/ShaderBackground';
import { useCanvasScene, useLatest } from './lib/useCanvasScene';

export interface FilamentStrandsProps extends BackgroundProps {
  /** Number of strands, 40 to 260. */
  count?: number;
  /** `vertical`: the sheaf rises from the bottom; `horizontal`: it crosses the box (a divider). */
  orientation?: 'vertical' | 'horizontal';
  /** Where the strands pinch together, 0 to 1 along the sheaf. */
  waist?: number;
  /** The strands part around the pointer. */
  followPointer?: boolean;
}

interface Strand {
  /** Position across the sheaf at the root, 0 to 1. */
  u: number;
  seed: number;
  width: number;
  pulse: boolean;
}

function seeded(i: number, salt: number): number {
  const n = Math.sin(i * 91.7 + salt * 47.3) * 24634.6345;
  return n - Math.floor(n);
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

interface FilamentCanvasProps {
  inView: boolean;
  colors?: EffectColors;
  count: number;
  orientation: 'vertical' | 'horizontal';
  waist: number;
  followPointer: boolean;
}

function FilamentCanvas({
  inView,
  colors,
  count,
  orientation,
  waist,
  followPointer,
}: FilamentCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useEffectColors(colors);
  const live = useLatest({ theme, waist });

  useCanvasScene(
    canvasRef,
    ({ ctx, pointer }) => {
      let width = 0;
      let height = 0;
      const n = Math.max(40, Math.min(260, Math.round(count)));
      const strands: Strand[] = Array.from({ length: n }, (_, i) => ({
        u: (i + seeded(i, 1) * 0.8) / n,
        seed: seeded(i, 2),
        width: 0.45 + seeded(i, 3) * 0.75,
        pulse: seeded(i, 4) > 0.82,
      }));
      // Pointer in sheaf coordinates (along, across), eased.
      const push = { along: 0.5, across: -2, strength: 0 };
      const toScreen = (along: number, across: number): [number, number] =>
        orientation === 'vertical'
          ? [across * width, along * height]
          : [along * width, across * height];

      return {
        resize(w, h) {
          width = w;
          height = h;
        },
        draw(time, dt) {
          const { theme: c, waist: w0 } = live.current;
          const dark = isDarkColor(c.background);
          ctx.clearRect(0, 0, width, height);
          if (pointer && width > 0 && height > 0) {
            const along = orientation === 'vertical' ? pointer.y / height : pointer.x / width;
            const across = orientation === 'vertical' ? pointer.x / width : pointer.y / height;
            const k = dt === 0 ? 1 : easeFactor(5, dt);
            push.along += (along - push.along) * k;
            push.across += (across - push.across) * k;
            push.strength += ((pointer.inside ? 1 : 0) - push.strength) * k;
          }
          const [wx, wy] = toScreen(w0, 0.5);
          const glow = ctx.createRadialGradient(wx, wy, 0, wx, wy, Math.min(width, height) * 0.45);
          glow.addColorStop(0, rgbCss(c.primary, dark ? 0.22 : 0.14));
          glow.addColorStop(1, rgbCss(c.primary, 0));
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, width, height);

          ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          ctx.lineCap = 'round';
          for (const s of strands) {
            const sway = Math.sin(time * 0.45 + s.seed * 6.28) * 0.035;
            const sway2 = Math.cos(time * 0.37 + s.seed * 9.1) * 0.03;
            const rootAcross = 0.06 + 0.88 * s.u;
            const tipAcross = 0.5 - (s.u - 0.5) * 0.98;
            const waistAcross = 0.5 + (s.u - 0.5) * 0.07;
            let c1 = rootAcross + (waistAcross - rootAcross) * 0.9 + sway;
            let c2 = tipAcross + (waistAcross - tipAcross) * 0.9 + sway2;
            if (push.strength > 0.01) {
              // Part the strands around the pointer.
              const away = (v: number, along: number) => {
                const d = v - push.across;
                const fall = Math.exp(-((along - push.along) ** 2) * 18 - d * d * 60);
                return v + Math.sign(d || 1) * fall * 0.09 * push.strength;
              };
              c1 = away(c1, w0 + 0.17);
              c2 = away(c2, w0 - 0.17);
            }
            const p0 = toScreen(1.06, rootAcross);
            const p1 = toScreen(w0 + 0.17, c1);
            const p2 = toScreen(w0 - 0.17, c2);
            const p3 = toScreen(-0.06, tipAcross);
            const tint = mixRgb(c.primary, c.accent, s.u);
            ctx.beginPath();
            ctx.moveTo(p0[0], p0[1]);
            ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
            ctx.strokeStyle = rgbCss(tint, (dark ? 0.16 : 0.22) + s.seed * 0.14);
            ctx.lineWidth = s.width;
            ctx.stroke();
            if (!s.pulse) continue;
            // A spark of light travelling along the strand.
            const head = (time * (0.07 + s.seed * 0.06) + s.seed) % 1;
            ctx.beginPath();
            for (let k = 0; k <= 6; k++) {
              const t = Math.max(0, head - k * 0.008);
              const x = bezier(p0[0], p1[0], p2[0], p3[0], t);
              const y = bezier(p0[1], p1[1], p2[1], p3[1], t);
              if (k === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = rgbCss(mixRgb(tint, c.text, dark ? 0.35 : 0), 0.85);
            ctx.lineWidth = s.width + 0.9;
            ctx.stroke();
          }
          ctx.globalCompositeOperation = 'source-over';
        },
      };
    },
    { inView, followPointer, deps: [count, orientation] },
  );
  return <FillCanvas ref={canvasRef} />;
}

/**
 * Filament strands: a sheaf of hundreds of fine translucent fibres rising from the bottom of the box,
 * pinching together in the middle and fanning out again, swaying gently, with sparks of light
 * travelling along them; the strands part around the pointer. Organic and premium; a hero visual,
 * or set `orientation="horizontal"` for a striking section divider.
 */
export function FilamentStrands({
  count = 150,
  orientation = 'vertical',
  waist = 0.5,
  followPointer = true,
  colors,
  className,
  style,
}: FilamentStrandsProps) {
  const vertical = orientation === 'vertical';
  return (
    <EffectLayer
      className={className}
      style={style}
      fallback={
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: vertical
              ? 'conic-gradient(from 160deg at 50% 50%, transparent 0deg, color-mix(in srgb, var(--color-primary) 22%, transparent) 20deg, transparent 40deg, transparent 180deg, color-mix(in srgb, var(--color-accent) 22%, transparent) 200deg, transparent 220deg)'
              : 'conic-gradient(from 70deg at 50% 50%, transparent 0deg, color-mix(in srgb, var(--color-primary) 22%, transparent) 20deg, transparent 40deg, transparent 180deg, color-mix(in srgb, var(--color-accent) 22%, transparent) 200deg, transparent 220deg)',
          }}
        />
      }
    >
      {({ inView }) => (
        <FilamentCanvas
          inView={inView}
          colors={colors}
          count={count}
          orientation={orientation}
          waist={waist}
          followPointer={followPointer}
        />
      )}
    </EffectLayer>
  );
}
