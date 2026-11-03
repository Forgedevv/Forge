import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface FloatingLinesProps extends BackgroundProps {
  /** Time multiplier. */
  speed?: number;
  /** Lines per bundle (three bundles), 2 to 14. */
  lines?: number;
  /** How strongly the lines bend towards the pointer, 0 to 1. */
  bend?: number;
  /** Line brightness, 0 to 2. */
  intensity?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uLines;
uniform float uBend;
uniform float uIntensity;
vec2 gPointer;

vec3 bundle(vec2 p, float baseY, float spread, float amp, float freq, float phase, float t) {
  vec3 acc = vec3(0.0);
  float w = 1.5 / uResolution.y;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    if (fi >= uLines) break;
    float k = fi / max(uLines - 1.0, 1.0);
    float off = phase + fi * 0.21;
    float y = baseY + (k - 0.5) * spread
      + sin(p.x * freq + off + t) * amp
      + sin(p.x * freq * 0.47 - t * 0.63 + off * 1.3) * amp * 0.55;
    vec2 toPointer = p - gPointer;
    float pull = exp(-dot(toPointer, toPointer) * 9.0) * uBend;
    y = mix(y, gPointer.y + (y - gPointer.y) * 0.35, pull);
    float d = abs(p.y - y);
    float glow = pow(w / (d + w), 1.3);
    acc += mix(uPrimary, uAccent, k) * glow;
  }
  return acc;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  gPointer = (uPointer - 0.5) * vec2(aspect, 1.0);
  // A slight tilt keeps the composition dynamic.
  mat2 tilt = mat2(0.985, 0.17, -0.17, 0.985);
  p = tilt * p;
  gPointer = tilt * gPointer;
  float t = uTime * 0.35;
  vec3 col = bundle(p, -0.24, 0.16, 0.10, 2.3, 0.0, t) * 0.55
    + bundle(p, 0.0, 0.24, 0.15, 1.6, 2.1, t * 0.8) * 1.0
    + bundle(p, 0.24, 0.12, 0.08, 2.9, 4.2, t * 1.15) * 0.4;
  // Fade towards the left and right edges.
  float edge = smoothstep(0.0, 0.18, gl_FragCoord.x / uResolution.x)
    * smoothstep(0.0, 0.18, 1.0 - gl_FragCoord.x / uResolution.x);
  col *= uIntensity * mix(0.35, 1.0, edge);
  col = min(col, vec3(1.0));
  float a = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(col, a);
}
`);

/**
 * Floating lines: three bundles of fine glowing wave lines sweeping across the box in the theme
 * colours, with a gentle parallax, bending around the pointer. Light and elegant; works behind a
 * hero, as a band between sections, or behind a stats row.
 */
export function FloatingLines({
  speed = 1,
  lines = 8,
  bend = 0.55,
  intensity = 1,
  ...rest
}: FloatingLinesProps) {
  const uniforms = useMemo(
    () => ({
      uLines: Math.max(2, Math.min(14, Math.round(lines))),
      uBend: bend,
      uIntensity: intensity,
    }),
    [lines, bend, intensity],
  );
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={2}
      followPointer={bend > 0}
      pointerRest={[0.5, -1]}
      fallback={
        <FallbackFill
          background={
            'repeating-linear-gradient(172deg, transparent 0 22px, color-mix(in srgb, var(--color-primary) 30%, transparent) 22px 23px),' +
            'radial-gradient(80% 60% at 50% 50%, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 70%)'
          }
        />
      }
    />
  );
}
