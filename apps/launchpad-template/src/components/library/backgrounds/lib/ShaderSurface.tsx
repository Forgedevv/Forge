import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion, type ThemeColors } from '../../shared';
import { isDarkColor } from './color';
import { createFullscreenProgram, type UniformValue } from './gl';
import { easeFactor, observeSize, trackPointer } from './pointer';

export interface ShaderSurfaceProps {
  /** Full fragment shader source (see `fragmentShader`). */
  fragment: string;
  /** From `EffectFrame`: the loop only runs while the effect is on screen. */
  inView: boolean;
  colors: ThemeColors;
  /** Effect uniforms, on top of the shared ones. Changing them does not rebuild the program. */
  uniforms?: Readonly<Record<string, UniformValue>>;
  /** Time multiplier. */
  speed?: number;
  /** Highest device pixel ratio used for the drawing buffer. */
  maxPixelRatio?: number;
  /** Ease `uPointer` towards the visitor's pointer while it is over the effect. */
  followPointer?: boolean;
  /** Where `uPointer` rests when the pointer is away (0..1, from the bottom-left corner). */
  pointerRest?: readonly [number, number];
  /** Time of the single frame drawn under reduced motion. */
  stillTime?: number;
  /** Shown instead of the canvas if the shader cannot run after all. */
  fallback?: ReactNode;
}

const CANVAS_STYLE = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
} as const;

/**
 * Draws a full-screen fragment shader that fills its parent. Pauses off screen, draws one still frame
 * under reduced motion, caps the pixel ratio, follows size changes and frees the GPU on unmount.
 */
export function ShaderSurface({
  fragment,
  inView,
  colors,
  uniforms,
  speed = 1,
  maxPixelRatio = 1.5,
  followPointer = false,
  pointerRest = [0.5, 0.5],
  stillTime = 12,
  fallback,
}: ShaderSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const live = useRef({ colors, uniforms, speed, pointerRest, stillTime });
  const control = useRef<{ setRunning(on: boolean): void; redraw(): void } | null>(null);

  // Keep the latest props for the render loop; redraw the still frame when they change.
  useEffect(() => {
    live.current = { colors, uniforms, speed, pointerRest, stillTime };
    control.current?.redraw();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const surface = createFullscreenProgram(canvas, fragment);
    if (!surface) {
      setFailed(true);
      return;
    }
    const pointer = followPointer ? trackPointer(canvas, 40) : null;
    const rest = live.current.pointerRest;
    const eased = { x: rest[0], y: rest[1] };
    let time = live.current.stillTime;
    let running = false;
    let frame = 0;
    let last = 0;

    const draw = () => {
      const { colors: c, uniforms: extra } = live.current;
      surface.setUniforms({
        uTime: time,
        uPointer: [eased.x, eased.y],
        uPrimary: c.primary,
        uAccent: c.accent,
        uBg: c.background,
        uInk: c.text,
        uDark: isDarkColor(c.background) ? 1 : 0,
        ...extra,
      });
      surface.draw();
    };
    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      time += dt * live.current.speed;
      if (pointer) {
        const [rx, ry] = live.current.pointerRest;
        const rect = canvas.getBoundingClientRect();
        const target = pointer.state.inside
          ? { x: pointer.state.x / rect.width, y: 1 - pointer.state.y / rect.height }
          : { x: rx, y: ry };
        const k = easeFactor(pointer.state.inside ? 3 : 1, dt);
        eased.x += (target.x - eased.x) * k;
        eased.y += (target.y - eased.y) * k;
      }
      draw();
      if (surface.lost) {
        running = false;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const setRunning = (on: boolean) => {
      if (on === running) return;
      running = on;
      if (on) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(frame);
      }
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      surface.resize(rect.width, rect.height, ratio);
      if (!running) draw();
    };
    const stopObserving = observeSize(canvas, resize);
    control.current = {
      setRunning,
      redraw: () => {
        if (!running) draw();
      },
    };
    resize();
    return () => {
      control.current = null;
      cancelAnimationFrame(frame);
      stopObserving();
      pointer?.stop();
      surface.dispose();
    };
  }, [fragment, followPointer, maxPixelRatio]);

  useEffect(() => {
    control.current?.setRunning(inView && !reduced);
  }, [inView, reduced, fragment, followPointer, maxPixelRatio]);

  if (failed) return <>{fallback}</>;
  return <canvas ref={canvasRef} style={CANVAS_STYLE} />;
}
