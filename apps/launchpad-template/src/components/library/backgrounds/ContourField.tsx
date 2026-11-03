import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface ContourFieldProps extends BackgroundProps {
  /** Time multiplier. */
  speed?: number;
  /** Number of contour lines, 1.5 (sparse) to 5 (dense). */
  density?: number;
  /** Height of the horizon, 0.5 to 1 (1 = no horizon visible). */
  horizon?: number;
  /** The field drifts slightly with the pointer. */
  followPointer?: boolean;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uDensity;
uniform float uHorizon;

float aaWidth(float v) {
#ifdef HAS_DERIVATIVES
  return fwidth(v);
#else
  return 0.04;
#endif
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 c = vec2((uv.x - 0.5) * aspect, uv.y);
  vec2 m = (uPointer - 0.5) * vec2(aspect, 1.0);
  float horizon = uHorizon;
  float below = horizon - c.y;
  if (below < 0.004) {
    float haze = exp(-abs(below) * 28.0) * 0.25;
    gl_FragColor = vec4(uPrimary * haze, haze);
    return;
  }
  // A ground plane seen in perspective: rows tighten towards the horizon.
  float depth = 0.35 / below;
  vec2 g = vec2(c.x * depth, depth) * 1.4 + m * 0.35;
  float t = uTime * 0.05;
  float n = fbm(g * 0.55 + vec2(t, -t * 0.7)) * 1.7 + fbm(g * 0.22 - vec2(t * 0.4, 0.0)) * 1.1;

  float v = n * uDensity * 2.0;
  float fv = fract(v);
  float d = min(fv, 1.0 - fv);
  float w = clamp(aaWidth(v), 0.0004, 0.3);
  float line = fadeOut(w * 1.3, d) * fadeOut(0.18, w - 0.06);
  float v2 = v * 4.0;
  float fv2 = fract(v2);
  float w2 = clamp(aaWidth(v2), 0.0004, 0.5);
  float fine = fadeOut(w2, min(fv2, 1.0 - fv2)) * fadeOut(0.2, w2 - 0.08) * 0.22;

  // Sparse glowing nodes riding the field.
  vec2 cell = g * 1.6 + vec2(uTime * 0.06, 0.0);
  vec2 ci = floor(cell);
  vec2 cf = fract(cell) - 0.5;
  float pick = hash12(ci);
  vec2 jitter = (vec2(hash12(ci + 7.1), hash12(ci + 3.3)) - 0.5) * 0.5;
  float pulse = 0.6 + 0.4 * sin(uTime * 1.4 + pick * 40.0);
  float node = step(0.86, pick) * fadeOut(0.06, length(cf - jitter)) * pulse;

  float near = smoothstep(0.0, 0.35, below);
  float far = smoothstep(0.004, 0.25, below);
  vec3 tint = mix(uPrimary, uAccent, smoothstep(0.6, 1.6, n));
  vec3 col = tint * (line * 0.85 + fine) * far + uAccent * node * far;
  col += uPrimary * exp(-below * 18.0) * 0.25;
  col *= mix(0.55, 1.0, near) * mix(0.8, 1.0, uDark);
  col = min(col, vec3(1.0));
  float a = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(col + dither() * a, a);
}
`);

/**
 * Contour field: topographic lines flowing over a ground plane seen in perspective, with a few
 * glowing nodes riding the terrain and a soft glow on the horizon. Techy and calm; a data or "AI"
 * flavoured hero background, or a quiet backdrop for a stats section.
 */
export function ContourField({
  speed = 1,
  density = 2.6,
  horizon = 0.72,
  followPointer = true,
  ...rest
}: ContourFieldProps) {
  const uniforms = useMemo(() => ({ uDensity: density, uHorizon: horizon }), [density, horizon]);
  const top = `${Math.round((1 - horizon) * 100)}%`;
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={1.5}
      followPointer={followPointer}
      fallback={
        <FallbackFill
          background={
            `linear-gradient(to bottom, transparent ${top}, color-mix(in srgb, var(--color-primary) 18%, transparent) calc(${top} + 1%), transparent 70%),` +
            `repeating-radial-gradient(ellipse 160% 60% at 50% 115%, transparent 0 18px, color-mix(in srgb, var(--color-primary) 22%, transparent) 18px 19px)`
          }
        />
      }
    />
  );
}
