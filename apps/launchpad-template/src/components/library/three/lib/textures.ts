import * as THREE from 'three';

/**
 * Small textures drawn locally on a canvas (no image download): coin faces, soft glows, sparks and
 * contact shadows. The caller disposes them.
 */

function canvas(
  width: number,
  height = width,
): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(c);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** The heading font of the site, for monograms drawn on a canvas. */
export function headingFont(element: Element | null): string {
  if (!element) return 'Georgia, serif';
  return getComputedStyle(element).getPropertyValue('--font-heading').trim() || 'Georgia, serif';
}

/**
 * A coin face in greys (tinted by the material colour): raised rim rings, a ring of ticks, and the
 * monogram embossed in the centre. Also used as the bump map, so the relief catches the light.
 */
export function coinFaceTexture(monogram: string, font: string, size = 1024): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  if (ctx) {
    const mid = size / 2;
    const base = ctx.createRadialGradient(mid * 0.7, mid * 0.6, 0, mid, mid, mid);
    base.addColorStop(0, '#d9d9d9');
    base.addColorStop(1, '#a8a8a8');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    const ring = (radius: number, width: number, color: string) => {
      ctx.beginPath();
      ctx.arc(mid, mid, radius, 0, Math.PI * 2);
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    ring(mid * 0.95, mid * 0.07, '#f2f2f2');
    ring(mid * 0.86, mid * 0.012, '#7a7a7a');
    ring(mid * 0.66, mid * 0.01, '#8c8c8c');
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      const r0 = mid * 0.72;
      const r1 = mid * (i % 5 === 0 ? 0.81 : 0.77);
      ctx.beginPath();
      ctx.moveTo(mid + Math.cos(a) * r0, mid + Math.sin(a) * r0);
      ctx.lineTo(mid + Math.cos(a) * r1, mid + Math.sin(a) * r1);
      ctx.lineWidth = mid * 0.012;
      ctx.strokeStyle = '#efefef';
      ctx.stroke();
    }
    const glyphs = monogram.slice(0, 3) || '$';
    let fontSize = mid * (glyphs.length > 1 ? 0.62 : 0.86);
    ctx.font = `700 ${fontSize}px ${font}`;
    const measured = ctx.measureText(glyphs).width;
    if (measured > mid * 1.1) fontSize *= (mid * 1.1) / measured;
    ctx.font = `700 ${fontSize}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Fake emboss: a dark offset copy, then the raised glyph.
    ctx.fillStyle = '#6e6e6e';
    ctx.fillText(glyphs, mid + mid * 0.015, mid + mid * 0.05);
    ctx.fillStyle = '#fbfbfb';
    ctx.fillText(glyphs, mid, mid + mid * 0.035);
  }
  return toTexture(c);
}

/** Fine vertical reeding for the coin's edge. */
export function reedingTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 8);
  if (ctx) {
    for (let x = 0; x < 512; x += 4) {
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(x, 0, 2, 8);
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(x + 2, 0, 2, 8);
    }
  }
  return toTexture(c);
}

/** A soft round glow, white on transparent (tinted by the sprite colour). */
export function glowTexture(size = 128): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return toTexture(c);
}

/** A four-point star spark, white on transparent. */
export function sparkTexture(size = 128): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  if (ctx) {
    const m = size / 2;
    const g = ctx.createRadialGradient(m, m, 0, m, m, m * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(m, 0);
    ctx.quadraticCurveTo(m, m, size, m);
    ctx.quadraticCurveTo(m, m, m, size);
    ctx.quadraticCurveTo(m, m, 0, m);
    ctx.quadraticCurveTo(m, m, m, 0);
    ctx.fill();
  }
  return toTexture(c);
}
