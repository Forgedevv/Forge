import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { EffectColors } from '../backgrounds/lib/color';
import { SceneFrame, SceneLoading } from './lib/SceneFrame';
import type { SculptureShape } from './scenes/GlossySculptureScene';

export type { SculptureShape };

export interface GlossySculptureProps {
  /** `knot` (a twisted torus knot), `torus` (a fat ring) or `gem` (a faceted crystal). */
  shape?: SculptureShape;
  /** Colour overrides; by default the sculpture follows the site theme. */
  colors?: EffectColors;
  /** Time multiplier. */
  speed?: number;
  className?: string;
  style?: CSSProperties;
}

const GlossySculptureScene = dynamic(
  () => import('./scenes/GlossySculptureScene').then((m) => m.GlossySculptureScene),
  { ssr: false, loading: SceneLoading },
);

const FALLBACK = (
  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
    <div
      style={{
        width: 'min(55cqw, 55cqh)',
        aspectRatio: '1',
        borderRadius: '50%',
        background:
          'radial-gradient(closest-side, transparent 38%, var(--color-primary) 42%, color-mix(in srgb, var(--color-accent) 60%, white) 52%, var(--color-primary) 64%, transparent 68%)',
        boxShadow: '0 30px 80px -30px var(--color-primary)',
      }}
    />
  </div>
);

/**
 * Glossy sculpture: an abstract iridescent object (a torus knot, a ring or a faceted gem) in the
 * theme's primary colour, turning and floating slowly in a soft studio light whose reflections take
 * the accent and primary colours; it tilts towards the pointer. A premium hero centrepiece or the
 * visual of a features section. three.js loads only when the sculpture is shown.
 */
export function GlossySculpture({
  shape = 'knot',
  colors,
  speed = 1,
  className,
  style,
}: GlossySculptureProps) {
  return (
    <SceneFrame fallback={FALLBACK} className={className} style={style}>
      {({ inView }) => (
        <GlossySculptureScene inView={inView} colors={colors} shape={shape} speed={speed} />
      )}
    </SceneFrame>
  );
}
