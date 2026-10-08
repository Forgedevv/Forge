import type { Look, Muse } from './engine';

/**
 * One requestAnimationFrame loop shared by every Muse on the page. Views render only while
 * on screen (IntersectionObserver) and the loop stops while the tab is hidden. Reduced-motion
 * views draw once per change instead of every frame.
 */

export interface MuseView {
  canvas: HTMLCanvasElement;
  muse: Muse;
  /** Box size in CSS pixels; the canvas may be larger so the glow can breathe. */
  canvasSize: number;
  /** Body radius as a fraction of the canvas size. */
  rf: number;
  /** Follow the pointer with the eyes. */
  gaze: boolean;
}

interface Entry {
  view: MuseView;
  ctx: CanvasRenderingContext2D | null;
  visible: boolean;
  /** Needs a backing-store resize before the next draw. */
  resize: boolean;
  /** Reduced motion: needs one more draw. */
  stale: boolean;
  dpr: number;
  rect: DOMRect | null;
}

const entries = new Map<HTMLCanvasElement, Entry>();
const pointer = { x: 0, y: 0, active: false, last: 0 };
let frame = 0;
let last = 0;
let rectsDirty = true;
let observer: IntersectionObserver | null = null;
let listening = false;

/** Distance, in CSS pixels, at which the gaze reaches about three quarters of its range. */
const GAZE_DISTANCE = 280;
/** The gaze returns to an idle wander this long after the pointer stops moving. */
const GAZE_TIMEOUT_MS = 6000;

function onPointer(event: PointerEvent) {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.active = true;
  pointer.last = performance.now();
}
function onLeave(event: MouseEvent) {
  if (!event.relatedTarget) pointer.active = false;
}
function onLayout() {
  rectsDirty = true;
}
function onVisibility() {
  if (document.hidden) stop();
  else {
    last = performance.now();
    schedule();
  }
}

function lookFrom(px: number, py: number): Look | null {
  if (!pointer.active || performance.now() - pointer.last > GAZE_TIMEOUT_MS) return null;
  return {
    x: Math.tanh((pointer.x - px) / GAZE_DISTANCE),
    y: Math.tanh((pointer.y - py) / GAZE_DISTANCE),
  };
}

function listen(on: boolean) {
  if (on === listening || typeof window === 'undefined') return;
  listening = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('pointermove', onPointer as EventListener, { passive: true });
  document[method]('mouseout', onLeave as EventListener);
  window[method]('scroll', onLayout, { passive: true, capture: true });
  window[method]('resize', onLayout);
  document[method]('visibilitychange', onVisibility);
}

function needsFrame() {
  for (const e of entries.values())
    if (e.visible && (!e.view.muse.reduced || e.stale || e.resize)) return true;
  return false;
}
function schedule() {
  if (frame || typeof document === 'undefined' || document.hidden || !needsFrame()) return;
  if (!last) last = performance.now();
  frame = requestAnimationFrame(tick);
}
function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

function draw(e: Entry, dt: number, refreshRect: boolean) {
  const { canvas, muse, canvasSize: size, rf, gaze } = e.view;
  if (e.resize) {
    e.resize = false;
    e.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const px = Math.max(1, Math.round(size * e.dpr));
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    e.ctx ??= canvas.getContext('2d');
    refreshRect = true;
  }
  const ctx = e.ctx;
  let look: Look | null = null;
  if (gaze) {
    if (!e.rect || refreshRect) e.rect = canvas.getBoundingClientRect();
    look = lookFrom(e.rect.left + e.rect.width / 2, e.rect.top + e.rect.height / 2);
  }
  muse.update(dt, look);
  if (!ctx) return;
  ctx.setTransform(e.dpr, 0, 0, e.dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  muse.render(ctx, size, { rf, maxR: size / 2 });
  e.stale = false;
}

function tick(now: number) {
  frame = 0;
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  const refreshRects = rectsDirty;
  rectsDirty = false;
  for (const e of entries.values()) {
    if (!e.visible) continue;
    if (e.view.muse.reduced && !e.stale && !e.resize) continue;
    draw(e, e.view.muse.reduced ? 1 / 60 : dt, refreshRects);
  }
  schedule();
}

/** Starts animating a view. Returns a function that stops and forgets it. */
export function addView(view: MuseView): () => void {
  const entry: Entry = {
    view,
    ctx: null,
    visible: typeof IntersectionObserver === 'undefined',
    resize: true,
    stale: true,
    dpr: 1,
    rect: null,
  };
  entries.set(view.canvas, entry);
  listen(true);
  if (typeof IntersectionObserver !== 'undefined') {
    observer ??= new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const e = entries.get(record.target as HTMLCanvasElement);
          if (e) e.visible = record.isIntersecting;
        }
        rectsDirty = true;
        schedule();
      },
      { rootMargin: '80px' },
    );
    observer.observe(view.canvas);
  }
  schedule();
  return () => {
    observer?.unobserve(view.canvas);
    entries.delete(view.canvas);
    if (!entries.size) {
      stop();
      last = 0;
      listen(false);
      observer?.disconnect();
      observer = null;
    }
  };
}

/** Marks a view as changed (size, mood or colors) so reduced-motion views redraw. */
export function touchView(canvas: HTMLCanvasElement, resized = false) {
  const e = entries.get(canvas);
  if (!e) return;
  e.stale = true;
  if (resized) e.resize = true;
  schedule();
}

/** Number of registered views, for tests. */
export const viewCount = () => entries.size;
