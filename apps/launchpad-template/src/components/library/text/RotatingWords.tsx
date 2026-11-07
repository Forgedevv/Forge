import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_EXPO, useCalm, useEntered } from '../motion/internal';

export interface RotatingWordsProps {
  /** Words or short phrases shown in turn. The first one is shown before any rotation. */
  words: readonly string[];
  /** Milliseconds each word stays. Default 2200. */
  interval?: number;
  /** Fill the words with the primary-to-accent gradient. Default true. */
  highlight?: boolean;
  /**
   * `current` (default): the slot glides to the width of the word on show, so a centred headline
   * stays centred. `longest`: the slot keeps the width of the longest word, nothing else moves.
   */
  fit?: 'current' | 'longest';
  /** Where shorter words sit when `fit` is `longest`. Default `start`. */
  align?: 'start' | 'center' | 'end';
  /** What screen readers hear instead of the rotation. Default: all words, comma separated. */
  srText?: string;
  className?: string;
}

/**
 * One slot inside a sentence that cycles through words: the current word slides up and out while
 * the next one rises in, and the slot glides to the new word's width. Put it inside a headline:
 * "Launch your [meme coin / community / next big idea]". The line height never changes. Pauses off
 * screen; holds the first word for reduced motion.
 */
export function RotatingWords({
  words,
  interval = 2200,
  highlight = true,
  fit = 'current',
  align = 'start',
  srText,
  className,
}: RotatingWordsProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const visible = useEntered(ref, { once: false, margin: '0px' });
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState<number | null>(null);
  const items = useRef<(HTMLSpanElement | null)[]>([]);
  const count = words.length;

  useEffect(() => {
    if (calm || !visible || count < 2) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setIndex((i) => (i + 1) % count);
    }, interval);
    return () => window.clearInterval(id);
  }, [calm, visible, count, interval]);

  const current = calm ? 0 : index % Math.max(1, count);
  const previous = (current - 1 + count) % Math.max(1, count);

  // Width of the word on show; re-measured when fonts finish loading and on resize.
  useEffect(() => {
    if (fit !== 'current') return;
    const measure = () => {
      const w = items.current[current]?.offsetWidth;
      if (w) setWidth(w);
    };
    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fit, current]);

  return (
    <span
      ref={ref}
      className={cn(
        'fx-rotating-words relative inline-grid overflow-hidden align-bottom',
        className,
      )}
      style={{
        justifyItems: fit === 'current' ? 'start' : align,
        width: fit === 'current' && width !== null ? width : undefined,
        transition: calm ? undefined : `width 0.6s ${CSS_EASE_EXPO}`,
        // Room for descenders inside the clip, taken back so the line height is unchanged.
        paddingBottom: '0.14em',
        marginBottom: '-0.14em',
      }}
    >
      <span className="sr-only">{srText ?? words.join(', ')}</span>
      {words.map((word, i) => {
        const state = i === current ? 'in' : i === previous && count > 1 ? 'out' : 'next';
        return (
          <span
            key={`${word}-${i}`}
            ref={(el) => {
              items.current[i] = el;
            }}
            aria-hidden="true"
            className={cn(
              'whitespace-nowrap [grid-area:1/1]',
              highlight &&
                'bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] bg-clip-text text-transparent',
            )}
            style={{
              transform:
                state === 'in'
                  ? 'none'
                  : state === 'out'
                    ? 'translateY(-105%)'
                    : 'translateY(105%)',
              opacity: state === 'in' ? 1 : 0,
              transition:
                calm || state === 'next'
                  ? 'none'
                  : `transform 0.75s ${CSS_EASE_EXPO}, opacity 0.5s ${CSS_EASE_EXPO}`,
            }}
          >
            {word}
          </span>
        );
      })}
    </span>
  );
}

export default RotatingWords;
