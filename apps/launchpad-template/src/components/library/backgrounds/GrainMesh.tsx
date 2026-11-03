import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface GrainMeshProps extends BackgroundProps {
  /** Time multiplier. */
  speed?: number;
  /** Film grain amount, 0 to 0.3. */
  grain?: number;
  /** Colour strength of the blobs, 0 to 1. */
  saturation?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uGrain;
uniform float uSaturation;

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime * 0.07;
  // Domain warp, so the colour pools have soft, organic borders.
  vec2 w = p + 0.4 * (vec2(fbm3(p * 1.1 + vec2(t, 0.0)), fbm3(p * 1.1 + vec2(4.0, -t))) - 0.5);
  vec2 c1 = vec2(sin(t * 1.3) * 0.55, cos(t * 1.1) * 0.22 + 0.12);
  vec2 c2 = vec2(cos(t * 0.9 + 2.0) * 0.6, sin(t * 1.4 + 1.0) * 0.28 - 0.1);
  vec2 c3 = vec2(sin(t * 0.7 + 4.0) * 0.45, cos(t * 0.8 + 3.0) * 0.3);
  vec2 c4 = vec2(cos(t * 0.6 + 5.0) * 0.7, sin(t * 0.5 + 2.0) * 0.35);
  float b1 = exp(-dot(w - c1, w - c1) * 3.6);
  float b2 = exp(-dot(w - c2, w - c2) * 4.2);
  float b3 = exp(-dot(w - c3, w - c3) * 6.0);
  float b4 = exp(-dot(w - c4, w - c4) * 5.0);
  float s = uSaturation * mix(0.75, 1.0, uDark);
  vec3 col = uBg;
  col = mix(col, uPrimary, b1 * 0.9 * s);
  col = mix(col, uAccent, b2 * 0.8 * s);
  col = mix(col, mix(uPrimary, uInk, 0.3), b3 * 0.55 * s);
  col = mix(col, mix(uAccent, uPrimary, 0.5), b4 * 0.45 * s);
  // Grain refreshed twelve times a second, like film.
  float g = hash12(gl_FragCoord.xy + floor(uTime * 12.0) * 17.31) - 0.5;
  col += g * uGrain;
  gl_FragColor = vec4(col + dither(), 1.0);
}
`);

/**
 * Grain mesh gradient: four soft pools of the theme colours drifting and blending on the page
 * background, with a fine film grain. The modern "mesh gradient" look; fits any hero, a pricing or
 * newsletter band, or a closing call to action. Opaque: it replaces the section background.
 */
export function GrainMesh({ speed = 1, grain = 0.1, saturation = 1, ...rest }: GrainMeshProps) {
  const uniforms = useMemo(() => ({ uGrain: grain, uSaturation: saturation }), [grain, saturation]);
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={1.5}
      fallback={
        <FallbackFill
          background={
            'radial-gradient(55% 60% at 22% 30%, color-mix(in srgb, var(--color-primary) 70%, var(--color-bg)), transparent 70%),' +
            'radial-gradient(50% 55% at 80% 70%, color-mix(in srgb, var(--color-accent) 60%, var(--color-bg)), transparent 70%),' +
            'radial-gradient(40% 45% at 60% 20%, color-mix(in srgb, var(--color-primary) 35%, var(--color-text)), transparent 70%),' +
            'var(--color-bg)'
          }
        />
      }
    />
  );
}
