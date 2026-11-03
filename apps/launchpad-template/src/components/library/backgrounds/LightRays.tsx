import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export type LightRaysOrigin = 'top' | 'top-left' | 'top-right' | 'left' | 'right' | 'bottom';

export interface LightRaysProps extends BackgroundProps {
  /** Where the light comes from (just outside the box). */
  origin?: LightRaysOrigin;
  /** Time multiplier for the shimmer of the beams. */
  speed?: number;
  /** Opening of the light cone, 0.2 (narrow spotlight) to 1.4 (wide wash). */
  spread?: number;
  /** How far the beams reach, in box heights. */
  reach?: number;
  /** 0 to 1: how much the beams turn towards the pointer. */
  pointerInfluence?: number;
}

const ORIGINS: Record<LightRaysOrigin, { source: [number, number]; direction: [number, number] }> =
  {
    top: { source: [0.5, 1.18], direction: [0, -1] },
    'top-left': { source: [-0.05, 1.15], direction: [0.55, -0.83] },
    'top-right': { source: [1.05, 1.15], direction: [-0.55, -0.83] },
    left: { source: [-0.15, 0.62], direction: [1, -0.15] },
    right: { source: [1.15, 0.62], direction: [-1, -0.15] },
    bottom: { source: [0.5, -0.18], direction: [0, 1] },
  };

const FRAGMENT = fragmentShader(/* glsl */ `
uniform vec2 uSource;
uniform vec2 uDirection;
uniform float uSpread;
uniform float uReach;
uniform float uFollow;

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 q = gl_FragCoord.xy / uResolution.y;
  vec2 src = uSource * vec2(aspect, 1.0);
  vec2 toPointer = uPointer * vec2(aspect, 1.0) - src;
  vec2 dir = normalize(mix(uDirection, normalize(toPointer + 1e-4), uFollow));
  vec2 d = q - src;
  float dist = length(d);
  vec2 nd = d / max(dist, 1e-4);
  float ang = atan(nd.x * dir.y - nd.y * dir.x, dot(nd, dir));
  float t = uTime;

  float cone = fadeOut(uSpread, abs(ang));
  cone *= cone;
  // Beams: noise along the angle only, so each one is a straight shaft from the source.
  float b1 = valueNoise(vec2(ang * 13.0 + 3.0, t * 0.32));
  float b2 = valueNoise(vec2(ang * 34.0 - 11.0, t * 0.55 + 4.0));
  float b3 = valueNoise(vec2(ang * 85.0, t * 0.8 - 2.0));
  float beams = b1 * b1 * 0.7 + b2 * b2 * b2 * 0.55 + pow(b3, 4.0) * 0.35;
  float fall = exp(-dist / uReach);
  float glow = exp(-dist * 4.5);
  // Slow drifting dust in the light.
  float dust = 0.82 + 0.18 * valueNoise(q * 5.0 + vec2(t * 0.05, -t * 0.12));
  float light = (beams * fall * 1.5 + glow * 0.55) * cone * dust;

  vec3 hot = mix(uAccent, vec3(1.0), 0.45 * uDark);
  vec3 col = mix(hot, uPrimary, smoothstep(0.0, uReach * 1.1, dist));
  float a = clamp(light, 0.0, 1.0) * mix(0.7, 1.0, uDark);
  gl_FragColor = vec4(col * a + dither() * a, a);
}
`);

/**
 * Volumetric light rays: shafts of theme-coloured light falling from an edge of the box (top by
 * default), shimmering slowly and leaning towards the pointer. Transparent, so it sits on the page
 * background; a strong hero or "launch" banner background, also nice behind a closing call to action.
 */
export function LightRays({
  origin = 'top',
  speed = 1,
  spread = 0.7,
  reach = 1.1,
  pointerInfluence = 0.18,
  ...rest
}: LightRaysProps) {
  const { source, direction } = ORIGINS[origin];
  const uniforms = useMemo(
    () => ({
      uSource: source,
      uDirection: direction,
      uSpread: spread,
      uReach: reach,
      uFollow: pointerInfluence,
    }),
    [source, direction, spread, reach, pointerInfluence],
  );
  const fallback = useMemo(() => {
    const x = `${Math.round(source[0] * 100)}%`;
    const y = `${Math.round((1 - source[1]) * 100)}%`;
    return (
      `radial-gradient(70% 90% at ${x} ${y}, color-mix(in srgb, var(--color-accent) 30%, transparent), transparent 70%),` +
      `radial-gradient(110% 120% at ${x} ${y}, color-mix(in srgb, var(--color-primary) 22%, transparent), transparent 75%)`
    );
  }, [source]);
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={1.5}
      followPointer={pointerInfluence > 0}
      pointerRest={[source[0] + direction[0] * 0.7, source[1] + direction[1] * 0.7]}
      fallback={<FallbackFill background={fallback} />}
    />
  );
}
