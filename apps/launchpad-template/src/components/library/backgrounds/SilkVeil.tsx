import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface SilkVeilProps extends BackgroundProps {
  /** Time multiplier (1 = slow drift). */
  speed?: number;
  /** Size of the folds: below 1 for wide drapes, above 1 for tighter pleats. */
  scale?: number;
  /** Strength of the glossy highlight on the folds, 0 to 1. */
  sheen?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uScale;
uniform float uSheen;

// Height of the cloth: two crossing waves, bent by a slow fractal warp.
float drape(vec2 p, float t) {
  vec2 w = p * uScale;
  vec2 warp = vec2(fbm3(w * 0.8 + vec2(0.0, t * 0.5)), fbm3(w * 0.8 + vec2(4.3, -t * 0.45)));
  w += (warp - 0.5) * 0.9;
  float a = sin(w.x * 7.0 + w.y * 2.2 + t * 1.3);
  float b = sin(w.x * 2.6 - w.y * 4.4 - t * 0.9 + 1.7 + a * 0.6);
  float c = sin((w.x + w.y * 0.4) * 13.0 + b * 1.5 - t * 1.6);
  return a * 0.55 + b * 0.35 + c * 0.1;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  // A slight diagonal sweep, so the folds read as hanging cloth.
  p = mat2(0.94, -0.34, 0.34, 0.94) * p;
  float t = uTime * 0.16;
  float e = 0.003;
  float h = drape(p, t);
  vec2 grad = vec2(drape(p + vec2(e, 0.0), t) - h, drape(p + vec2(0.0, e), t) - h) / e;
  vec3 n = normalize(vec3(-grad * 0.09, 1.0));

  vec3 light = normalize(vec3(-0.55, 0.55, 0.62));
  // Shading relative to a flat sheet: folds facing the light brighten, the others darken.
  float shade = clamp(0.5 + (dot(n, light) - light.z) * 1.6, 0.0, 1.0);
  float spec = pow(clamp(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0, 1.0), 48.0);
  float tone = h * 0.5 + 0.5;

  vec3 deep = mix(uBg, uPrimary, mix(0.06, 0.12, uDark));
  vec3 lit = mix(uPrimary, uAccent, smoothstep(0.5, 1.0, tone) * 0.45);
  lit = mix(lit, uBg, 0.35 * (1.0 - uDark));
  vec3 col = mix(deep, lit, smoothstep(0.05, 1.0, shade) * mix(0.75, 0.95, uDark));
  col += spec * mix(uAccent, vec3(1.0), 0.6) * uSheen * mix(0.3, 0.6, uDark);

  // Let the cloth sink into the page background towards the edges.
  float vignette = fadeOut(1.0, length(p * vec2(0.75, 1.15)));
  col = mix(uBg, col, mix(0.35, 1.0, vignette));
  gl_FragColor = vec4(col + dither(), 1.0);
}
`);

const FALLBACK =
  'radial-gradient(120% 90% at 30% 20%, color-mix(in srgb, var(--color-primary) 45%, var(--color-bg)) 0%, transparent 60%),' +
  'radial-gradient(90% 80% at 80% 75%, color-mix(in srgb, var(--color-accent) 25%, var(--color-bg)) 0%, transparent 65%),' +
  'linear-gradient(160deg, color-mix(in srgb, var(--color-primary) 18%, var(--color-bg)), var(--color-bg))';

/**
 * A dark silk veil: soft folds of theme-tinted cloth drifting slowly, lit from the top left with a
 * gentle sheen, fading into the page background at the edges. A calm, premium hero background;
 * keep the copy over the darker centre-left area.
 */
export function SilkVeil({ speed = 1, scale = 1, sheen = 0.7, ...rest }: SilkVeilProps) {
  const uniforms = useMemo(() => ({ uScale: scale, uSheen: sheen }), [scale, sheen]);
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      fallback={<FallbackFill background={FALLBACK} />}
    />
  );
}
