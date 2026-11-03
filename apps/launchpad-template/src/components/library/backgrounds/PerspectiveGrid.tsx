import type { CSSProperties } from 'react';
import { EffectLayer } from './lib/CanvasLayer';
import type { BackgroundProps } from './lib/ShaderBackground';

export interface PerspectiveGridProps extends Omit<BackgroundProps, 'colors'> {
  /** Size of a grid cell, in pixels. */
  cell?: number;
  /** Height of the horizon, 0.2 to 0.8 of the box (from the top). */
  horizon?: number;
  /** Seconds for the floor to move by one cell. */
  duration?: number;
  /** Adds a striped retro sun on the horizon. */
  sun?: boolean;
}

// Bands widen towards the horizon, like a retro sunset.
const SUN_STRIPES =
  'linear-gradient(to bottom, #000 30%, transparent 30% 32%, #000 32% 40%, transparent 40% 43.5%, #000 43.5% 50%, transparent 50% 54.5%, #000 54.5% 59%, transparent 59% 65%, #000 65%)';

const CSS = `
.flb-pg-floor { animation: flb-pg-move linear infinite; }
@keyframes flb-pg-move { to { background-position: 0 var(--flb-pg-cell), 0 0; } }
@media (prefers-reduced-motion: reduce) { .flb-pg-floor { animation: none; } }
`;

function Grid({
  running,
  cell,
  horizon,
  duration,
  sun,
}: {
  running: boolean;
  cell: number;
  horizon: number;
  duration: number;
  sun: boolean;
}) {
  const line = 'color-mix(in srgb, var(--color-primary) 55%, transparent)';
  const top = `${Math.round(horizon * 100)}%`;
  const floor = {
    position: 'absolute',
    left: '-50%',
    right: '-50%',
    top,
    height: '120%',
    transformOrigin: 'top center',
    transform: 'perspective(320px) rotateX(68deg)',
    backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
    backgroundSize: `${cell}px ${cell}px`,
    maskImage: 'linear-gradient(to bottom, transparent, #000 30%, #000)',
    WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 30%, #000)',
    animationDuration: `${duration}s`,
    animationPlayState: running ? 'running' : 'paused',
    '--flb-pg-cell': `${cell}px`,
  } as CSSProperties;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <style href="flb-perspective-grid" precedence="default">
        {CSS}
      </style>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(to bottom, transparent calc(${top} - 30%), color-mix(in srgb, var(--color-primary) 16%, transparent) ${top}, transparent calc(${top} + 25%))`,
        }}
      />
      {sun && (
        // Clipped at the horizon, so the sun sets behind the floor.
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: top,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              width: 'min(30%, 15rem)',
              aspectRatio: '1',
              transform: 'translate(-50%, 38%)',
              borderRadius: '50%',
              background:
                'linear-gradient(to bottom, var(--color-accent), var(--color-primary) 75%)',
              maskImage: SUN_STRIPES,
              WebkitMaskImage: SUN_STRIPES,
              filter:
                'drop-shadow(0 0 40px color-mix(in srgb, var(--color-primary) 60%, transparent))',
            }}
          />
        </div>
      )}
      <div className="flb-pg-floor" style={floor} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top,
          height: '2px',
          transform: 'translateY(-1px)',
          background:
            'linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-accent) 80%, white), transparent)',
          boxShadow: '0 0 24px 4px color-mix(in srgb, var(--color-primary) 50%, transparent)',
        }}
      />
    </div>
  );
}

/**
 * Perspective grid: a glowing grid floor stretching to a bright horizon line and gliding towards the
 * viewer, optionally under a striped retro sun. Pure CSS; a retro or tech hero (headline above the
 * horizon), a game or "arcade" themed launchpad, or a footer band.
 */
export function PerspectiveGrid({
  cell = 56,
  horizon = 0.55,
  duration = 2.4,
  sun = false,
  className,
  style,
}: PerspectiveGridProps) {
  const props = { cell, horizon: Math.max(0.2, Math.min(0.8, horizon)), duration, sun };
  return (
    <EffectLayer className={className} style={style} fallback={<Grid running={false} {...props} />}>
      {({ inView }) => <Grid running={inView} {...props} />}
    </EffectLayer>
  );
}
