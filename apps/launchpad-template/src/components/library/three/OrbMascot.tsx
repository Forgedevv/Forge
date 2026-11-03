import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { EffectColors } from '../backgrounds/lib/color';
import { SceneFrame, SceneLoading } from './lib/SceneFrame';

export interface OrbMascotProps {
  /** Colour overrides; by default the orb follows the site theme. */
  colors?: EffectColors;
  /** Draws a small smile under the eyes. */
  smile?: boolean;
  /** Time multiplier. */
  speed?: number;
  className?: string;
  style?: CSSProperties;
}

const OrbMascotScene = dynamic(
  () => import('./scenes/OrbMascotScene').then((m) => m.OrbMascotScene),
  { ssr: false, loading: SceneLoading },
);

const EYE = {
  width: '9%',
  height: '15%',
  borderRadius: '50%',
  background: 'white',
} as const;

const FALLBACK = (
  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
    <div
      style={{
        position: 'relative',
        width: 'min(48cqw, 48cqh, 14rem)',
        aspectRatio: '1',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16%',
        paddingBottom: '8%',
        boxSizing: 'border-box',
        background:
          'radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--color-primary) 55%, black), var(--color-primary) 75%, color-mix(in srgb, var(--color-accent) 50%, white) 100%)',
        boxShadow: '0 0 60px -10px var(--color-primary)',
      }}
    >
      <span style={EYE} />
      <span style={EYE} />
    </div>
  </div>
);

/**
 * Orb mascot: a friendly glossy orb in the theme colours with two glowing eyes (and an optional
 * smile) that follow the pointer, blink now and then, bob gently, with sparks orbiting around it.
 * A character for playful launchpads: hero companion, empty states, the "create a coin" page.
 * three.js loads only when the mascot is shown.
 */
export function OrbMascot({ colors, smile = true, speed = 1, className, style }: OrbMascotProps) {
  return (
    <SceneFrame fallback={FALLBACK} className={className} style={style}>
      {({ inView }) => (
        <OrbMascotScene inView={inView} colors={colors} smile={smile} speed={speed} />
      )}
    </SceneFrame>
  );
}
