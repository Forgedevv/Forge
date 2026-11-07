import { useRef } from 'react';
import { EffectLayer, FillCanvas } from './lib/CanvasLayer';
import { mixRgb, rgbCss, useEffectColors, type EffectColors } from './lib/color';
import { easeFactor } from './lib/pointer';
import type { BackgroundProps } from './lib/ShaderBackground';
import { useCanvasScene, useLatest } from './lib/useCanvasScene';

export interface DotGridProps extends BackgroundProps {
  /** Distance between dots, in CSS pixels. */
  spacing?: number;
  /** Radius of a resting dot, in CSS pixels. */
  dotSize?: number;
  /** Radius of the glow around the pointer, in CSS pixels. */
  glowRadius?: number;
  /** The glow follows the pointer; otherwise it wanders on its own. */
  followPointer?: boolean;
}

const LEVELS = 10;

interface DotGridCanvasProps {
  inView: boolean;
  colors?: EffectColors;
  spacing: number;
  dotSize: number;
  glowRadius: number;
  followPointer: boolean;
}

function DotGridCanvas({ inView, colors, followPointer, ...settings }: DotGridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useEffectColors(colors);
  const live = useLatest({ theme, ...settings });

  useCanvasScene(
    canvasRef,
    ({ ctx, pointer }) => {
      let width = 0;
      let height = 0;
      const glow = { x: 0, y: 0, placed: false };
      return {
        resize(w, h) {
          width = w;
          height = h;
        },
        draw(time, dt) {
          const { theme: c, spacing, dotSize, glowRadius } = live.current;
          ctx.clearRect(0, 0, width, height);
          const idle = {
            x: width * (0.5 + 0.3 * Math.sin(time * 0.21)),
            y: height * (0.5 + 0.26 * Math.sin(time * 0.29 + 1.3)),
          };
          const target = pointer?.inside ? pointer : idle;
          const k = dt === 0 || !glow.placed ? 1 : easeFactor(pointer?.inside ? 8 : 2, dt);
          glow.x += (target.x - glow.x) * k;
          glow.y += (target.y - glow.y) * k;
          glow.placed = true;

          // Soft light under the dots.
          const halo = ctx.createRadialGradient(
            glow.x,
            glow.y,
            0,
            glow.x,
            glow.y,
            glowRadius * 1.3,
          );
          halo.addColorStop(0, rgbCss(c.primary, 0.16));
          halo.addColorStop(1, rgbCss(c.primary, 0));
          ctx.fillStyle = halo;
          ctx.fillRect(0, 0, width, height);

          const gap = Math.max(8, spacing);
          const ox = (width % gap) / 2;
          const oy = (height % gap) / 2;
          const buckets: number[][] = Array.from({ length: LEVELS }, () => []);
          ctx.beginPath();
          for (let y = oy; y <= height; y += gap) {
            for (let x = ox; x <= width; x += gap) {
              const d = Math.hypot(x - glow.x, y - glow.y);
              const near = 1 - d / glowRadius;
              if (near <= 0) {
                ctx.moveTo(x + dotSize, y);
                ctx.arc(x, y, dotSize, 0, Math.PI * 2);
                continue;
              }
              // A ripple running outwards through the lit dots.
              const ripple = 0.8 + 0.2 * Math.sin(d * 0.06 - time * 3);
              const level = Math.min(LEVELS - 1, Math.floor(near ** 1.4 * ripple * LEVELS));
              buckets[level]?.push(x, y);
            }
          }
          ctx.fillStyle = rgbCss(c.text, 0.17);
          ctx.fill();
          buckets.forEach((points, level) => {
            if (points.length === 0) return;
            const t = (level + 1) / LEVELS;
            const r = dotSize * (1 + t * 1.5);
            ctx.beginPath();
            for (let i = 0; i < points.length; i += 2) {
              const x = points[i] ?? 0;
              const y = points[i + 1] ?? 0;
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.fillStyle = rgbCss(mixRgb(c.primary, c.accent, t * t), 0.25 + t * 0.75);
            ctx.fill();
          });
        },
      };
    },
    { inView, followPointer },
  );
  return <FillCanvas ref={canvasRef} />;
}

/**
 * Dot grid with a pointer glow: a quiet grid of small dots in the text colour; around the pointer
 * (or a slowly wandering light when the pointer is away) the dots swell and light up in the primary
 * and accent colours, with a soft ripple. Light and techy; a hero, a features grid or a footer.
 */
export function DotGrid({
  spacing = 24,
  dotSize = 1.2,
  glowRadius = 170,
  followPointer = true,
  colors,
  className,
  style,
}: DotGridProps) {
  return (
    <EffectLayer
      className={className}
      style={style}
      fallback={
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'radial-gradient(circle, color-mix(in srgb, var(--color-text) 18%, transparent) 1.2px, transparent 1.6px)',
            backgroundSize: `${spacing}px ${spacing}px`,
          }}
        />
      }
    >
      {({ inView }) => (
        <DotGridCanvas
          inView={inView}
          colors={colors}
          spacing={spacing}
          dotSize={dotSize}
          glowRadius={glowRadius}
          followPointer={followPointer}
        />
      )}
    </EffectLayer>
  );
}
