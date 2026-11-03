import { useEffect, useState, type RefObject } from 'react';

/**
 * True while the element is on screen (with a margin). Effects pause their animation loop when it
 * turns false, so a page full of effects only animates what the visitor sees.
 */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px'): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      rootMargin,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}
