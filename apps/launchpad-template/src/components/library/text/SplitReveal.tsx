import { motion, type Variants } from 'motion/react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { EASE_OUT, useCalm, useEntered } from '../motion/internal';

type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'span' | 'div';

export interface SplitRevealProps {
  /** The full string. Screen readers read it once, as plain text. */
  text: string;
  /** Element to render. Default `h2`. */
  as?: TextTag;
  /** Animate letter by letter (default) or word by word. */
  split?: 'chars' | 'words';
  /**
   * `rise`: each piece slides up out of a mask (default).
   * `flip`: each piece flips up around its baseline, with a springy landing.
   * `drop`: each piece falls in from above, out of a mask.
   */
  effect?: 'rise' | 'flip' | 'drop';
  /** Seconds between two pieces. Default 0.028 for letters, 0.07 for words. */
  stagger?: number;
  /** Seconds before the first piece moves. */
  delay?: number;
  className?: string;
}

/**
 * Hero headline that assembles itself: letters (or words) slide up out of invisible masks one after
 * the other, or flip up on their baseline, when the headline scrolls into view. Made for the hero
 * title ("Launch your coin in one minute") and big section titles.
 */
export function SplitReveal({
  text,
  as: Tag = 'h2',
  split = 'chars',
  effect = 'rise',
  stagger,
  delay = 0,
  className,
}: SplitRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.3 });
  const shown = calm || entered;
  const step = stagger ?? (split === 'chars' ? 0.028 : 0.07);
  const masked = effect !== 'flip';

  const piece: Variants = {
    hidden:
      effect === 'flip'
        ? { opacity: 0, rotateX: -95, y: '0.15em' }
        : { y: effect === 'drop' ? '-110%' : '110%' },
    shown: (i: number) => ({
      opacity: 1,
      rotateX: 0,
      y: 0,
      transition: calm
        ? { duration: 0 }
        : effect === 'flip'
          ? { type: 'spring', bounce: 0.35, duration: 0.7, delay: delay + i * step }
          : { duration: 0.9, ease: EASE_OUT, delay: delay + i * step },
    }),
  };

  const words = text.split(/\s+/).filter(Boolean);
  let index = 0;

  return (
    <Tag
      ref={ref as never}
      className={cn('fx-split-reveal', className)}
      data-state={shown ? 'shown' : 'hidden'}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, w) => {
          const pieces = split === 'chars' ? Array.from(word) : [word];
          return (
            <span key={`${word}-${w}`}>
              <span
                className="inline-block whitespace-nowrap"
                style={effect === 'flip' ? { perspective: '600px' } : undefined}
              >
                {pieces.map((p, c) => {
                  const i = index++;
                  return (
                    <span
                      key={c}
                      className={cn('inline-block align-bottom', masked && 'overflow-hidden')}
                      // The mask keeps descenders: a little room below, taken back by the margin.
                      style={
                        masked ? { paddingBottom: '0.12em', marginBottom: '-0.12em' } : undefined
                      }
                    >
                      <motion.span
                        className="inline-block will-change-transform"
                        style={{ transformOrigin: '50% 100%' }}
                        custom={i}
                        variants={piece}
                        initial="hidden"
                        animate={shown ? 'shown' : 'hidden'}
                      >
                        {p}
                      </motion.span>
                    </span>
                  );
                })}
              </span>
              {w < words.length - 1 ? ' ' : null}
            </span>
          );
        })}
      </span>
    </Tag>
  );
}

export default SplitReveal;
