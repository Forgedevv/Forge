import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { EffectColors } from '../backgrounds/lib/color';
import { SceneFrame, SceneLoading } from './lib/SceneFrame';

export interface ParticleBlobProps {
  /** Colour overrides; by default the particles follow the site theme. */
  colors?: EffectColors;
  /** Number of particles, 1000 to 20000. */
  count?: number;
  /** Time multiplier. */
  speed?: number;
  className?: string;
  style?: CSSProperties;
}

const ParticleBlobScene = dynamic(
  () => import('./scenes/ParticleBlobScene').then((m) => m.ParticleBlobScene),
  { ssr: false, loading: SceneLoading },
);

const FALLBACK = (
  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
    <div
      style={{
        width: 'min(70cqw, 70cqh)',
        aspectRatio: '1',
        borderRadius: '50%',
        background:
          'radial-gradient(circle at 40% 35%, color-mix(in srgb, var(--color-accent) 55%, transparent), color-mix(in srgb, var(--color-primary) 40%, transparent) 45%, transparent 70%)',
        filter: 'blur(6px)',
      }}
    />
  </div>
);

/**
 * Particle blob: thousands of glowing particles in the theme colours forming a living, breathing
 * blob that swirls slowly, with a few particles drifting off its surface; the surface swells towards
 * the pointer. An "AI", community or "alive" hero centrepiece, or the visual of a launch countdown.
 * three.js loads only when the blob is shown.
 */
export function ParticleBlob({
  colors,
  count = 12000,
  speed = 1,
  className,
  style,
}: ParticleBlobProps) {
  return (
    <SceneFrame fallback={FALLBACK} className={className} style={style}>
      {({ inView }) => (
        <ParticleBlobScene inView={inView} colors={colors} count={count} speed={speed} />
      )}
    </SceneFrame>
  );
}
