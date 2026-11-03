import { useEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from '../../shared';
import { observeSize, trackPointer, type PointerState } from './pointer';

export interface CanvasSceneContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  /** Window pointer relative to the canvas, or null when the effect does not follow it. */
  pointer: PointerState | null;
}

export interface CanvasScene {
  /** Called on start and on every size change, in CSS pixels. */
  resize(width: number, height: number): void;
  /** Draws one frame. `time` is in seconds; `dt` is 0 for still frames. */
  draw(time: number, dt: number): void;
  dispose?(): void;
}

export interface CanvasSceneOptions {
  inView: boolean;
  followPointer?: boolean;
  maxPixelRatio?: number;
  /** Time of the single frame drawn under reduced motion. */
  stillTime?: number;
  /** Frame cap, for scenes that do not need 60 fps. */
  fps?: number;
  /** The scene is rebuilt when one of these changes. */
  deps?: readonly unknown[];
}

/** Keeps a ref on the latest value, for render loops that must not restart on every render. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Runs a canvas 2D scene: sizes the canvas for the pixel ratio, loops only while on screen and not
 * under reduced motion (one still frame then), redraws the still frame when the component renders
 * again (for example after a theme change) and cleans up on unmount.
 */
export function useCanvasScene(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  create: (context: CanvasSceneContext) => CanvasScene,
  {
    inView,
    followPointer = false,
    maxPixelRatio = 2,
    stillTime = 6,
    fps = 60,
    deps = [],
  }: CanvasSceneOptions,
): void {
  const reduced = useReducedMotion();
  const createRef = useLatest(create);
  const settings = useLatest({ stillTime, fps });
  const control = useRef<{ setRunning(on: boolean): void; redraw(): void } | null>(null);

  useEffect(() => {
    control.current?.redraw();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const context = ctx;
    const pointer = followPointer ? trackPointer(canvas, 24) : null;
    const scene = createRef.current({ ctx: context, canvas, pointer: pointer?.state ?? null });
    let time = settings.current.stillTime;
    let running = false;
    let frame = 0;
    let last = 0;
    let lastDraw = 0;
    let ready = false;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const minGap = 1000 / settings.current.fps - 2;
      if (now - lastDraw < minGap) return;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      lastDraw = now;
      time += dt;
      if (ready) scene.draw(time, dt);
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
      if (rect.width < 1 || rect.height < 1) return;
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      scene.resize(rect.width, rect.height);
      ready = true;
      if (!running) scene.draw(time, 0);
    };
    const stopObserving = observeSize(canvas, resize);
    control.current = {
      setRunning,
      redraw: () => {
        if (!running && ready) scene.draw(time, 0);
      },
    };
    resize();
    return () => {
      control.current = null;
      cancelAnimationFrame(frame);
      stopObserving();
      pointer?.stop();
      scene.dispose?.();
    };
    // `deps` lists the scene's own inputs; their count must not change between renders.
  }, [canvasRef, followPointer, maxPixelRatio, ...deps]);

  useEffect(() => {
    control.current?.setRunning(inView && !reduced);
  }, [inView, reduced, followPointer, maxPixelRatio, ...deps]);
}
