import { useMemo } from 'react';
import { fragmentShader } from './lib/glsl';
import { FallbackFill, ShaderBackground, type BackgroundProps } from './lib/ShaderBackground';

export interface LiquidBlobProps extends BackgroundProps {
  /** Time multiplier. */
  speed?: number;
  /** Size of the blob, 0.5 to 1.6. */
  size?: number;
  /** A droplet follows the pointer and merges into the blob. */
  followPointer?: boolean;
  /** Horizontal centre of the blob, 0 (left) to 1 (right). */
  x?: number;
}

const FRAGMENT = fragmentShader(/* glsl */ `
uniform float uSize;
uniform float uFollow;
uniform float uCenterX;
vec2 gPointer;
vec2 gCenter;

const float THRESHOLD = 0.3;

// Sum of Gaussian metaballs; the surface is where the field reaches THRESHOLD.
float field(vec2 p, float t) {
  float f = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = gCenter + vec2(
      sin(t * (0.5 + fi * 0.13) + fi * 1.9) * 0.24,
      cos(t * (0.42 + fi * 0.11) + fi * 2.7) * 0.15
    ) * uSize;
    float r = (0.1 + 0.035 * sin(fi * 3.1 + 1.0)) * uSize;
    vec2 d = p - c;
    f += exp(-dot(d, d) / (r * r));
  }
  vec2 m = p - gPointer;
  float rm = 0.07 * uSize;
  f += uFollow * exp(-dot(m, m) / (rm * rm));
  return f;
}

// Height of the liquid: a single ball gives an exact hemisphere, merged balls a smooth surface.
float dome(vec2 p, float t) {
  return sqrt(max(log(max(field(p, t), 1e-4) / THRESHOLD), 0.0));
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  gPointer = (uPointer - 0.5) * vec2(aspect, 1.0);
  gCenter = vec2((uCenterX - 0.5) * aspect, 0.0);
  float t = uTime * 0.6;
  float f = field(p, t);
  float inside = smoothstep(THRESHOLD - 0.025, THRESHOLD + 0.025, f);

  float e = 0.004;
  float h = dome(p, t);
  vec2 grad = vec2(dome(p + vec2(e, 0.0), t) - h, dome(p + vec2(0.0, e), t) - h) / e;
  grad = clamp(grad * 0.1 * uSize, -6.0, 6.0);
  vec3 n = normalize(vec3(-grad, 1.0));

  vec3 light = normalize(vec3(-0.5, 0.7, 0.6));
  float diffuse = max(dot(n, light), 0.0);
  float fres = pow(1.0 - n.z, 2.0);
  float spec = pow(max(dot(reflect(-light, n), vec3(0.0, 0.0, 1.0)), 0.0), 70.0);
  // Iridescent body: the hue slides between primary and accent with the surface angle.
  float k = 0.5 + 0.5 * sin(n.x * 2.4 + n.y * 3.1 + uTime * 0.35);
  vec3 body = mix(uPrimary, uAccent, k * 0.75);
  vec3 col = body * (0.32 + 0.78 * diffuse);
  col = mix(col, mix(uAccent, vec3(1.0), 0.45), fres * 0.55);
  // A soft studio window reflected on the upper part.
  float window = smoothstep(0.55, 0.8, n.y) * fadeOut(0.45, n.x + 0.35) * 0.35;
  col += vec3(1.0) * (spec * 0.9 + window);
  col = min(col, vec3(1.0));

  // Glow around the blob.
  float halo = smoothstep(0.02, THRESHOLD, f) * (1.0 - inside) * 0.4 * mix(0.6, 1.0, uDark);
  vec3 rgb = col * inside + uPrimary * halo;
  float a = inside + halo;
  gl_FragColor = vec4(rgb + dither() * a, a);
}
`);

/**
 * A liquid blob: glossy metaballs that drift, merge and split in the middle of the box, with an
 * iridescent primary-to-accent body, a bright studio highlight and a soft glow; a droplet follows the
 * pointer and merges in. Playful and premium; a centrepiece for a hero next to the headline.
 */
export function LiquidBlob({
  speed = 1,
  size = 1,
  followPointer = true,
  x = 0.5,
  ...rest
}: LiquidBlobProps) {
  const uniforms = useMemo(
    () => ({ uSize: size, uFollow: followPointer ? 1 : 0, uCenterX: x }),
    [size, followPointer, x],
  );
  const left = `${Math.round(x * 100)}%`;
  return (
    <ShaderBackground
      {...rest}
      fragment={FRAGMENT}
      uniforms={uniforms}
      speed={speed}
      maxPixelRatio={1.5}
      followPointer={followPointer}
      pointerRest={[x, 0.5]}
      fallback={
        <FallbackFill
          background={
            `radial-gradient(circle at calc(${left} - 6%) 40%, color-mix(in srgb, var(--color-accent) 60%, white) 0, var(--color-primary) 16%, transparent 24%),` +
            `radial-gradient(circle at calc(${left} + 7%) 58%, var(--color-accent) 0, var(--color-primary) 11%, transparent 17%),` +
            `radial-gradient(30% 40% at ${left} 50%, color-mix(in srgb, var(--color-primary) 25%, transparent), transparent 70%)`
          }
        />
      }
    />
  );
}
