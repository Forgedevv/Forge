import { useRef } from 'react';
import { EffectLayer, FillCanvas } from './lib/CanvasLayer';
import { mixRgb, rgbCss, useEffectColors, type EffectColors } from './lib/color';
import type { BackgroundProps } from './lib/ShaderBackground';
import { useCanvasScene, useLatest } from './lib/useCanvasScene';

export interface AsciiMonogramProps extends BackgroundProps {
  /** One to three characters drawn as the shape, for example the coin's ticker initial. */
  text?: string;
  /** Size of a glyph cell, in CSS pixels. */
  cellSize?: number;
  /** CSS font family of the shape; defaults to the theme heading font. */
  fontFamily?: string;
  /** The pointer leaves a wake of bright glyphs. */
  followPointer?: boolean;
}

const RAMP = ' .:-=+*#%@';
const REACH = 64;
const BUCKETS = 6;

function cellHash(i: number, salt: number): number {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

interface AsciiCanvasProps {
  inView: boolean;
  colors?: EffectColors;
  text: string;
  cellSize: number;
  fontFamily?: string;
  followPointer: boolean;
}

function AsciiCanvas({
  inView,
  colors,
  text,
  cellSize,
  fontFamily,
  followPointer,
}: AsciiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useEffectColors(colors);
  const live = useLatest({ theme });

  useCanvasScene(
    canvasRef,
    ({ ctx, canvas, pointer }) => {
      let width = 0;
      let height = 0;
      let cols = 0;
      let rows = 0;
      let cell = cellSize;
      let mask = new Float32Array(0);
      let heat = new Float32Array(0);
      let disposed = false;
      const last = { x: Number.NaN, y: Number.NaN };

      const family = () =>
        fontFamily ??
        (getComputedStyle(canvas).getPropertyValue('--font-heading').trim() || 'Georgia, serif');

      const buildMask = () => {
        cell = width < 520 ? Math.max(8, cellSize - 2) : cellSize;
        cols = Math.ceil(width / cell);
        rows = Math.ceil(height / cell);
        mask = new Float32Array(cols * rows);
        heat = new Float32Array(cols * rows);
        const off = document.createElement('canvas');
        off.width = cols;
        off.height = rows;
        const o = off.getContext('2d');
        if (!o || cols === 0 || rows === 0) return;
        const glyphs = text.slice(0, 3) || '$';
        let size = rows * 0.82;
        o.font = `700 ${size}px ${family()}`;
        const measured = o.measureText(glyphs).width;
        if (measured > cols * 0.86) size *= (cols * 0.86) / measured;
        o.font = `700 ${size}px ${family()}`;
        o.textAlign = 'center';
        o.textBaseline = 'middle';
        o.fillStyle = '#fff';
        o.fillText(glyphs, cols / 2, rows / 2 + size * 0.04);
        const data = o.getImageData(0, 0, cols, rows).data;
        for (let i = 0; i < cols * rows; i++) mask[i] = (data[i * 4 + 3] ?? 0) / 255;
      };

      const deposit = (x0: number, y0: number, x1: number, y1: number) => {
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cell * 0.7)));
        for (let s = 0; s <= steps; s++) {
          const x = x0 + ((x1 - x0) * s) / steps;
          const y = y0 + ((y1 - y0) * s) / steps;
          const c0 = Math.max(0, Math.floor((x - REACH) / cell));
          const c1 = Math.min(cols - 1, Math.ceil((x + REACH) / cell));
          const r0 = Math.max(0, Math.floor((y - REACH) / cell));
          const r1 = Math.min(rows - 1, Math.ceil((y + REACH) / cell));
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const d = Math.hypot(c * cell + cell / 2 - x, r * cell + cell / 2 - y) / REACH;
              if (d >= 1) continue;
              const i = r * cols + c;
              const v = (1 - d) * (1 - d);
              if (v > (heat[i] ?? 0)) heat[i] = v;
            }
          }
        }
      };

      if (typeof document !== 'undefined' && document.fonts?.ready) {
        void document.fonts.ready.then(() => {
          if (!disposed && width > 0) buildMask();
        });
      }

      return {
        resize(w, h) {
          width = w;
          height = h;
          buildMask();
        },
        draw(time, dt) {
          const c = live.current.theme;
          ctx.clearRect(0, 0, width, height);
          const cool = Math.exp(-dt * 1.8);
          for (let i = 0; i < heat.length; i++) heat[i] = (heat[i] ?? 0) * cool;
          if (pointer?.inside && dt > 0) {
            if (Number.isNaN(last.x)) deposit(pointer.x, pointer.y, pointer.x, pointer.y);
            else deposit(last.x, last.y, pointer.x, pointer.y);
            last.x = pointer.x;
            last.y = pointer.y;
          } else {
            last.x = Number.NaN;
          }
          // A ring of light leaving the centre every few seconds.
          const period = 6;
          const age = time % period;
          const ringRadius = (age / 2.4) * Math.hypot(width, height) * 0.5;
          const ringFade = Math.max(0, 1 - age / 2.4);

          ctx.font = `500 ${cell * 1.02}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const groups: { text: string; x: number; y: number }[][] = Array.from(
            { length: BUCKETS },
            () => [],
          );
          const dots: number[] = [];
          for (let r = 0; r < rows; r++) {
            for (let col = 0; col < cols; col++) {
              const i = r * cols + col;
              const x = col * cell + cell / 2;
              const y = r * cell + cell / 2;
              const m = mask[i] ?? 0;
              const ring =
                ringFade > 0
                  ? Math.max(
                      0,
                      1 -
                        Math.abs(Math.hypot(x - width / 2, y - height / 2) - ringRadius) /
                          (cell * 2.5),
                    ) * ringFade
                  : 0;
              const h = Math.min(1, (heat[i] ?? 0) + ring * 0.6);
              if (m < 0.05 && h < 0.08) {
                if ((col + r) % 2 === 0) dots.push(x, y);
                continue;
              }
              const sweep = 0.5 + 0.5 * Math.sin(x * 0.012 + y * 0.008 - time * 1.4);
              const level = Math.min(1, m * (0.5 + 0.4 * sweep) + h * 0.75);
              let index = Math.round(level * (RAMP.length - 1));
              // Glyphs flicker to a neighbour now and then.
              if (cellHash(i, Math.floor(time * 3 + cellHash(i, 1) * 9)) > 0.86) index += 1;
              index = Math.max(1, Math.min(RAMP.length - 1, index));
              const bucket = Math.min(BUCKETS - 1, Math.floor(level * BUCKETS));
              groups[bucket]?.push({ text: RAMP[index] ?? '.', x, y });
            }
          }
          ctx.fillStyle = rgbCss(c.text, 0.14);
          for (let k = 0; k < dots.length; k += 2) {
            ctx.fillRect((dots[k] ?? 0) - 0.6, (dots[k + 1] ?? 0) - 0.6, 1.2, 1.2);
          }
          groups.forEach((cells, bucket) => {
            const t = (bucket + 0.5) / BUCKETS;
            ctx.fillStyle = rgbCss(mixRgb(c.primary, c.accent, t * t), 0.35 + t * 0.65);
            for (const g of cells) ctx.fillText(g.text, g.x, g.y);
          });
        },
        dispose() {
          disposed = true;
        },
      };
    },
    { inView, followPointer, fps: 30, deps: [text, cellSize, fontFamily] },
  );
  return <FillCanvas ref={canvasRef} />;
}

/**
 * ASCII monogram: a character (the coin's initial, a "$", a symbol...) drawn as a field of ASCII
 * glyphs in the theme colours, with a light sweeping through it, glyphs flickering, a ring of light
 * pulsing out every few seconds and a bright wake behind the pointer. Retro-tech; a hero visual next
 * to the headline, or a full-width band.
 */
export function AsciiMonogram({
  text = '$',
  cellSize = 12,
  fontFamily,
  followPointer = true,
  colors,
  className,
  style,
}: AsciiMonogramProps) {
  return (
    <EffectLayer
      className={className}
      style={style}
      fallback={
        <div style={{ position: 'absolute', inset: 0, containerType: 'size' }}>
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              height: '100%',
              font: `700 min(70cqh, 60cqw) / 1 ${fontFamily ?? 'var(--font-heading)'}`,
              color: 'color-mix(in srgb, var(--color-primary) 30%, transparent)',
            }}
          >
            {text.slice(0, 3)}
          </div>
        </div>
      }
    >
      {({ inView }) => (
        <AsciiCanvas
          inView={inView}
          colors={colors}
          text={text}
          cellSize={cellSize}
          fontFamily={fontFamily}
          followPointer={followPointer}
        />
      )}
    </EffectLayer>
  );
}
