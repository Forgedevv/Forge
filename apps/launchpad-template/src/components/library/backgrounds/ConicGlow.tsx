import type { CSSProperties } from 'react';
import { EffectLayer } from './lib/CanvasLayer';
import type { BackgroundProps } from './lib/ShaderBackground';
import { cssLength } from '../shared/cssValue';

export interface ConicGlowProps extends Omit<BackgroundProps, 'colors'> {
  /** Diameter of the halo, as a CSS length. */
  size?: string;
  /** Seconds per turn. */
  duration?: number;
  /** Horizontal centre, 0 (left) to 1 (right). */
  x?: number;
  /** Vertical centre, 0 (top) to 1 (bottom). */
  y?: number;
}

const RING_MASK = 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)';

const CSS = `
.flb-cg-spin { animation: flb-cg-spin linear infinite; }
.flb-cg-spin-back { animation: flb-cg-spin linear infinite reverse; }
@keyframes flb-cg-spin { to { transform: translate(-50%, -50%) rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .flb-cg-spin, .flb-cg-spin-back { animation: none; } }
`;

function Halo({
  running,
  size,
  duration,
  x,
  y,
}: {
  running: boolean;
  size: string;
  duration: number;
  x: number;
  y: number;
}) {
  const centre = { left: `${x * 100}%`, top: `${y * 100}%` };
  const layer = (seconds: number): CSSProperties => ({
    position: 'absolute',
    ...centre,
    width: size,
    aspectRatio: '1',
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    animationDuration: `${seconds}s`,
    animationPlayState: running ? 'running' : 'paused',
  });
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <style href="flb-conic-glow" precedence="default">
        {CSS}
      </style>
      <div
        className="flb-cg-spin"
        style={{
          ...layer(duration),
          background:
            'conic-gradient(from 0deg, var(--color-primary), transparent 22%, var(--color-accent) 40%, transparent 58%, var(--color-primary) 78%, transparent 92%, var(--color-primary))',
          filter: 'blur(40px)',
          opacity: 0.75,
        }}
      />
      <div
        className="flb-cg-spin-back"
        style={{
          ...layer(duration * 1.7),
          width: `calc(${size} * 0.72)`,
          background:
            'conic-gradient(from 90deg, transparent, var(--color-accent) 18%, transparent 36%, var(--color-primary) 60%, transparent 80%)',
          filter: 'blur(24px)',
          opacity: 0.6,
        }}
      />
      {/* Thin ring and an inner shade, so content in the centre stays readable. */}
      <div
        className="flb-cg-spin"
        style={{
          ...layer(duration * 0.8),
          width: `calc(${size} * 0.62)`,
          padding: '1px',
          background:
            'conic-gradient(from 0deg, transparent 10%, var(--color-accent), var(--color-primary) 35%, transparent 55%)',
          boxSizing: 'border-box',
          WebkitMask: RING_MASK,
          WebkitMaskComposite: 'xor',
          mask: RING_MASK,
          maskComposite: 'exclude',
          opacity: 0.8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          ...centre,
          width: `calc(${size} * 0.6)`,
          aspectRatio: '1',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          background:
            'radial-gradient(closest-side, color-mix(in srgb, var(--color-bg) 70%, transparent), transparent)',
        }}
      />
    </div>
  );
}

/**
 * Conic glow: a soft halo of the theme colours turning slowly around a point, with a thin spinning
 * ring and a calm centre for the content. Pure CSS; frames a headline, a countdown, a mint button
 * or a token logo, in hero or closing call-to-action sections.
 */
const DEFAULT_SIZE = 'min(80vmin, 34rem)';

export function ConicGlow({
  size: rawSize,
  duration = 16,
  x = 0.5,
  y = 0.5,
  className,
  style,
}: ConicGlowProps) {
  // Written into CSS: only a length expression is kept (`cssLength`).
  const props = { size: cssLength(rawSize, DEFAULT_SIZE), duration, x, y };
  return (
    <EffectLayer className={className} style={style} fallback={<Halo running={false} {...props} />}>
      {({ inView }) => <Halo running={inView} {...props} />}
    </EffectLayer>
  );
}
