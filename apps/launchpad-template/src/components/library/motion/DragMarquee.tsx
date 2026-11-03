import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { useCalm, useEntered } from './internal';

export interface DragMarqueeProps {
  /** The items of one lap (coin chips, phrases, partner names). They repeat seamlessly. */
  children: ReactNode;
  /** Accessible name of the ticker, for example "Trending coins". */
  label: string;
  /** Drift speed, in pixels per second. Default 40. */
  speed?: number;
  /** Drift direction. Default `left`. */
  direction?: 'left' | 'right';
  /** Space between items, in pixels. Default 40. */
  gap?: number;
  /** Fade the left and right edges. Default true. */
  fade?: boolean;
  /** Show a small pause/play button (recommended for content moving on its own). Default true. */
  pauseButton?: boolean;
  className?: string;
}

const MAX_THROW = 2400;

/**
 * An endless ticker that drifts on its own and can be grabbed and thrown: drag it, let go, and it
 * glides with inertia before settling back to its drift. For trending coins ("$PEPE $BONK $NAPS"),
 * a slogan band between sections or partner names. Stops on hover and keyboard focus; arrow keys
 * push it; a pause button stops it for good. Without motion it becomes a plain horizontal scroller.
 */
export function DragMarquee({
  children,
  label,
  speed = 40,
  direction = 'left',
  gap = 40,
  fade = true,
  pauseButton = true,
  className,
}: DragMarqueeProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const visible = useEntered(viewport, { once: false, margin: '100px' });
  const [paused, setPaused] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Mutable motion state, read by the animation loop without re-rendering.
  const s = useRef({
    x: 0,
    vel: 0,
    lap: 0,
    hover: false,
    focus: false,
    paused: false,
    drag: false,
  });
  const drag = useRef({ lastX: 0, lastT: 0, moved: 0 });

  useEffect(() => {
    s.current.paused = paused;
  }, [paused]);

  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const measure = () => {
      s.current.lap = el.offsetWidth;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [calm]);

  useEffect(() => {
    const el = track.current;
    if (calm || !visible || !el) {
      if (el && calm) el.style.transform = '';
      return;
    }
    const dir = direction === 'left' ? 1 : -1;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = s.current;
      if (!st.drag) {
        const drift = st.paused || st.hover || st.focus ? 0 : speed * dir;
        st.x -= (drift + st.vel) * dt;
        st.vel *= Math.exp(-dt * 2.2);
      }
      if (st.lap > 0) st.x = (((st.x % st.lap) + st.lap) % st.lap) - st.lap;
      el.style.transform = `translate3d(${st.x.toFixed(2)}px, 0, 0)`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [calm, visible, speed, direction]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (calm || e.button !== 0) return;
    s.current.drag = true;
    s.current.vel = 0;
    drag.current = { lastX: e.clientX, lastT: e.timeStamp, moved: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!s.current.drag) return;
    const d = drag.current;
    const dx = e.clientX - d.lastX;
    const dt = Math.max(1, e.timeStamp - d.lastT) / 1000;
    s.current.x += dx;
    s.current.vel = -dx / dt;
    d.moved += Math.abs(dx);
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!s.current.drag) return;
    s.current.drag = false;
    s.current.vel = Math.max(-MAX_THROW, Math.min(MAX_THROW, s.current.vel));
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  // A drag that ends on a link must not open it.
  const onClickCapture = (e: MouseEvent) => {
    if (drag.current.moved > 6) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = 0;
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (calm) return;
    if (e.key === 'ArrowRight') s.current.vel += 700;
    else if (e.key === 'ArrowLeft') s.current.vel -= 700;
    else return;
    e.preventDefault();
  };
  // Keyboard focus on an item: bring it into view (the box itself never scrolls natively).
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    s.current.focus = true;
    const box = viewport.current;
    if (calm || !box || e.target === box) return;
    box.scrollLeft = 0;
    const item = e.target as HTMLElement;
    const left = item.offsetLeft + s.current.x;
    if (left < 0 || left + item.offsetWidth > box.clientWidth) s.current.x = 24 - item.offsetLeft;
  };

  const edge = fade
    ? 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)'
    : undefined;

  return (
    <div
      role="region"
      aria-label={label}
      aria-roledescription="ticker"
      className={cn('fx-drag-marquee relative', className)}
    >
      <div
        ref={viewport}
        tabIndex={0}
        className={cn(
          'select-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
          calm ? 'overflow-x-auto' : 'touch-pan-y overflow-hidden',
          !calm && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        )}
        style={{ maskImage: calm ? undefined : edge, WebkitMaskImage: calm ? undefined : edge }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') s.current.hover = true;
        }}
        onPointerLeave={() => {
          s.current.hover = false;
        }}
        onFocus={onFocus}
        onBlur={() => {
          s.current.focus = false;
        }}
        onKeyDown={onKeyDown}
        onClickCapture={onClickCapture}
      >
        <div ref={track} className="flex w-max will-change-transform">
          <div
            ref={group}
            className="flex shrink-0 items-center"
            style={{ gap, paddingRight: gap }}
          >
            {children}
          </div>
          {!calm && (
            // The second lap only completes the loop visually: hidden from screen readers and Tab.
            <div
              className="flex shrink-0 items-center"
              style={{ gap, paddingRight: gap }}
              aria-hidden
              inert
            >
              {children}
            </div>
          )}
        </div>
      </div>
      {pauseButton && !calm && (
        <button
          type="button"
          aria-pressed={paused}
          aria-label={paused ? `Play ${label}` : `Pause ${label}`}
          onClick={() => setPaused((p) => !p)}
          className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
            {paused ? <path d="M4 2.5v11l9-5.5z" /> : <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />}
          </svg>
        </button>
      )}
    </div>
  );
}

export default DragMarquee;
