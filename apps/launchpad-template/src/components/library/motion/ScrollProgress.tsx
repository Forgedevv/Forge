import { motion, useScroll, useSpring } from 'motion/react';
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useCalm } from './internal';

export interface ScrollProgressProps {
  /**
   * Scrolling element to follow when it is not the page (a scroll box, the showcase demo). The bar
   * is then sticky at the top of that box instead of fixed to the window. The box needs
   * `position: relative`.
   */
  container?: RefObject<HTMLElement | null>;
  /** Edge of the window (or box) the bar sits on. Default `top`. */
  position?: 'top' | 'bottom';
  /** Bar thickness, in pixels. Default 3. */
  thickness?: number;
  /** Soft glow under the bar. Default true. */
  glow?: boolean;
  className?: string;
}

/**
 * A thin primary-to-accent bar along the top of the window that fills as the visitor reads down
 * the page, with a light spring and a soft glow. For long pages: the coin page, the docs, the
 * "how it works" story. Decorative (the browser scrollbar already conveys the position).
 */
export function ScrollProgress({
  container,
  position = 'top',
  thickness = 3,
  glow = true,
  className,
}: ScrollProgressProps) {
  const calm = useCalm();
  const { scrollYProgress } = useScroll({ container });
  const smooth = useSpring(scrollYProgress, { stiffness: 180, damping: 30, mass: 0.4 });

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none inset-x-0 z-50',
        container ? 'sticky' : 'fixed',
        position === 'top' ? 'top-0' : 'bottom-0',
        className,
      )}
      style={{ height: thickness }}
    >
      <motion.div
        className="h-full origin-left rounded-r-full"
        style={{
          scaleX: calm ? scrollYProgress : smooth,
          background: 'linear-gradient(90deg, var(--color-primary), var(--color-accent))',
          boxShadow: glow
            ? '0 0 12px 1px color-mix(in srgb, var(--color-accent) 55%, transparent)'
            : undefined,
        }}
      />
    </div>
  );
}

export default ScrollProgress;
