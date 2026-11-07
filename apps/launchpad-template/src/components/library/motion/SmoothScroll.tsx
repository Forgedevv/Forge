import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type Lenis from 'lenis';
import { cn } from '@/lib/utils';
import { useCalm } from './internal';

/** The rules Lenis needs. The theme's `scroll-behavior: smooth` must be off under Lenis. */
const CSS = `
html.lenis, html.lenis body { height: auto; }
.lenis.lenis-smooth { scroll-behavior: auto !important; }
.lenis.lenis-smooth [data-lenis-prevent] { overscroll-behavior: contain; }
.lenis.lenis-stopped { overflow: hidden; }
.lenis.lenis-smooth iframe { pointer-events: none; }
`;

interface SmoothScrollApi {
  /** Scrolls to an element, a CSS selector or a pixel offset, smoothly when active. */
  scrollTo: (target: HTMLElement | string | number, offset?: number) => void;
}

const SmoothScrollContext = createContext<SmoothScrollApi | null>(null);

/** Inside `<SmoothScroll>`: smooth programmatic scrolling (falls back to native scrolling). */
export function useSmoothScroll(): SmoothScrollApi {
  return (
    useContext(SmoothScrollContext) ?? {
      scrollTo: (target) => {
        if (typeof target === 'number') window.scrollTo({ top: target, behavior: 'smooth' });
        else {
          const el = typeof target === 'string' ? document.querySelector(target) : target;
          el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        }
      },
    }
  );
}

export interface SmoothScrollProps {
  children: ReactNode;
  /** Smoothing factor: lower is silkier, higher is snappier. Default 0.1. */
  lerp?: number;
  /**
   * Smooth a scroll box of its own instead of the page: the component renders a full-height
   * scrollable container. Used by the showcase demo; sites normally wrap the whole page.
   */
  contained?: boolean;
  /** Offset for in-page anchor links, in pixels (negative keeps room for a sticky header). */
  anchorOffset?: number;
  className?: string;
}

/**
 * Opt-in inertial smooth scrolling (Lenis): wheel scrolling glides with a soft, weighted ease, and
 * in-page anchor links ("#how-it-works") travel with the same curve. Wrap the page once, in the
 * layout. Off for reduced motion and on touch screens, which keep their native momentum; keyboard
 * scrolling is never intercepted. The library is only downloaded when it is used.
 */
export function SmoothScroll({
  children,
  lerp = 0.1,
  contained = false,
  anchorOffset = -80,
  className,
}: SmoothScrollProps) {
  const calm = useCalm();
  const wrapper = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lenis = useRef<Lenis | null>(null);

  useEffect(() => {
    if (calm) return;
    if (!contained && window.matchMedia?.('(pointer: coarse)').matches) return;
    // Lenis measures with ResizeObserver; without it, native scrolling stays.
    if (typeof ResizeObserver === 'undefined') return;
    let cancelled = false;
    let instance: Lenis | null = null;
    import('lenis')
      .then(({ default: LenisClass }) => {
        if (cancelled) return;
        instance = new LenisClass({
          lerp,
          autoRaf: true,
          anchors: { offset: anchorOffset },
          // Scroll boxes inside the page (the Jupiter token list, dialogs, tables) keep their own
          // wheel scrolling instead of moving the page.
          allowNestedScroll: true,
          ...(contained && wrapper.current && content.current
            ? { wrapper: wrapper.current, content: content.current, eventsTarget: wrapper.current }
            : {}),
        });
        lenis.current = instance;
      })
      // Smooth scrolling is an enhancement: if it cannot start, the native scroll stays.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      instance?.destroy();
      lenis.current = null;
    };
  }, [calm, contained, lerp, anchorOffset]);

  const scrollTo = useCallback<SmoothScrollApi['scrollTo']>(
    (target, offset = anchorOffset) => {
      const el =
        typeof target === 'string'
          ? (wrapper.current ?? document).querySelector<HTMLElement>(target)
          : target;
      if (lenis.current && el !== null) {
        lenis.current.scrollTo(el, { offset: typeof el === 'number' ? 0 : offset });
        return;
      }
      if (typeof el === 'number') {
        (contained ? wrapper.current : window)?.scrollTo({ top: el, behavior: 'smooth' });
      } else {
        el?.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      }
    },
    [anchorOffset, calm, contained],
  );
  const api = useMemo(() => ({ scrollTo }), [scrollTo]);

  return (
    <SmoothScrollContext.Provider value={api}>
      <style>{CSS}</style>
      {contained ? (
        <div ref={wrapper} className={cn('h-full overflow-y-auto overscroll-contain', className)}>
          <div ref={content}>{children}</div>
        </div>
      ) : (
        children
      )}
    </SmoothScrollContext.Provider>
  );
}

export default SmoothScroll;
