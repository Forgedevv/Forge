import * as T from 'three';

/**
 * Procedural textures for the 3D Muse, computed pixel by pixel so they need no canvas, no
 * image file and no network (they also work in tests).
 */

function texture(size: number, pixel: (x: number, y: number) => [number, number]) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 - 1,
        y = ((j + 0.5) / size) * 2 - 1;
      const [white, alpha] = pixel(x, y);
      const o = (j * size + i) * 4;
      const w = Math.round(255 * Math.min(1, white));
      data[o] = data[o + 1] = data[o + 2] = w;
      data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha)));
    }
  const result = new T.DataTexture(data, size, size, T.RGBAFormat);
  result.colorSpace = T.SRGBColorSpace;
  result.magFilter = T.LinearFilter;
  result.minFilter = T.LinearMipmapLinearFilter;
  result.generateMipmaps = true;
  result.needsUpdate = true;
  return result;
}

/** A soft radial glow, brightest at the center. */
export function createGlowTexture(size = 64) {
  return texture(size, (x, y) => {
    const d = Math.hypot(x, y);
    const a = Math.max(0, 1 - d);
    return [1, a * a * (0.65 + 0.35 * a)];
  });
}

/**
 * The FORGE four-point spark with concave sides and a soft halo. The sides follow a
 * superellipse with exponent 0.6, which matches the 2D spark's curve.
 */
export function createSparkTexture(size = 128) {
  const tip = 0.46;
  const edge = 1.6 / size;
  return texture(size, (x, y) => {
    const f = Math.pow(Math.abs(x) / tip, 0.6) + Math.pow(Math.abs(y) / tip, 0.6);
    const core = Math.min(1, Math.max(0, (1 + edge * 4 - f) / (edge * 8)));
    const d = Math.hypot(x, y);
    const halo = Math.pow(Math.max(0, 1 - d), 2.2) * 0.42;
    return [1, Math.max(core, halo)];
  });
}
