import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface LaserBeamProps extends BackgroundProps {
  /** Time multiplier for the streaks and the smoke. */
  speed?: number;
  /** Horizontal position of the beam, 0 (left) to 1 (right). */
  x?: number;
  /** Height of the impact line, 0 (bottom) to 1 (top). */
  floor?: number;
  /** Amount of smoke around the impact, 0 to 1. */
  smoke?: number;
  /** Overall brightness, 0 to 1.5. */
  intensity?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uBeamX;
uniform float uFloor;
uniform float uSmoke;
uniform float uIntensity;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  // Origin at the impact point, units of box height.
  vec2 p = vec2((uv.x - uBeamX) * aspect, uv.y - uFloor);
  float t = uTime;
  float dx = abs(p.x);
  float above = smoothstep(-0.004, 0.012, p.y);

  // The beam: a sharp core and a wide halo, widening a little where it lands.
  float width = 0.0035 + 0.012 * fadeOut(0.4, p.y);
  float core = pow(width / (dx + width), 2.0) * above;
  float haloWidth = 0.05 + 0.05 * fadeOut(0.5, p.y);
  float halo = haloWidth / (dx + haloWidth) * above * 0.3;
  float fade = mix(0.45, 1.0, fadeOut(0.9, p.y));
  // Light streaks flowing down the beam.
  float flow = valueNoise(vec2(p.x * 55.0, p.y * 5.0 + t * 2.6));
  float streaks = pow(flow, 5.0) * exp(-dx * 22.0) * above * 1.6;
  float beam = (core + halo * (0.7 + 0.6 * flow) + streaks) * fade;

  // Flare: a thin horizontal line of light on the floor, and a hot spot at the impact.
  float fy = abs(p.y);
  float flare = (0.0025 / (fy + 0.0025)) * exp(-dx * 1.8) * 0.9;
  float hot = 0.018 / (length(p * vec2(0.45, 1.8)) + 0.018);
  float pool = exp(-dx * 3.0) * exp(max(-p.y, 0.0) * -10.0) * (1.0 - above) * 0.35;

  // Smoke drifting around the impact.
  vec2 sp = p * vec2(1.2, 2.6);
  float smoke = fbm(sp * 2.2 + vec2(t * 0.12, -t * 0.22));
  smoke = smoothstep(0.38, 0.85, smoke);
  smoke *= exp(-length(p * vec2(0.85, 2.4)) * 2.6) * uSmoke * 1.4;

  vec3 white = mix(uPrimary, vec3(1.0), 0.75 * uDark);
  vec3 col = white * (core * fade + hot * 0.6)
    + uPrimary * (halo * fade + streaks * fade + pool)
    + mix(uPrimary, uAccent, 0.55) * flare
    + mix(uPrimary, uAccent, 0.35) * smoke * 0.8;
  col *= uIntensity;
  col = min(col, vec3(1.0));
  float a = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(col + dither() * a, a);
}
`);

/**
 * A laser beam: a thin, intense shaft of light falling from the top of the box and hitting an
 * invisible floor, where it spreads into a horizontal flare with drifting smoke. Dramatic and
 * techy; made for a hero where the headline sits on either side of the beam, or for a "launch"
 * moment above a call to action placed under the impact.
 */
export function LaserBeam({
  speed = 1,
  x = 0.5,
  floor = 0.28,
  smoke = 0.7,
  intensity = 1,
  ...rest
}: LaserBeamProps) {
  const uniforms = useMemo(
    () => ({ uBeamX: x, uFloor: floor, uSmoke: smoke, uIntensity: intensity }),
    [x, floor, smoke, intensity],
  );
  const left = `${Math.round(x * 100)}%`;
  const bottom = `${Math.round((1 - floor) * 100)}%`;
  const fallback =
    `linear-gradient(90deg, transparent calc(${left} - 1px), color-mix(in srgb, var(--color-primary) 70%, white) ${left}, transparent calc(${left} + 1px)) top / 100% ${bottom} no-repeat,` +
    `radial-gradient(40% 9% at ${left} ${bottom}, color-mix(in srgb, var(--color-accent) 55%, transparent), transparent 70%),` +
    `radial-gradient(14% 70% at ${left} 20%, color-mix(in srgb, var(--color-primary) 22%, transparent), transparent 70%)`;
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={1.5}
      fallback={<FallbackFill background={fallback} />}
    />
  );
}
