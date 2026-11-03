import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { EffectColors } from '../backgrounds/lib/color';
import { SceneFrame, SceneLoading } from './lib/SceneFrame';

export interface FloatingCoinProps {
  /** One to three characters embossed on the faces, for example the coin's ticker initial. */
  monogram?: string;
  /** Colour overrides; by default the coin follows the site theme (accent metal, primary light). */
  colors?: EffectColors;
  /** Spin speed multiplier. */
  speed?: number;
  /** Small sparkles floating around the coin. */
  sparkles?: boolean;
  className?: string;
  style?: CSSProperties;
}

const FloatingCoinScene = dynamic(
  () => import('./scenes/FloatingCoinScene').then((m) => m.FloatingCoinScene),
  { ssr: false, loading: SceneLoading },
);

function CoinFallback({ monogram }: { monogram: string }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      <div
        style={{
          width: 'min(60cqw, 60cqh, 16rem)',
          aspectRatio: '1',
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          background:
            'radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--color-accent) 35%, white), var(--color-accent) 45%, color-mix(in srgb, var(--color-accent) 55%, var(--color-primary)) 100%)',
          boxShadow:
            'inset 0 0 0 0.6rem color-mix(in srgb, var(--color-accent) 70%, white), 0 30px 60px -25px var(--color-primary)',
          color: 'color-mix(in srgb, var(--color-accent) 45%, black)',
          font: '700 min(26cqh, 26cqw, 6rem) / 1 var(--font-heading)',
        }}
      >
        {monogram.slice(0, 3)}
      </div>
    </div>
  );
}

/**
 * A 3D coin: a polished metal medallion in the theme's accent colour, with the coin's monogram
 * embossed on its faces and a reeded edge, floating and spinning slowly under a soft studio light
 * (built in the scene, nothing downloaded), with a few sparkles; it tilts towards the pointer. The
 * launchpad's signature object: beside the hero headline, on a token page header or a mint section.
 * three.js loads only when the coin is shown.
 */
export function FloatingCoin({
  monogram = '$',
  colors,
  speed = 1,
  sparkles = true,
  className,
  style,
}: FloatingCoinProps) {
  return (
    <SceneFrame fallback={<CoinFallback monogram={monogram} />} className={className} style={style}>
      {({ inView }) => (
        <FloatingCoinScene
          inView={inView}
          monogram={monogram}
          colors={colors}
          speed={speed}
          sparkles={sparkles}
        />
      )}
    </SceneFrame>
  );
}
