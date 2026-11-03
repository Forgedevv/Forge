import { useId, type CSSProperties } from 'react';
import { EffectLayer } from './lib/CanvasLayer';
import type { BackgroundProps } from './lib/ShaderBackground';

export interface NoiseGradientProps extends Omit<BackgroundProps, 'colors'> {
  /** Grain opacity, 0 to 0.3. */
  grain?: number;
  /** Blur of the colour pools, in pixels. */
  blur?: number;
  /** Seconds for the slowest pool to cross; lower is livelier. */
  duration?: number;
}

// Durations are prime-ish ratios of each other, so the pools never repeat the same layout.
const CSS = `
.flb-ng-pool { position: absolute; width: 62%; aspect-ratio: 1; border-radius: 50%; will-change: transform; animation-timing-function: ease-in-out; animation-iteration-count: infinite; animation-direction: alternate; }
.flb-ng-a { left: -12%; top: -24%; background: radial-gradient(closest-side, var(--color-primary), transparent); animation-name: flb-ng-a; }
.flb-ng-b { right: -14%; bottom: -30%; background: radial-gradient(closest-side, var(--color-accent), transparent); animation-name: flb-ng-b; }
.flb-ng-c { left: 30%; top: 20%; width: 45%; background: radial-gradient(closest-side, color-mix(in srgb, var(--color-primary) 55%, var(--color-text)), transparent); opacity: .55; animation-name: flb-ng-c; }
@keyframes flb-ng-a { to { transform: translate(38%, 30%) scale(1.15); } }
@keyframes flb-ng-b { to { transform: translate(-36%, -24%) scale(.9); } }
@keyframes flb-ng-c { to { transform: translate(-30%, 25%) scale(1.25); } }
@media (prefers-reduced-motion: reduce) { .flb-ng-pool { animation: none; } }
`;

function Pools({
  running,
  grain,
  blur,
  duration,
}: {
  running: boolean;
  grain: number;
  blur: number;
  duration: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pool = (seconds: number): CSSProperties => ({
    animationDuration: `${seconds}s`,
    animationPlayState: running ? 'running' : 'paused',
  });
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <style href="flb-noise-gradient" precedence="default">
        {CSS}
      </style>
      <div style={{ position: 'absolute', inset: 0, filter: `blur(${blur}px)`, opacity: 0.85 }}>
        <div className="flb-ng-pool flb-ng-a" style={pool(duration)} />
        <div className="flb-ng-pool flb-ng-b" style={pool(duration * 1.48)} />
        <div className="flb-ng-pool flb-ng-c" style={pool(duration * 2.1)} />
      </div>
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, opacity: grain, mixBlendMode: 'soft-light' }}
      >
        <filter id={`${id}-grain`}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves={3}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id}-grain)`} />
      </svg>
    </div>
  );
}

/**
 * Noise gradient: three large blurred pools of the theme colours drifting slowly across the box,
 * under a fine film grain. Pure CSS and SVG (no script runs), so it suits sites that must stay light;
 * a soft hero, newsletter or call-to-action background that works in light and dark mode.
 */
export function NoiseGradient({
  grain = 0.14,
  blur = 70,
  duration = 29,
  className,
  style,
}: NoiseGradientProps) {
  return (
    <EffectLayer
      className={className}
      style={style}
      fallback={<Pools running={false} grain={grain} blur={blur} duration={duration} />}
    >
      {({ inView }) => <Pools running={inView} grain={grain} blur={blur} duration={duration} />}
    </EffectLayer>
  );
}
