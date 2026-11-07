/**
 * GLSL chunks shared by the full-screen shader backgrounds. They target GLSL ES 1.00 (WebGL 1), so
 * the effects run on every browser that has WebGL at all.
 */

/** Precision and the uniforms every background receives (see `ShaderSurface`). */
export const GLSL_HEADER = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uResolution; // drawing buffer size, in device pixels
uniform float uTime;      // seconds, scaled by the effect speed
uniform vec2 uPointer;    // eased pointer position, 0..1 from the bottom-left corner
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform vec3 uBg;
uniform vec3 uInk;        // the theme text colour
uniform float uDark;      // 1 on a dark background, 0 on a light one
`;

/** Hashing, value noise, fractal noise and a dither to hide gradient banding. */
export const GLSL_NOISE = /* glsl */ `
// Sine-free hash (after Dave Hoskins, MIT): stable on mobile GPUs.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise(p);
    p = turn * p * 2.03 + vec2(3.1, 1.7);
    amp *= 0.5;
  }
  return sum;
}
float fbm3(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    sum += amp * valueNoise(p);
    p = turn * p * 2.03 + vec2(3.1, 1.7);
    amp *= 0.5;
  }
  return sum / 0.875;
}
float dither() {
  return (hash12(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5) / 255.0;
}
// 1 inside [0, edge], fading to 0 at edge (smoothstep needs edge0 < edge1).
float fadeOut(float edge, float x) {
  return 1.0 - smoothstep(0.0, edge, x);
}
`;

/** Builds a fragment shader from the shared header, the noise chunk and an effect body. */
export function fragmentShader(body: string): string {
  return `${GLSL_HEADER}\n${GLSL_NOISE}\n${body}`;
}
