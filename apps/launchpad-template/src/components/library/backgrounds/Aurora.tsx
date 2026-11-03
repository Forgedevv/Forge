import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface AuroraProps extends BackgroundProps {
  /** Time multiplier. */
  speed?: number;
  /** Brightness of the curtains, 0 to 1.5. */
  intensity?: number;
  /** Height of the curtains' lower edge, 0 (bottom) to 1 (top). */
  height?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uIntensity;
uniform float uHeight;

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime * 0.12;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (0.85 + fi * 0.3) + fi * 1.7;
    // Lower edge of the curtain, folding slowly.
    float edge = (uHeight - 0.5) + fi * 0.07
      + (fbm3(vec2(x * 0.75 + t * (0.6 + fi * 0.2), fi * 3.1 + t * 0.3)) - 0.5) * 0.8
      + sin(x * 1.4 + t * 2.0 + fi * 2.0) * 0.06;
    float dy = p.y - edge;
    // Brighter and dimmer stretches along each curtain.
    float strength = 0.25 + 0.75 * smoothstep(0.3, 0.72, fbm3(vec2(x * 0.55 - t * 0.8, fi * 5.0)));
    float rise = exp(-max(dy, 0.0) * (2.2 + fi * 1.4)) * strength;
    float cut = exp(-max(-dy, 0.0) * 34.0);
    // Vertical rays inside the curtain.
    float rays = 0.45 + 0.55 * valueNoise(vec2(x * 24.0 + t * 2.0, dy * 1.5 - t));
    rays *= 0.65 + 0.35 * valueNoise(vec2(x * 70.0, t * 3.0));
    vec3 tint = mix(uAccent, uPrimary, smoothstep(0.0, 0.3, dy));
    float rim = exp(-abs(dy) * 45.0) * 0.5 * strength;
    col += tint * (rise * cut * rays + rim * rays) * (0.75 - fi * 0.17);
  }
  // A faint glow of the sky above the curtains.
  col += uPrimary * 0.08 * smoothstep(-0.2, 0.6, p.y);
  col *= uIntensity * mix(0.85, 1.0, uDark);
  col = min(col, vec3(1.0));
  float a = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(col + dither() * a, a);
}
`);

/**
 * Aurora: soft curtains of light rising and folding slowly, in the theme's accent at their lower
 * edge and primary higher up, with fine vertical rays. A calm, dreamy hero or "about" background;
 * the curtains sit in the middle of the box by default, leaving room for copy below.
 */
export function Aurora({ speed = 1, intensity = 1, height = 0.5, ...rest }: AuroraProps) {
  const uniforms = useMemo(() => ({ uIntensity: intensity, uHeight: height }), [intensity, height]);
  const top = `${Math.round((1 - height) * 100)}%`;
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
            `radial-gradient(60% 35% at 30% ${top}, color-mix(in srgb, var(--color-accent) 35%, transparent), transparent 70%),` +
            `radial-gradient(70% 45% at 70% calc(${top} - 12%), color-mix(in srgb, var(--color-primary) 35%, transparent), transparent 70%)`
          }
        />
      }
    />
  );
}
