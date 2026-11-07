import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_CURTAIN, CSS_EASE_OUT, useCalm, useEntered } from '../motion/internal';

export interface MarkerHighlightProps {
  children: ReactNode;
  /**
   * `marker`: a slanted highlighter stroke sweeps behind the words (default).
   * `underline`: a thick underline draws itself left to right.
   * `circle`: a hand-drawn loop is traced around the words.
   */
  variant?: 'marker' | 'underline' | 'circle';
  /** Stroke colour. Default the primary colour (softened for `marker`). */
  color?: string;
  /** Seconds before drawing, once on screen. */
  delay?: number;
  className?: string;
}

/**
 * Words inside a sentence that get highlighted when they scroll into view: a highlighter stroke,
 * an underline or a hand-drawn circle traced around them. Draws the eye to the promise of a section
 * ("Launch a coin in *one minute*", "*zero* presale"). Plain CSS and SVG; the text stays real text.
 */
export function MarkerHighlight({
  children,
  variant = 'marker',
  color,
  delay = 0,
  className,
}: MarkerHighlightProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.8 });
  const shown = calm || entered;
  const transition = (duration: number, ease: string, property: string) =>
    calm ? 'none' : `${property} ${duration}s ${ease} ${delay}s`;

  return (
    <span
      ref={ref}
      className={cn('fx-marker relative isolate inline-block whitespace-nowrap', className)}
      data-state={shown ? 'shown' : 'hidden'}
    >
      {variant === 'marker' && (
        <span
          aria-hidden="true"
          className="absolute -z-10"
          style={{
            inset: '0.12em -0.18em 0.02em',
            borderRadius: '0.2em 0.35em 0.25em 0.4em',
            background: color ?? 'color-mix(in srgb, var(--color-primary) 38%, transparent)',
            transform: `skewX(-10deg) scaleX(${shown ? 1 : 0})`,
            transformOrigin: 'left center',
            transition: transition(0.8, CSS_EASE_CURTAIN, 'transform'),
          }}
        />
      )}
      {variant === 'underline' && (
        <span
          aria-hidden="true"
          className="absolute -z-10"
          style={{
            left: 0,
            right: 0,
            bottom: '0.02em',
            height: '0.14em',
            borderRadius: '999px',
            background:
              color ?? 'linear-gradient(90deg, var(--color-primary), var(--color-accent))',
            transform: `scaleX(${shown ? 1 : 0})`,
            transformOrigin: 'left center',
            transition: transition(0.9, CSS_EASE_OUT, 'transform'),
          }}
        />
      )}
      {variant === 'circle' && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute -z-10 overflow-visible"
          style={{
            inset: '-0.32em -0.5em',
            width: 'calc(100% + 1em)',
            height: 'calc(100% + 0.64em)',
          }}
          viewBox="0 0 200 60"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M14 34C10 14 176 4 190 26C202 46 52 60 14 42C-4 32 40 10 112 9"
            pathLength={1}
            strokeWidth={3}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{
              stroke: color ?? 'var(--color-primary)',
              strokeDasharray: 1,
              strokeDashoffset: shown ? 0 : 1,
              transition: transition(1.1, CSS_EASE_OUT, 'stroke-dashoffset'),
            }}
          />
        </svg>
      )}
      {children}
    </span>
  );
}

export default MarkerHighlight;
