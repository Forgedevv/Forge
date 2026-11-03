import { useRef } from 'react';
import { EffectLayer, FillCanvas } from './lib/CanvasLayer';
import { isDarkColor, mixRgb, rgbCss, useEffectColors, type EffectColors } from './lib/color';
import { easeFactor } from './lib/pointer';
import type { BackgroundProps } from './lib/ShaderBackground';
import { useCanvasScene, useLatest } from './lib/useCanvasScene';

export interface WovenTorusProps extends BackgroundProps {
  /** Number of threads, 16 to 90. */
  threads?: number;
  /** Turns of each thread around the tube, 2 to 14. */
  windings?: number;
  /** Size of the ring relative to the box, 0.4 to 1.2. */
  size?: number;
  /** Horizontal centre of the ring, 0 (left) to 1 (right). */
  x?: number;
  /** The ring tilts towards the pointer. */
  followPointer?: boolean;
}

const SAMPLES = 168;
const CHUNK = 7;

interface WovenCanvasProps {
  inView: boolean;
  colors?: EffectColors;
  threads: number;
  windings: number;
  size: number;
  x: number;
  followPointer: boolean;
}

function WovenCanvas({
  inView,
  colors,
  threads,
  windings,
  size,
  x,
  followPointer,
}: WovenCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useEffectColors(colors);
  const live = useLatest({ theme, size, x });

  useCanvasScene(
    canvasRef,
    ({ ctx, pointer }) => {
      let width = 0;
      let height = 0;
      const n = Math.max(16, Math.min(90, Math.round(threads)));
      const turns = Math.max(2, Math.min(14, Math.round(windings)));
      const tilt = { x: 0, y: 0 };
      const px = new Float32Array(SAMPLES + 1);
      const py = new Float32Array(SAMPLES + 1);
      const pz = new Float32Array(SAMPLES + 1);
      return {
        resize(w, h) {
          width = w;
          height = h;
        },
        draw(time, dt) {
          const { theme: c, size: s, x: cxRatio } = live.current;
          const dark = isDarkColor(c.background);
          ctx.clearRect(0, 0, width, height);
          const cx = width * cxRatio;
          const cy = height * 0.5;
          const scale = Math.min(width, height) * 0.3 * s;
          if (pointer) {
            const tx = pointer.inside ? (pointer.x / width - 0.5) * 2 : 0;
            const ty = pointer.inside ? (pointer.y / height - 0.5) * 2 : 0;
            const k = dt === 0 ? 1 : easeFactor(2.5, dt);
            tilt.x += (tx - tilt.x) * k;
            tilt.y += (ty - tilt.y) * k;
          }
          const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 1.9);
          glow.addColorStop(0, rgbCss(c.primary, dark ? 0.2 : 0.12));
          glow.addColorStop(1, rgbCss(c.primary, 0));
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, width, height);

          const yaw = -0.5 + Math.sin(time * 0.17) * 0.35 + tilt.x * 0.35;
          const pitch = 1.0 + Math.sin(time * 0.13 + 1) * 0.12 + tilt.y * 0.25;
          const cosY = Math.cos(yaw);
          const sinY = Math.sin(yaw);
          const cosP = Math.cos(pitch);
          const sinP = Math.sin(pitch);
          const flow = time * 0.22;
          const R = 1;
          const r = 0.38;
          ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          ctx.lineCap = 'round';
          for (let k = 0; k < n; k++) {
            const phase = (k / n) * Math.PI * 2;
            for (let i = 0; i <= SAMPLES; i++) {
              const u = (i / SAMPLES) * Math.PI * 2;
              const v = phase + turns * u + flow;
              const ring = R + r * Math.cos(v);
              const x0 = ring * Math.cos(u);
              const y0 = r * Math.sin(v);
              const z0 = ring * Math.sin(u);
              // Yaw around the vertical axis, then pitch towards the viewer.
              const x1 = x0 * cosY + z0 * sinY;
              const z1 = -x0 * sinY + z0 * cosY;
              const y2 = y0 * cosP - z1 * sinP;
              const z2 = y0 * sinP + z1 * cosP;
              const persp = 4.2 / (4.2 - z2);
              px[i] = cx + x1 * scale * persp;
              py[i] = cy + y2 * scale * persp;
              pz[i] = z2;
            }
            const tint = mixRgb(c.primary, c.accent, 0.5 + 0.5 * Math.sin(phase * 2 + time * 0.3));
            for (let i = 0; i < SAMPLES; i += CHUNK) {
              const end = Math.min(SAMPLES, i + CHUNK);
              const depth = ((pz[i] ?? 0) + (pz[end] ?? 0)) * 0.5;
              const front = Math.min(1, Math.max(0, (depth + 1.4) / 2.8));
              ctx.beginPath();
              ctx.moveTo(px[i] ?? 0, py[i] ?? 0);
              for (let j = i + 1; j <= end; j++) ctx.lineTo(px[j] ?? 0, py[j] ?? 0);
              ctx.strokeStyle = rgbCss(
                mixRgb(tint, c.text, front * front * (dark ? 0.45 : 0)),
                (dark ? 0.05 : 0.08) + front * front * (dark ? 0.55 : 0.6),
              );
              ctx.lineWidth = 0.5 + front * 0.9;
              ctx.stroke();
            }
          }
          ctx.globalCompositeOperation = 'source-over';
        },
      };
    },
    { inView, followPointer, fps: 45, deps: [threads, windings] },
  );
  return <FillCanvas ref={canvasRef} />;
}

/**
 * Woven torus: a ring woven from dozens of fine threads spiralling around its tube, turning slowly
 * in perspective; the threads in front glow brighter, those behind fade, and the weave flows along
 * the ring. A hypnotic, premium hero visual (place it beside the headline with `x`), or the
 * centrepiece of a "how it works" section.
 */
export function WovenTorus({
  threads = 36,
  windings = 5,
  size = 1,
  x = 0.5,
  followPointer = true,
  colors,
  className,
  style,
}: WovenTorusProps) {
  const left = `${Math.round(x * 100)}%`;
  return (
    <EffectLayer
      className={className}
      style={style}
      fallback={
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              `radial-gradient(closest-side at ${left} 50%, transparent 45%, color-mix(in srgb, var(--color-primary) 35%, transparent) 52%, transparent 62%),` +
              `radial-gradient(closest-side at ${left} 50%, color-mix(in srgb, var(--color-primary) 18%, transparent), transparent)`,
          }}
        />
      }
    >
      {({ inView }) => (
        <WovenCanvas
          inView={inView}
          colors={colors}
          threads={threads}
          windings={windings}
          size={size}
          x={x}
          followPointer={followPointer}
        />
      )}
    </EffectLayer>
  );
}
