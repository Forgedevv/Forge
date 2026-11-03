/**
 * Pointer position over an element whose pointer events are off: the effects stay click-through
 * and still follow the visitor's pointer, read from the window.
 */
export interface PointerState {
  /** Pointer position in CSS pixels, relative to the element's top-left corner. */
  x: number;
  y: number;
  /** True while the pointer is over the element (or near it, within `margin`). */
  inside: boolean;
  /** Time of the last move, from `performance.now()`. */
  movedAt: number;
}

export function trackPointer(
  element: Element,
  margin = 0,
): {
  state: PointerState;
  stop: () => void;
} {
  const state: PointerState = { x: 0, y: 0, inside: false, movedAt: 0 };
  const onMove = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    state.x = event.clientX - rect.left;
    state.y = event.clientY - rect.top;
    state.inside =
      state.x >= -margin &&
      state.y >= -margin &&
      state.x <= rect.width + margin &&
      state.y <= rect.height + margin;
    state.movedAt = performance.now();
  };
  const onLeave = () => {
    state.inside = false;
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  return {
    state,
    stop: () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    },
  };
}

/** Frame-rate independent easing factor towards a target (`rate` per second). */
export function easeFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Calls `onResize` when the element's size changes (window resize without ResizeObserver). */
export function observeSize(element: Element, onResize: () => void): () => void {
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => onResize());
    observer.observe(element);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}
