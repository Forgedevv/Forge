import dynamic from 'next/dynamic';
import type { CSSProperties } from 'react';
import type { EffectColors } from '../backgrounds/lib/color';
import { SceneFrame, SceneLoading } from './lib/SceneFrame';

export interface CoinRainProps {
  /** One to three characters embossed on the coins. */
  monogram?: string;
  /** Number of coins, 6 to 120. */
  count?: number;
  /** Fall speed multiplier. */
  speed?: number;
  /** Colour overrides; by default the coins take the theme's accent and primary tints. */
  colors?: EffectColors;
  className?: string;
  style?: CSSProperties;
}

const CoinRainScene = dynamic(() => import('./scenes/CoinRainScene').then((m) => m.CoinRainScene), {
  ssr: false,
  loading: SceneLoading,
});

const DOT = 'color-mix(in srgb, var(--color-accent) 55%, transparent)';
const FALLBACK = (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: `radial-gradient(circle at 15% 20%, ${DOT} 0 10px, transparent 11px), radial-gradient(circle at 70% 12%, ${DOT} 0 14px, transparent 15px), radial-gradient(circle at 40% 55%, ${DOT} 0 8px, transparent 9px), radial-gradient(circle at 85% 70%, ${DOT} 0 12px, transparent 13px), radial-gradient(circle at 25% 85%, ${DOT} 0 9px, transparent 10px)`,
    }}
  />
);

/**
 * Coin rain: dozens of small embossed metal coins in the theme's tints tumbling down through the box
 * at different depths, with a soft studio light; the rain tilts slightly with the pointer. Festive
 * and playful: a "launched!" moment, a success state, a closing call to action or a meme-coin hero.
 * three.js loads only when the rain is shown.
 */
export function CoinRain({
  monogram = '$',
  count = 40,
  speed = 1,
  colors,
  className,
  style,
}: CoinRainProps) {
  return (
    <SceneFrame fallback={FALLBACK} className={className} style={style}>
      {({ inView }) => (
        <CoinRainScene
          inView={inView}
          colors={colors}
          monogram={monogram}
          count={count}
          speed={speed}
        />
      )}
    </SceneFrame>
  );
}
