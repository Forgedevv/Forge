import { useEffect, useState, type RefObject } from 'react';
import { useReducedMotion } from '../shared';

/**
 * Helpers shared by the `text` and `motion` families of the visual library. Not an effect: nothing
 * here is registered in the catalogue.
 */

/** easeOutQuint: the default reveal curve (fast start, long soft landing). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** easeOutExpo: for numbers and longer reveals. */
export const EASE_EXPO = [0.19, 1, 0.22, 1] as const;
/** Curtain curve: slow, slow, then a decisive move, for masks and panels. */
export const EASE_CURTAIN = [0.7, 0, 0.15, 1] as const;
/** CSS forms of the same curves, for transitions written in style attributes. */
export const CSS_EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const CSS_EASE_EXPO = 'cubic-bezier(0.19, 1, 0.22, 1)';
export const CSS_EASE_CURTAIN = 'cubic-bezier(0.7, 0, 0.15, 1)';
/** Slight overshoot, for digits and small pieces that land. */
export const CSS_EASE_BACK = 'cubic-bezier(0.34, 1.45, 0.64, 1)';

/**
 * The visitor's reduced-motion preference, but only once the component has mounted. The first
 * render is therefore the same on the server and during hydration (the animated "before" frame);
 * reduced-motion visitors get the final frame right after, without any animation.
 */
export function useCalm(): boolean {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && reduced;
}

interface EnteredOptions {
  /** IntersectionObserver root margin. The default waits until the element is 10% inside. */
  margin?: string;
  /** Share of the element that must be visible, from 0 to 1. */
  amount?: number;
  /** Stay true after the first entry (default). When false, follows the element in and out. */
  once?: boolean;
}

/**
 * True when the element has entered the viewport. Without IntersectionObserver (old browsers,
 * tests) it turns true right after mount, so the content is never left hidden.
 */
export function useEntered(
  ref: RefObject<Element | null>,
  { margin = '0px 0px -10% 0px', amount = 0, once = true }: EnteredOptions = {},
): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setEntered(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setEntered(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setEntered(false);
        }
      },
      { rootMargin: margin, threshold: amount },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin, amount, once]);
  return entered;
}

/** A React `useId` value made safe for SVG `url(#...)` references and CSS selectors. */
export function cssSafeId(id: string): string {
  return `fx${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
